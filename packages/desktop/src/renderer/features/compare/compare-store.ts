/**
 * 多模型并排对比的**编排状态机**。
 *
 * 它只做四件事，每件事都能用假依赖单测（不碰 React、不碰真网关）：
 *   ① `start`    —— 同一句话**并发**发给 N 个模型（N ∈ [2,4]），各自一条会话
 *   ② `retry`    —— 只重发挂了的那一列
 *   ③ `adopt`    —— 把某一列的答案落成这个任务的 assistant 消息，并把会话指针指过去
 *   ④ `dismiss`  —— 取消这一轮，尽力清掉那几条临时会话
 *
 * ## 三条不可动摇的约束
 *
 * **并发**：N 路之间**没有任何 await 串联** —— 每路自己走「建会话 → 设模型 → 发消息」，
 * 任何一路失败只影响它自己，其它路照跑。（`start` 里刻意不 `await` 每一路：
 * for-await 会让第 2 路等第 1 路的往返，4 路就串成 4 个来回。）
 *
 * **计费**：这里**不碰任何计费代码** —— 每路的钱由网关/中转按各自那次 `chat.send`
 * 独立结算，客户端不合并、不去重、不代重试。所以「N 个模型 = N 份钱」天然成立。
 *
 * **失败隔离**：失败状态存在**列**上（`column.status = 'error'` + `column.error`），
 * 不存在"整轮对比失败"这种聚合状态 —— 一聚合就会把"某一路挂了"渲染成"整次对比挂了"。
 */
import { createStore } from 'zustand/vanilla';
import type { IpcResult } from '@clawwork/shared';
import {
  buildAppError,
  formatErrorForUser,
  normalizeAssistantTurns,
  type MessageState,
  type RawHistoryMessage,
} from '@clawwork/core';
import {
  buildComparePlan,
  validateCompareModels,
  MIN_COMPARE_MODELS,
  type ComparePlanError,
  type CompareRuntime,
} from './compare-plan';

/**
 * 一列「发出去之后**毫无动静**」的兜底时长。
 *
 * 数字与 `packages/core/src/services/chat-composer.ts` 的 `SEND_TIMEOUT_MS` 一致，
 * 但**判据并不一样**，别把两处当成同一件事：
 *   - 单模型那条路是**取消式**的 —— 网关那边一有动静，dispatcher 会走
 *     `notifyAgentResponse`，composer 顺手把定时器整条清掉（它对"有动静"的定义
 *     由事件流给出）；
 *   - 对比列是**到期检查式**的 —— 这几列是临时会话，dispatcher 对它们**不**发
 *     `notifyAgentResponse`（那是给普通会话的未读/通知闸），所以定时器只能等到期那一刻
 *     回头看 `messageStore` 里的状态。于是"什么算有动静"必须在**这里**逐个列清楚：
 *     `activeTurn`（已经出字/出工具调用）、`errorBySession`（已经失败）、以及
 *     `processingBySession`（网关已经接单：`lifecycle.start` 到了、或 chat 通道的
 *     `delta` 已到）。
 *     ⚠️ 少了最后那一条就会误报：冷启动实测网关要 **37–74 秒**才开始出字，而
 *     `lifecycle.start` 早就把 `processing` 立起来了（见 gateway-dispatcher 的
 *     `handleAgentLifecycleStream`）—— 只看前两条的话，用户看到的是"明明正在流式，
 *     30 秒后集体报「助手没有响应」"，然后点「重试」= 同一句话再花一次钱。
 *
 * 注意它只判**毫无动静**，不是"总时长"：长回答、多轮工具调用可以跑好几分钟，
 * 那都是正常的，不能被这里打断。
 */
const COMPARE_SEND_TIMEOUT_MS = 30_000;

export interface CompareStoreDeps {
  createSession: (gatewayId: string, params: { key: string; agentId: string }) => Promise<IpcResult>;
  patchSession: (gatewayId: string, sessionKey: string, patch: Record<string, unknown>) => Promise<IpcResult>;
  sendMessage: (gatewayId: string, sessionKey: string, content: string, attachments?: unknown[]) => Promise<IpcResult>;
  abortChat: (gatewayId: string, sessionKey: string) => Promise<IpcResult>;
  deleteSession: (gatewayId: string, sessionKey: string) => Promise<IpcResult>;
  chatHistory: (gatewayId: string, sessionKey: string) => Promise<IpcResult>;
  getMessageStore: () => Pick<
    MessageState,
    | 'activeTurnBySession'
    | 'adoptActiveTurn'
    | 'setSessionError'
    | 'clearActiveTurn'
    | 'addMessage'
    | 'errorBySession'
    // 30 秒兜底要判"网关到底有没有接单"（见 COMPARE_SEND_TIMEOUT_MS 那段）。
    | 'processingBySession'
  >;
  getTaskStore: () => {
    tasks: { id: string; sessionKey: string; gatewayId: string; agentId?: string; title: string }[];
    updateTaskMetadata: (id: string, meta: { sessionKey?: string }) => void;
  };
  translate: (key: string, opts?: Record<string, unknown>) => string;
  onToast?: (type: 'error' | 'warning' | 'success', title: string, opts?: { description?: string }) => void;
  /** 便于测试注入；生产不传。 */
  now?: () => number;
  newId?: () => string;
}

export interface CompareState {
  /** 正在进行/刚结束的一轮对比（`null` = 界面回到普通对话）。 */
  active: CompareRuntime | null;
  /** 对比模式开关（composer 上那个「对比」）。关掉不影响已经跑起来的一轮。 */
  mode: boolean;
  /** 勾选的模型（保序；数量上下限由 compare-plan 把关）。 */
  draftModels: string[];
  /**
   * 「本轮对比的选择**已经初始化过**」。
   *
   * 为什么要单独一个标记：默认勾选只是**第一次**进入对比模式时帮用户填两格，
   * 之后用户清空是**用户的决定**，不能被下一帧的回填撤销。判据若是"现在是不是空的"
   *（`draftModels.length > 0`），用户删光 → 界面重渲染 → 判据成立 → 又填回去，永远清不干净。
   * 见 `seedDraftModels` / `setMode`。
   */
  draftSeeded: boolean;
  /**
   * 正在采纳的那一列（`null` = 没有采纳在飞）。**单飞锁**。
   *
   * 采纳的同步部分只"检查"不改状态（要走一次 `chat.history` 探针），探针回来之前按钮
   * 还是可点的：第二次点会走到"探针回来时那一轮已经没了"的收尾分支，把**刚指过去的
   * 赢家会话** abort + 删掉，任务指针随即指向一条不存在的会话。所以点下去就先占位。
   * 界面据此禁用所有列的「采纳」按钮。失败（探针回来发现没得采纳 / 用户取消）会释放。
   */
  adoptingKey: string | null;
  /**
   * **临时会话**登记表 —— dispatcher / session-sync 靠它区分"这一列的回答该不该进对话"。
   *
   * 为什么不直接读 `active.columns`：退出/采纳之后事件还会飞一会儿（abort 回执、
   * 迟到的 final）。那时 `active` 已经清空，判据若跟着变成"不是临时会话"，
   * 这些迟到事件就会以**普通回复**的身份写进时间线 —— 用户会看到自己刚取消掉的那一列
   * 的答案出现在对话里。所以登记表要**活到那几条会话真的被删掉**（或采纳的赢家转正）为止。
   */
  ephemeralKeys: Set<string>;
  /**
   * 「这几条临时会话是**用户主动中断**的」标记，按会话键存。
   *
   * 为什么要它：dispatcher 判「aborted 事件算不算用户取消」用的是**任务级**的
   * `abortedByUser`（`chat-composer` 在用户点停止时打的那个）；对比的列是**临时会话**，
   * 走的是 `compare-store` 自己的 abort 动作，永远打不到那个任务级标记上。于是一次
   * 正常的「取消对比 / 采纳后收拾败者」之后，迟到的 `aborted` 帧会被判成"服务器主动中断"，
   * 以 system 消息的身份写进时间线、还顺手标未读 + 弹通知。
   *
   * ⚠️ 必须**同步**打标（在任何 abort 请求发出去之前），不能等清理流程走完 ——
   * 登记表是在 `deleteSession` 成功那一刻摘键的，aborted 帧可能比标记先到。
   * ⚠️ 这是**标记**不是引用计数：摘键之后不再有机会判断"这条会话还活着吗"，
   * 所以只加不减（每条会话键几十字节，一轮几条，不回收）。
   */
  abortedKeys: Set<string>;
  error: ComparePlanError | null;

  setMode: (on: boolean) => void;
  setDraftModels: (models: string[]) => void;
  /**
   * 用模型目录**回填**默认勾选 —— 只在"本会话还没初始化过"时生效（见 `draftSeeded`）。
   * 目录还没热（不足 2 个可用模型）时不动状态，等目录到了再调一次。
   */
  seedDraftModels: (models: string[]) => void;
  /** 同一句话并发问 N 个模型。返回这一轮的 compareId（没发起来返回 null）。 */
  start: (params: {
    taskId: string;
    gatewayId: string;
    agentId: string;
    prompt: string;
    attachments?: unknown[];
  }) => string | null;
  /** 只重试挂了的那一列。 */
  retry: (sessionKey: string) => void;
  /** 取消整轮（尽力 abort + 删会话）。 */
  dismiss: () => void;
  /** 采纳某一列：落库 + 把任务会话指针指过去 + 收拾其余列。 */
  adopt: (sessionKey: string) => void;
  /** dispatcher / session-sync 的 `isEphemeralSession` 直接调它。 */
  isEphemeral: (sessionKey: string) => boolean;
  /**
   * dispatcher 的 `isSessionAbortedByUser` 直接调它 —— 这条临时会话是不是用户主动中断的。
   * 与 `isEphemeral` 同一个方向（host 层读 store，store 不认识 dispatcher），
   * 避免 dispatcher ↔ compare-store 互相 import 成环。
   */
  wasAbortedByUser: (sessionKey: string) => boolean;
}

export function createCompareStore(deps: CompareStoreDeps) {
  const now = deps.now ?? (() => Date.now());
  const newId = deps.newId ?? (() => crypto.randomUUID());

  /** 每列的兜底超时。键是会话键。 */
  const timeouts = new Map<string, ReturnType<typeof setTimeout>>();

  function clearTimerFor(sessionKey: string): void {
    const t = timeouts.get(sessionKey);
    if (t) {
      clearTimeout(t);
      timeouts.delete(sessionKey);
    }
  }

  /**
   * 尽力关掉那几条临时会话：abort 掉在跑的，再删掉（删了才不会再产生事件）。
   *
   * 回调的语义是「**这几条可以摘键了**」，不是"网关侧真的删干净了"。区别在于
   * `gatewayId` 为空这一种情况（任务刚建、网关还没上报 id）：以前这里直接 `onRemoved([])`
   * 就返回，登记表里的键**永远没人摘** —— 那几条会话键从此一直"是临时会话"，
   * dispatcher / session-sync 再也不会认它们（会话变成黑洞）。现在无论如何都摘。
   */
  async function cleanupSessions(
    gatewayId: string,
    sessionKeys: string[],
    onRemoved?: (removed: string[]) => void,
  ): Promise<void> {
    if (sessionKeys.length === 0) {
      onRemoved?.([]);
      return;
    }
    if (!gatewayId) {
      onRemoved?.(sessionKeys);
      return;
    }
    const removed: string[] = [];
    await Promise.all(
      sessionKeys.map(async (key) => {
        try {
          await deps.abortChat(gatewayId, key);
        } catch {
          /* 没在跑就不用 abort */
        }
        try {
          const res = await deps.deleteSession(gatewayId, key);
          // 删成功（或**已经不存在**，等价于删掉了）才摘键。删失败就留着 ——
          // 登记表里还有它，迟到的事件也不会污染对话。
          if (res.ok) removed.push(key);
        } catch {
          /* 同上 */
        }
      }),
    );
    onRemoved?.(removed);
  }

  /**
   * 追问网关「这条会话最后一轮回复是谁生成的、什么时候」。
   *
   * 为什么要探这一下：assistant 消息的 `model` **唯一合法来源**是网关历史
   *（实时 final 帧不带 model，见 `Message.model` 的注释），而时间戳对齐能让后面
   * `doSyncSession` 的去重键 `${sessionKey}|${timestamp}` 直接命中，避免采纳进来的
   * 那条被当成"网关新回复"再往时间线里写一遍。
   *
   * ⚠️ 这里**必须和 session-sync 走同一个归一化函数**（`normalizeAssistantTurns`），
   * 别再手写遍历取字段。曾经的写法是手抄一份判据：
   * `timestamp: typeof m.timestamp === 'string' ? ... : undefined`，
   * 而网关 `chat.history` 的 `timestamp` 是 **epoch 毫秒（number）** —— 于是判据把它当"没有"，
   * 时间戳被静默丢掉、采纳的消息落的是本地时间，去重键和 session-sync 认的那份永远对不上
   *（同一段答案被 promote 第二遍）。这里要的本来就是"网关历史里最后那一轮"，
   * 与 `doSyncSession` 看到的是同一个函数的同一个结果，键自然对齐。
   *
   * 探不到就**空手回来**（不猜）：宁可徽章不显示、时间戳用本地值，
   * 也不拿列的配置模型冒充"实际生成它的模型"。
   */
  async function probeAdoptedMeta(
    gatewayId: string,
    sessionKey: string,
  ): Promise<{ model?: string; timestamp?: string }> {
    try {
      const res = await deps.chatHistory(gatewayId, sessionKey);
      if (!res.ok || !res.result) return {};
      const messages = (res.result as { messages?: RawHistoryMessage[] }).messages;
      if (!Array.isArray(messages)) return {};
      // 归一化后取**最后一轮**：时间戳已经过 `toISOTimestamp`（与 sync 同一个函数）。
      const last = normalizeAssistantTurns(messages).at(-1);
      if (!last) return {};
      return { model: last.model, timestamp: last.timestamp };
    } catch {
      return {};
    }
  }

  return createStore<CompareState>((set, get) => {
    /**
     * 把一路的失败写到**那一列自己的错误通道**上（`errorBySession`，按会话键索引）。
     *
     * 为什么不用对比自己的 state：错误要能同时承接两种来源 —— 这里是「发都发不出去」
     *（建会话/钉模型/发送失败），dispatcher 那边是「发出去之后上游报错」。
     * 两条路写同一处，界面就只有一个判据；分开写迟早会出现"某一列显示的是上一轮的错"。
     */
    function markError(sessionKey: string, message: string): void {
      clearTimerFor(sessionKey);
      deps.getMessageStore().setSessionError(sessionKey, message);
    }

    function dropEphemeral(keys: string[]): void {
      if (keys.length === 0) return;
      set((s) => {
        const ephemeralKeys = new Set(s.ephemeralKeys);
        for (const key of keys) ephemeralKeys.delete(key);
        return { ephemeralKeys };
      });
    }

    /** 打「用户主动中断」标记。**同步**，必须在任何 abort 请求之前调（见 `abortedKeys`）。 */
    function markAbortedByUser(keys: string[]): void {
      if (keys.length === 0) return;
      set((s) => {
        const abortedKeys = new Set(s.abortedKeys);
        for (const key of keys) abortedKeys.add(key);
        return { abortedKeys };
      });
    }

    /**
     * 清掉这几条临时会话**列上的界面状态**（错误旁路 + 半截正文）。
     *
     * 这两处都是"本轮的界面状态"不是对话数据 —— 一轮结束时不清，下一次渲染（或下一轮
     * 恰好读到同一个键）会看到上一轮的残影：一列明明刚跑起来，却顶着一句上一轮的错误。
     */
    function resetColumnUi(keys: string[]): void {
      const messageStore = deps.getMessageStore();
      for (const key of keys) {
        messageStore.setSessionError(key, null);
        messageStore.clearActiveTurn(key);
      }
    }

    /**
     * 收掉一轮：清计时器、清每列界面状态、打中断标记、清 `active`、尽力删网关侧会话。
     *
     * `releaseAdopt: false` 用于「用户没取消、只是又发起了一轮」：那时不该把正在飞的
     * 采纳一并丢掉 —— 它会自己按 `compareId` 判断还能不能动 `active`（见 `adopt`）。
     */
    function dismissRound(runtime: CompareRuntime, opts?: { releaseAdopt?: boolean }): void {
      for (const column of runtime.columns) clearTimerFor(column.sessionKey);

      const task = deps.getTaskStore().tasks.find((t) => t.id === runtime.taskId);
      const gatewayId = task?.gatewayId ?? '';
      const keys = runtime.columns.map((c) => c.sessionKey);

      resetColumnUi(keys);
      markAbortedByUser(keys);

      // 先关界面（点完就不该再看到那几列），再尽力清理网关侧；清理失败只留着登记表，
      // 不让它挡住"退出对比"这个动作。
      set((s) => ({
        active: s.active?.compareId === runtime.compareId ? null : s.active,
        adoptingKey: opts?.releaseAdopt === false ? s.adoptingKey : null,
      }));
      void cleanupSessions(gatewayId, keys, dropEphemeral);
    }

    /** 一路的完整动作：建会话 → 钉模型 → 发消息。任何一步失败只标记这一列。 */
    async function runColumn(params: {
      gatewayId: string;
      agentId: string;
      sessionKey: string;
      model: string;
      prompt: string;
      attachments?: unknown[];
    }): Promise<void> {
      const { gatewayId, sessionKey, model } = params;
      try {
        // 会话已存在（重试这条路）会报已存在 —— 那不是失败，接着钉模型/发消息即可。
        await deps.createSession(gatewayId, { key: sessionKey, agentId: params.agentId });

        // 模型是**会话级**的：`chat.send` 不带模型，所以必须在发之前把这条会话的模型钉死。
        // 不钉的话 N 路跑的是同一个默认模型 —— 用户看到的"对比"其实是同一个答案的 N 份复读。
        const patched = await deps.patchSession(gatewayId, sessionKey, { model });
        if (!patched.ok) {
          markError(sessionKey, deps.translate('compare.columnModelFailed', { model }));
          return;
        }

        const sent = await deps.sendMessage(gatewayId, sessionKey, params.prompt, params.attachments);
        if (!sent.ok) {
          // 上游失败（额度不足 / 模型下架 / 网络）**只写这一列**：其它列还在正常出字。
          markError(sessionKey, sent.error || deps.translate('compare.columnModelFailed', { model }));
          return;
        }

        // 正文/收尾由 dispatcher 的流式事件驱动（按会话键分发），本 store 不解析事件，
        // 只挂一个兜底：网关彻底没声音时不能让那一列永远转圈。
        clearTimerFor(sessionKey);
        timeouts.set(
          sessionKey,
          setTimeout(() => {
            // 这个回调只跑一次，先把自己从表里摘掉：留着那条记录（键 → 早已跑完的 handle）
            // 只会占内存，并让后来人以为这列还有兜底在等。
            timeouts.delete(sessionKey);
            if (!get().active?.columns.some((c) => c.sessionKey === sessionKey)) return;
            const store = deps.getMessageStore();
            // 有动静就不打扰。三个判据都要看（少一个就会误报，见 COMPARE_SEND_TIMEOUT_MS 那段）：
            //   activeTurn      —— 已经出字/出了工具调用；
            //   errorBySession  —— 这一列已经失败过，别再叠一条"没有响应"；
            //   processing      —— 网关**已接单**（lifecycle.start 把它立起来；冷启动实测
            //                      要过 37–74 秒才见第一个字，这期间它是唯一为真的信号）。
            if (
              store.activeTurnBySession[sessionKey] ||
              store.errorBySession[sessionKey] ||
              store.processingBySession.has(sessionKey)
            )
              return;
            markError(
              sessionKey,
              formatErrorForUser(
                buildAppError({
                  source: 'gateway',
                  stage: 'lifecycle',
                  rawMessage: deps.translate('errors.agentNotResponding'),
                }),
                deps.translate,
              ),
            );
          }, COMPARE_SEND_TIMEOUT_MS),
        );
      } catch (err) {
        markError(sessionKey, err instanceof Error ? err.message : String(err));
      }
    }

    return {
      active: null,
      mode: false,
      draftModels: [],
      draftSeeded: false,
      adoptingKey: null,
      ephemeralKeys: new Set<string>(),
      abortedKeys: new Set<string>(),
      error: null,

      // 关掉对比模式顺手把「本会话已初始化」的标记清掉：下次再打开时，如果选择已经被
      // 清空，默认那两个模型应该重新回来（那是"重新开始"，不是"撤销用户的删除"）。
      setMode: (on) => set({ mode: on, draftSeeded: on ? get().draftSeeded : false }),
      // 用户自己勾的/取消的模型：这就是他的决定 ⇒ 直接置位标记，后面的回填不再覆盖它。
      setDraftModels: (models) => set({ draftModels: models, error: null, draftSeeded: true }),

      seedDraftModels: (models) => {
        const state = get();
        // 判据是「**本会话初始化过没有**」，不是"现在是不是空的"。
        // 后者会在用户删光之后被下一帧回填（用户："我明明清掉了，它自己又回来了"）。
        if (state.draftSeeded) return;
        // 已经选着东西（模式开关切来切去时）⇒ 尊重现选择，只补个标记。
        if (state.draftModels.length > 0) {
          set({ draftSeeded: true });
          return;
        }
        const usable = models
          .filter((m): m is string => typeof m === 'string' && m.trim().length > 0)
          .slice(0, MIN_COMPARE_MODELS);
        // 目录还没热（不足两个可用模型）⇒ 什么都不做、也**不置位**：等目录到了会再调一次。
        if (usable.length < MIN_COMPARE_MODELS) return;
        set({ draftModels: usable, draftSeeded: true, error: null });
      },

      start: (params) => {
        const { taskId, gatewayId, agentId, prompt } = params;
        const invalid = validateCompareModels(get().draftModels);
        if (invalid) {
          set({ error: invalid });
          return null;
        }
        if (!prompt.trim()) return null;

        // 上一轮还在（用户跑到**别的任务**里又发起了一轮）：界面只有一组列，
        // 这一轮必须顶掉上一轮 —— 不收拾的话上一轮那几条会话键会永远留在登记表里
        //（谁也不会再删它们），而 `active` 已经被覆盖，等于凭空漏了几条会话。
        // `releaseAdopt: false`：用户并没有取消，正在飞的采纳让它自己按 compareId 收尾。
        const previous = get().active;
        if (previous) dismissRound(previous, { releaseAdopt: false });

        const result = buildComparePlan({ taskId, agentId, compareId: newId(), models: get().draftModels });
        if (!result.ok) {
          set({ error: result.error });
          return null;
        }
        const { plan } = result;

        const runtime: CompareRuntime = {
          taskId,
          compareId: plan.compareId,
          prompt,
          startedAt: now(),
          // 只存**计划**（顺序 + 会话键 + 模型）。实时正文/状态由界面从 messageStore 推导，
          // 见 compare-plan 的 deriveColumnView。
          columns: plan.columns.map((c) => ({ index: c.index, sessionKey: c.sessionKey, model: c.model })),
        };

        set((s) => {
          const ephemeralKeys = new Set(s.ephemeralKeys);
          for (const c of runtime.columns) ephemeralKeys.add(c.sessionKey);
          return { active: runtime, ephemeralKeys, error: null };
        });

        // ⚠️ 并发：一次性全部发出去，不 await（见文件头「并发」那一段）。
        for (const column of runtime.columns) {
          void runColumn({
            gatewayId,
            agentId,
            sessionKey: column.sessionKey,
            model: column.model,
            prompt,
            attachments: params.attachments,
          });
        }
        return plan.compareId;
      },

      retry: (sessionKey) => {
        const runtime = get().active;
        if (!runtime) return;
        const column = runtime.columns.find((c) => c.sessionKey === sessionKey);
        if (!column) return;

        // 先把这一列清干净：上一轮的失败文案与残留的 activeTurn 都会让"重试中"看起来像没反应
        //（推导出来的状态会一直停在 error / 上一条半截正文上）。
        // ⚠️ 只动这一列 —— 别的列还在跑，任何"整体清一下"都会把它们打回空白。
        deps.getMessageStore().setSessionError(sessionKey, null);
        deps.getMessageStore().clearActiveTurn(sessionKey);

        const task = deps.getTaskStore().tasks.find((t) => t.id === runtime.taskId);
        void runColumn({
          gatewayId: task?.gatewayId ?? '',
          agentId: task?.agentId ?? 'main',
          sessionKey,
          model: column.model,
          prompt: runtime.prompt,
        });
      },

      dismiss: () => {
        const runtime = get().active;
        if (!runtime) return;
        dismissRound(runtime);
      },

      adopt: (sessionKey) => {
        const runtime = get().active;
        if (!runtime) return;
        if (!runtime.columns.some((c) => c.sessionKey === sessionKey)) return;
        // **单飞**：采纳的同步部分只检查、不改状态（真正落库要等一次 `chat.history` 探针回来），
        // 所以探针在飞的这段时间按钮还是可点的。第二次点进来会走到下面"探针回来时那一轮已经
        // 没了"的收尾分支，把**刚指过去的赢家会话**abort + 删掉 —— 任务指针随即指向一条
        // 不存在的会话（用户看到：点了采纳，三个会话全没了，回答还重复一份）。
        // 点下去就在这里占位（同步），失败/取消才释放。
        if (get().adoptingKey) return;

        const messageStore = deps.getMessageStore();
        // 采纳前置条件：这一列**跑完了且有正文**。不同步检查就改会话指针的话，
        // 指针会指到一条正文还没落的会话上，下一条消息就发进一个用户看不见上下文的会话里了。
        const turn = messageStore.activeTurnBySession[sessionKey];
        if (!turn?.finalized || !turn.content.trim()) return;

        const task = deps.getTaskStore().tasks.find((t) => t.id === runtime.taskId);
        const gatewayId = task?.gatewayId ?? '';
        const taskId = runtime.taskId;
        const compareId = runtime.compareId;
        const prompt = runtime.prompt;
        const losers = runtime.columns.filter((c) => c.sessionKey !== sessionKey).map((c) => c.sessionKey);

        // ⚠️ 败者的中断标记在**这里**就打（同步），不能等下面的异步清理 ——
        // `deleteSession` 一成功登记表就摘键了，迟到的 aborted 帧那时看着像普通会话。
        markAbortedByUser(losers);
        set({ adoptingKey: sessionKey });

        // 收尾是**异步探针**（拿网关侧权威的逐条 model / 时间戳），先把界面收掉，
        // 探针回来后补写 —— 不能让一次网络往返卡住"采纳"这个点击。
        void (async () => {
          const meta = await probeAdoptedMeta(gatewayId, sessionKey);

          // 探针在飞的这段时间里可能被取消（dismiss 会清掉这个占位）—— 那时什么都不该做。
          if (get().adoptingKey !== sessionKey) return;

          // 探针回来时那一轮可能已经被清掉（用户同时点了取消）—— 那时不能硬落库，
          // 否则会出现"没有问题的答案"。
          const latest = messageStore.activeTurnBySession[sessionKey];
          if (!latest?.finalized) {
            // 只收掉**自己这一轮**：用户可能已经跑到别的任务又开了一轮新的。
            set((s) => ({
              active: s.active?.compareId === compareId ? null : s.active,
              adoptingKey: null,
            }));
            deps.onToast?.('error', deps.translate('compare.adoptFailed'));
            resetColumnUi([sessionKey, ...losers]);
            void cleanupSessions(gatewayId, [sessionKey, ...losers], dropEphemeral);
            return;
          }

          // ⚠️ 问题与答案必须用**同一个基准**，否则重启后答案排在问题前面：
          //    时间线是**按 timestamp 升序读回**的（主进程 `data:list-messages` 的 orderBy）。
          //    答案是网关那条回复的生成时刻（`meta.timestamp`，取自 `chat.history`，
          //    这是去重键 `${sessionKey}|${timestamp}` 的一半，**不能改成本地时间**）；
          //    问题排在它前 1ms。
          //    为什么取 `min(网关时刻, 本地 now) - 1ms`：
          //      - 正常情况网关时刻是"刚才"（早于点击），直接用它就对了 —— 这一问一答
          //        落在原对话里正确的相对位置上；
          //      - 万一本机时钟落后/超前于网关侧，取两者较小的那个再减 1ms，就**保证**
          //        「问题在前、答案在后」这个不变式成立（网关时刻比本地晚时用本地，反之用网关）。
          //    注意从"问"到"答"中间隔着整轮对话，用户看到问题的时间戳晚于网关时刻是正常的：
          //    这一对消息是连着落库的，先问后答比"贴着某个真实时刻"重要。
          const assistantTs = meta.timestamp ?? new Date(now()).toISOString();
          const parsedAssistant = Date.parse(assistantTs);
          const baseline = Number.isNaN(parsedAssistant) ? now() : Math.min(parsedAssistant, now());
          const userTs = new Date(baseline - 1).toISOString();

          // 用户消息与 assistant 消息**一起**落库，且顺序是「先问后答」：
          // 只落 assistant 的话，时间线上会是一条没有问题的答案。用户消息直到这一刻
          // 才出现是有意的 —— 在此之前"这一问是否属于本对话"还没定，取消对比时不该留下它。
          messageStore.addMessage(taskId, 'user', prompt, undefined, { timestamp: userTs });
          const adopted = messageStore.adoptActiveTurn(sessionKey, taskId, {
            ...meta,
            timestamp: assistantTs,
          });
          if (!adopted) {
            // 同步检查过 finalized，这里到不了；真到了也只是少一条答复（上面那句用户消息
            // 是真实的提问，不撤 —— 撤了反而丢用户的输入记录）。
            console.warn('[compare] adopt produced no message', { taskId, sessionKey });
          }

          // 会话指针指向赢家 ⇒ 下一句话发进这条**已经有本次问答**的会话，
          // 也就是验收要求的「采纳后新会话带上下文」。
          deps.getTaskStore().updateTaskMetadata(taskId, { sessionKey });

          set((s) => ({
            // 只收掉**自己这一轮**（用户可能已经跑到别的任务又开了一轮，别把新的那轮关掉）。
            active: s.active?.compareId === compareId ? null : s.active,
            // 赢家**转正**：从临时会话登记表摘掉，它现在是这个任务的正常会话了。
            ephemeralKeys: (() => {
              const next = new Set(s.ephemeralKeys);
              next.delete(sessionKey);
              return next;
            })(),
            adoptingKey: null,
            // 采纳成功 = 这一轮结束 ⇒ **退出对比模式**，回到普通对话继续。
            // 不退的话选择条立刻又出现（下一句话又会开一轮全新的对比），
            // 而用户刚刚才说完"就用这个答案"。
            mode: false,
          }));
          resetColumnUi(losers);
          void cleanupSessions(gatewayId, losers, dropEphemeral);
        })();
      },

      isEphemeral: (sessionKey) => get().ephemeralKeys.has(sessionKey),
      wasAbortedByUser: (sessionKey) => get().abortedKeys.has(sessionKey),
    };
  });
}

export type CompareStore = ReturnType<typeof createCompareStore>;
