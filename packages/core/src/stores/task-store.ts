import { createStore } from 'zustand/vanilla';
import { DEFAULT_TASK_MODE, buildSessionKey, normalizeTaskModeSetting } from '@clawwork/shared';
import type { Task, TaskModeSetting, TaskStatus, IpcResult } from '@clawwork/shared';

/**
 * 点名要的助手**不在已加载的目录里**（2026-09-24）。
 *
 * 与"网关没连上"「助手没响应」是两回事，界面要分开措辞、各给自己的下一步。
 *
 * ⚠️ 判据刻意保守：`getAgentCatalog` 把「目录还没加载」与「目录为空」塌成同一个形状
 * `{agents: [], defaultId: null}`，store 里分不出这两者 ⇒ 只有 `agents.length > 0`
 * （确已加载）时才敢拒绝，否则「目录还没回来就发送」会被误伤。
 */
export class UnknownAgentError extends Error {
  readonly code = 'unknown-agent';

  constructor(readonly agentId: string) {
    super(`unknown agent: ${agentId}`);
    this.name = 'UnknownAgentError';
  }
}

export interface PendingNewTask {
  gatewayId: string;
  agentId: string;
  tags?: string[];
  /**
   * 任务模式（待发态用户选的档）。缺省 ⇒ 建任务时写入默认档（`DEFAULT_TASK_MODE`）。
   * 选了「高级：指定模型」才会是 `custom`（那时 `model` 才是决定性的）。
   */
  mode?: TaskModeSetting;
  model?: string;
  thinkingLevel?: string;
  ensemble?: boolean;
  teamId?: string;
}

export interface TaskState {
  tasks: Task[];
  activeTaskId: string | null;
  /** Changes synchronously on workspace reset, including reused task identities. */
  workspaceEpoch: number;
  hydrated: boolean;
  pendingNewTask: PendingNewTask | null;

  startNewTask: (opts?: Partial<PendingNewTask>) => void;
  commitPendingTask: () => Task;
  clearPending: () => void;
  updatePending: (patch: Partial<PendingNewTask>) => void;
  setPending: (task: PendingNewTask | null) => void;
  createTask: (opts?: {
    gatewayId?: string;
    agentId?: string;
    mode?: TaskModeSetting;
    model?: string;
    thinkingLevel?: string;
    ensemble?: boolean;
    teamId?: string;
    tags?: string[];
  }) => Task;
  /**
   * 切当前任务。
   *
   * ⚠️ 默认**顺带清 `pendingNewTask`**（防"从待发态点已有对话"的残留，2026-10-07 质量战役区 3）。
   *    复合动作（如 `useSelectAgent` 切助手——它自己专门管理 pending）传 `{ clearPending: false }` 保留。
   */
  setActiveTask: (id: string | null, options?: { clearPending?: boolean }) => void;
  /**
   * 置顶 / 取消置顶。
   *
   * ⚠️ **不碰 `updatedAt`**：置顶是"我要它一直在眼前"，不是"这个任务有活动"。
   * 顺手刷新更新时间的话，取消置顶的那一刻它会凭一个假的新鲜度插回列表最前面，
   * 用户会以为没取消掉。排序与"只显示 5 条"的裁剪见 renderer 的 `lib/task-sort`。
   */
  setTaskPinned: (id: string, pinned: boolean) => void;
  updateTaskTitle: (id: string, title: string) => void;
  updateTaskStatus: (id: string, status: TaskStatus) => void;
  updateTaskMetadata: (
    id: string,
    meta: {
      ensemble?: boolean;
      /** 任务模式（快速/智能/深度/高级指定模型）。见 `@clawwork/shared` 的 `task-modes.ts`。 */
      mode?: TaskModeSetting;
      model?: string;
      modelProvider?: string;
      thinkingLevel?: string;
      inputTokens?: number;
      outputTokens?: number;
      contextTokens?: number;
      teamId?: string | null;
      /**
       * 改任务的会话指针（多模型对比「采纳」后指到赢的那条会话上）。
       *
       * 为什么要它：网关侧一个会话 = 一份上下文，`chat.send` 只认 sessionKey。
       * 采纳后不改指针的话，下一句话仍发回**原来的**会话（里面没有用户刚采纳的那段问答），
       * 「采纳后新会话带上下文」就落空了。
       */
      sessionKey?: string;
      /**
       * deck 路由标记（演示文稿 → DeepSeek 的粘性开关）。写入时机与判据在
       * `renderer/lib/deck-intent.ts`；见 `Task.deckRouted`。
       */
      deckRouted?: boolean;
      updatedAt?: string;
    },
  ) => void;
  registerPersistedTasks: (tasks: Task[], activeTaskId?: string) => void;
  resetWorkspace: () => void;
  removeTask: (id: string) => Promise<void>;
  hydrate: () => Promise<void>;
  adoptTasks: (
    discovered: {
      taskId: string;
      sessionKey: string;
      title: string;
      updatedAt: string;
      gatewayId: string;
      agentId?: string;
      model?: string;
      modelProvider?: string;
      thinkingLevel?: string;
      inputTokens?: number;
      outputTokens?: number;
      contextTokens?: number;
    }[],
  ) => void;
}

export interface TaskStoreDeps {
  persistTask: (task: Task) => Promise<IpcResult>;
  persistTaskUpdate: (params: {
    id: string;
    title?: string;
    status?: string;
    ensemble?: boolean;
    mode?: string;
    model?: string;
    modelProvider?: string;
    thinkingLevel?: string;
    inputTokens?: number;
    outputTokens?: number;
    contextTokens?: number;
    teamId?: string | null;
    /** 见 `updateTaskMetadata` 的说明（采纳后改会话指针）。 */
    sessionKey?: string;
    /** 置顶时间（ISO）；`null` = 取消置顶。与 `updatedAt` 无关。 */
    pinnedAt?: string | null;
    /** deck 路由标记（演示文稿 → DeepSeek 的粘性开关）；见 `Task.deckRouted`。 */
    deckRouted?: boolean;
    updatedAt: string;
  }) => Promise<IpcResult>;
  deleteTask: (taskId: string) => Promise<IpcResult>;
  loadTasks: () => Promise<{
    ok: boolean;
    rows?: {
      id: string;
      sessionKey: string;
      sessionId: string;
      title: string;
      status: string;
      ensemble?: boolean | null;
      /** 任务模式；老数据是 NULL（读出来按 custom 语义处理，见 task-modes.ts）。 */
      mode?: string | null;
      model?: string | null;
      modelProvider?: string | null;
      thinkingLevel?: string | null;
      inputTokens?: number | null;
      outputTokens?: number | null;
      contextTokens?: number | null;
      teamId?: string | null;
      createdAt: string;
      updatedAt: string;
      tags: string[];
      artifactDir: string;
      gatewayId: string;
      /** 置顶时间（ISO）；SQLite 里没置顶是 NULL。 */
      pinnedAt?: string | null;
      /** deck 路由标记（SQLite 0/1；老行 = 0 ⇒ false）。见 `Task.deckRouted`。 */
      deckRouted?: boolean | null;
    }[];
  }>;
  patchSession: (gatewayId: string, sessionKey: string, patch: Record<string, unknown>) => Promise<IpcResult>;
  getDeviceId: () => Promise<string>;
  getDefaultGatewayId: () => string | null;
  /**
   * 网关的助手目录；**没加载到就返回 `undefined`**（不是"空目录"）。
   *
   * ⚠️ 这两者**必须**分得开（2026-09-24 独立复核 I-2）：渲染层的判据把"条目存在但为空"
   * 当成"已加载 ⇒ 请求的助手不在本机"，而 store 这边原来拿到的形状把两者塌成同一个
   * `{agents: [], defaultId: null}`，于是**同一个状态两边给出相反结论**，fail-closed
   * 在那条窄路上漏着。返回 `undefined` 之后，拒绝判据可以写成精确版（见 `commitPendingTask`）。
   */
  getAgentCatalog: (gatewayId: string) => { agents: { id: string }[]; defaultId: string | null } | undefined;
  onTaskCreated?: () => void;
  /**
   * 任务删除成功后，把该任务的消息从消息 store 里清掉（2026-10-07 · 区 3 问题 10）。
   *
   * ⚠️ 可选注入（core 不直接依赖另一张 store 的实例）：宿主把 `messageStore.clearMessages`
   *    接进来。缺了它只影响"删除后消息内存残留"，不影响删除本身。
   */
  clearTaskMessages?: (taskId: string) => void;
}

export function createTaskStore(deps: TaskStoreDeps) {
  let cachedDeviceId: string | null = null;
  let workspaceGeneration = 0;

  return createStore<TaskState>((set, get) => ({
    tasks: [],
    activeTaskId: null,
    hydrated: false,
    workspaceEpoch: 0,
    pendingNewTask: null,

    startNewTask: (opts?) => {
      const resolvedGatewayId = opts?.gatewayId ?? deps.getDefaultGatewayId() ?? '';
      const catalog = deps.getAgentCatalog(resolvedGatewayId);
      const resolvedAgentId = opts?.agentId || catalog?.defaultId || '';
      set({
        activeTaskId: null,
        pendingNewTask: { ...opts, gatewayId: resolvedGatewayId, agentId: resolvedAgentId },
      });
      deps.onTaskCreated?.();
    },

    commitPendingTask: () => {
      const pending = get().pendingNewTask;
      const gwId = pending?.gatewayId ?? deps.getDefaultGatewayId() ?? '';
      const catalog = deps.getAgentCatalog(gwId);
      const agId = pending?.agentId || catalog?.defaultId;
      if (!agId) throw new Error('no agent available — gateway catalog not loaded');
      // ⭐ 点名要的助手不在**已加载**的目录里 ⇒ 拒绝建任务（fail closed）。
      //    界面上「拒绝并说明」之后，发送侧不能还留着一个能走到幽灵助手的口子。
      //    ⚠️ `catalog` 为 `undefined`（**没加载**）时**不拒** —— 否则"目录还没回来就发送"
      //    会被误伤；只有"确已加载"才敢下判断（`undefined` 与"空"是两个状态，见 dep 的注释）。
      const requestedAgentId = pending?.agentId ?? '';
      if (requestedAgentId && catalog && !catalog.agents.some((agent) => agent.id === requestedAgentId)) {
        throw new UnknownAgentError(requestedAgentId);
      }
      const task = get().createTask({
        gatewayId: gwId,
        agentId: agId,
        mode: pending?.mode,
        model: pending?.model,
        thinkingLevel: pending?.thinkingLevel,
        ensemble: pending?.ensemble,
        teamId: pending?.teamId,
        tags: pending?.tags,
      });
      set({ pendingNewTask: null });
      return task;
    },

    clearPending: () => set({ pendingNewTask: null }),

    updatePending: (patch) => {
      const current = get().pendingNewTask;
      if (!current) return;
      set({ pendingNewTask: { ...current, ...patch } });
    },

    setPending: (task) => {
      set({ pendingNewTask: task });
    },

    createTask: (opts) => {
      const resolvedGatewayId = opts?.gatewayId ?? deps.getDefaultGatewayId() ?? '';
      const catalog = deps.getAgentCatalog(resolvedGatewayId);
      const resolvedAgentId = opts?.agentId || catalog?.defaultId;
      if (!resolvedAgentId) throw new Error('no agent available — gateway catalog not loaded');
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const task: Task = {
        id,
        sessionKey: buildSessionKey(id, resolvedAgentId, cachedDeviceId ?? undefined),
        sessionId: '',
        title: '',
        status: 'active',
        ensemble: opts?.teamId ? false : (opts?.ensemble ?? undefined),
        createdAt: now,
        updatedAt: now,
        tags: [...(opts?.tags ?? [])],
        artifactDir: '',
        gatewayId: resolvedGatewayId,
        agentId: resolvedAgentId,
        // ⭐ 任务模式在**建任务这一刻**就定死默认档：不靠发送路径兜底，旧行（mode 为空）
        //    才不会被后来的"默认智能"悄悄劫持（两者的区别全靠这一行撑着）。
        mode: opts?.mode ?? DEFAULT_TASK_MODE,
        model: opts?.model,
        thinkingLevel: opts?.thinkingLevel,
        teamId: opts?.teamId,
      };
      set((s) => ({ tasks: [task, ...s.tasks], activeTaskId: id }));
      deps.persistTask(task).catch((err) => {
        console.error('[persist:task]', err);
      });
      return task;
    },

    /**
     * 显式切换当前任务（打开一段已有对话 / 回到欢迎屏）。
     *
     * ⭐ 2026-10-07（质量战役区 3 · 问题 5）：**顺带清掉 `pendingNewTask`**。
     * 原实现只改 `activeTaskId`：用户在待发态（新建对话但还没发第一条）点了列表里
     * 一段已有对话后，`pendingNewTask` 一直挂着，切回欢迎屏还会"复活"上次的待发配置。
     * ⚠️ 不受影响的路径：`commitPendingTask`（发送把待发变真任务）**不经过这里**，
     * 它自己 `set({ tasks, activeTaskId })`；`startNewTask` 同样直接 set（设待发态本身）。
     */
    setActiveTask: (id, options) =>
      set({ activeTaskId: id, ...(options?.clearPending === false ? {} : { pendingNewTask: null }) }),

    setTaskPinned: (id, pinned) => {
      const task = get().tasks.find((t) => t.id === id);
      if (!task) return;

      const pinnedAt = pinned ? new Date().toISOString() : undefined;
      set((s) => ({
        tasks: s.tasks.map((t) => (t.id === id ? { ...t, pinnedAt } : t)),
      }));
      // ⚠️ 带的是**原来的** updatedAt：这一步只改置顶，不该制造"刚刚活动过"的假象。
      // 取消置顶要写 `null`（不是 undefined）—— 否则 IPC 那侧 `!== undefined`
      // 判不出来，库里那行会留着旧值，重启后置顶"复活"。
      deps.persistTaskUpdate({ id, pinnedAt: pinnedAt ?? null, updatedAt: task.updatedAt }).catch((err) => {
        console.error('[persist:task]', err);
      });
    },

    updateTaskTitle: (id, title) => {
      const now = new Date().toISOString();
      const task = get().tasks.find((t) => t.id === id);
      set((s) => ({
        tasks: s.tasks.map((t) => (t.id === id ? { ...t, title, updatedAt: now } : t)),
      }));
      deps.persistTaskUpdate({ id, title, updatedAt: now }).catch((err) => {
        console.error('[persist:task]', err);
      });
      if (task?.gatewayId && task?.sessionKey) {
        deps.patchSession(task.gatewayId, task.sessionKey, { label: title }).catch((err) => {
          console.error('[patch:session]', err);
        });
      }
    },

    updateTaskStatus: (id, status) => {
      const now = new Date().toISOString();
      set((s) => ({
        tasks: s.tasks.map((t) => (t.id === id ? { ...t, status, updatedAt: now } : t)),
      }));
      deps.persistTaskUpdate({ id, status, updatedAt: now }).catch((err) => {
        console.error('[persist:task]', err);
      });
    },

    updateTaskMetadata: (id, meta) => {
      const updatedAt = meta.updatedAt ?? new Date().toISOString();
      set((s) => ({
        tasks: s.tasks.map((t) =>
          t.id === id
            ? { ...t, ...meta, teamId: meta.teamId === null ? undefined : (meta.teamId ?? t.teamId), updatedAt }
            : t,
        ),
      }));
      deps
        .persistTaskUpdate({
          id,
          ensemble: meta.ensemble,
          mode: meta.mode,
          model: meta.model,
          modelProvider: meta.modelProvider,
          thinkingLevel: meta.thinkingLevel,
          inputTokens: meta.inputTokens,
          outputTokens: meta.outputTokens,
          contextTokens: meta.contextTokens,
          teamId: meta.teamId,
          sessionKey: meta.sessionKey,
          deckRouted: meta.deckRouted,
          updatedAt,
        })
        .catch((err) => {
          console.error('[persist:task]', err);
        });
    },

    registerPersistedTasks: (tasks, activeTaskId) => {
      const ids = new Set(tasks.map((task) => task.id));
      if (ids.size !== tasks.length || (activeTaskId && !ids.has(activeTaskId)))
        throw new Error('Invalid persisted task registration');
      for (const task of tasks) {
        const existing = get().tasks.find((item) => item.id === task.id);
        if (existing && (existing.sessionKey !== task.sessionKey || existing.gatewayId !== task.gatewayId))
          throw new Error('Persisted task ownership mismatch');
      }
      set((state) => ({
        tasks: [...tasks, ...state.tasks.filter((task) => !ids.has(task.id))],
        ...(activeTaskId ? { activeTaskId, pendingNewTask: null } : {}),
      }));
    },

    resetWorkspace: () => {
      workspaceGeneration++;
      cachedDeviceId = null;
      set({
        tasks: [],
        activeTaskId: null,
        hydrated: false,
        pendingNewTask: null,
        workspaceEpoch: workspaceGeneration,
      });
    },
    removeTask: async (id) => {
      const generation = workspaceGeneration;
      const task = get().tasks.find((task) => task.id === id);
      const result = await deps.deleteTask(id);
      if (!result.ok) throw new Error(result.error || 'Task deletion failed');
      const current = get().tasks.find((item) => item.id === id);
      if (
        generation !== workspaceGeneration ||
        current?.sessionKey !== task?.sessionKey ||
        current?.gatewayId !== task?.gatewayId
      )
        throw new Error('Task changed during deletion');
      set((s) => {
        const nextActiveId = s.activeTaskId === id ? null : s.activeTaskId;
        return {
          tasks: s.tasks.filter((t) => t.id !== id),
          activeTaskId: nextActiveId,
        };
      });
      // ⭐ 2026-10-07（质量战役区 3 · 问题 10）：任务删掉了，它的消息不该继续挂在内存里。
      //    store 层**自我了结**（不再只依赖 UI 那条路记得清 `clearMessages` —— 那是
      //    `delete-task.ts` 里的一个调用点义务，任何别的 removeTask 调用方都会漏）。
      //    幂等：UI 那条路重复清一次无副作用。
      deps.clearTaskMessages?.(id);
    },

    hydrate: async () => {
      if (get().hydrated) return;
      const generation = workspaceGeneration;
      try {
        const deviceId = await deps.getDeviceId();
        if (generation !== workspaceGeneration) return;
        cachedDeviceId = deviceId;
        const res = await deps.loadTasks();
        if (generation !== workspaceGeneration) return;
        if (res.ok && res.rows) {
          set({
            tasks: res.rows.map((r) => ({
              id: r.id,
              sessionKey: r.sessionKey,
              sessionId: r.sessionId,
              title: r.title,
              status: r.status as TaskStatus,
              ensemble: r.teamId ? false : (r.ensemble ?? undefined),
              // ⚠️ 旧行（NULL / 脏值）= **没有偏好**：归一成 `undefined` 交给
              //    `resolveEffectiveTaskMode` 按 custom 处理，**不在这里补默认档**
              //    （补了 = 劫持用户当年显式选过的 model，见 task-modes.ts 的"存量保护"）。
              mode: normalizeTaskModeSetting(r.mode),
              model: r.model ?? undefined,
              modelProvider: r.modelProvider ?? undefined,
              thinkingLevel: r.thinkingLevel ?? undefined,
              inputTokens: r.inputTokens ?? undefined,
              outputTokens: r.outputTokens ?? undefined,
              contextTokens: r.contextTokens ?? undefined,
              teamId: r.teamId ?? undefined,
              createdAt: r.createdAt,
              updatedAt: r.updatedAt,
              tags: r.tags,
              artifactDir: r.artifactDir,
              gatewayId: r.gatewayId,
              // ⚠️ 这一行漏了置顶就"重启失效"（写库那侧照常通）。这种"加一列"的功能
              //    最典型的暗坑就是读回来没带上，用户看到的是功能根本不管用。
              pinnedAt: r.pinnedAt ?? undefined,
              // ⚠️ 同一个暗坑：deck 路由标记漏读 ⇒ 重启后改稿又跑回模式模型。
              //    `false` / NULL 都归一成 `undefined`（= "没标记过"）。
              deckRouted: r.deckRouted ? true : undefined,
            })),
            hydrated: true,
          });
        }
      } catch (err) {
        console.warn('[taskStore] hydrate failed:', err);
      }
    },

    adoptTasks: (discovered) => {
      const toPersist: Task[] = [];
      set((s) => {
        const existing = new Set(s.tasks.map((t) => t.id));
        const newTasks: Task[] = [];
        for (const d of discovered) {
          if (existing.has(d.taskId)) continue;
          const task: Task = {
            id: d.taskId,
            sessionKey: d.sessionKey,
            sessionId: '',
            title: d.title,
            status: 'active',
            createdAt: d.updatedAt,
            updatedAt: d.updatedAt,
            tags: [],
            artifactDir: '',
            gatewayId: d.gatewayId,
            agentId: d.agentId,
            model: d.model,
            modelProvider: d.modelProvider,
            thinkingLevel: d.thinkingLevel,
            inputTokens: d.inputTokens,
            outputTokens: d.outputTokens,
            contextTokens: d.contextTokens,
          };
          newTasks.push(task);
        }
        if (newTasks.length === 0) return s;
        toPersist.push(...newTasks);
        return { tasks: [...newTasks, ...s.tasks] };
      });
      for (const task of toPersist) {
        deps.persistTask(task).catch((err) => {
          console.error('[persist:task]', err);
        });
      }
    },
  }));
}
