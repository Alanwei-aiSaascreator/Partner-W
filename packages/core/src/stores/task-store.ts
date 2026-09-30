import { createStore } from 'zustand/vanilla';
import { buildSessionKey } from '@clawwork/shared';
import type { Task, TaskStatus, IpcResult } from '@clawwork/shared';

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
    model?: string;
    thinkingLevel?: string;
    ensemble?: boolean;
    teamId?: string;
    tags?: string[];
  }) => Task;
  setActiveTask: (id: string | null) => void;
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

    setActiveTask: (id) => set({ activeTaskId: id }),

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
          model: meta.model,
          modelProvider: meta.modelProvider,
          thinkingLevel: meta.thinkingLevel,
          inputTokens: meta.inputTokens,
          outputTokens: meta.outputTokens,
          contextTokens: meta.contextTokens,
          teamId: meta.teamId,
          sessionKey: meta.sessionKey,
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
