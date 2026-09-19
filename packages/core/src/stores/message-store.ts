import { createStore } from 'zustand/vanilla';
import { mergeGatewayStreamText, parseAgentIdFromSessionKey, parseTaskIdFromSessionKey } from '@clawwork/shared';
import type { Message, MessageRole, MessageAttachment, ToolCall, IpcResult } from '@clawwork/shared';
import { splitInlineThinking } from '../protocol/normalize-history.js';

const EMPTY_MESSAGES: Message[] = [];

export interface ActiveTurn {
  id: string;
  streamingText: string;
  streamingThinking: string;
  toolCalls: ToolCall[];
  finalized: boolean;
  content: string;
  thinkingContent?: string;
  runId?: string;
  timestamp: string;
}

export interface MessageState {
  messagesByTask: Record<string, Message[]>;
  activeTurnBySession: Record<string, ActiveTurn>;
  processingBySession: Set<string>;
  /**
   * 网关正在做什么（`run_status` 事件的 phase）。
   *
   * 为什么要它：2026-09-11 实测，一条 2 字的消息发出去后有 **9 秒界面毫无反应** ——
   * 网关这 9 秒一直在报 `preparing_workspace`，是我们的 `switch(stream)` 没有这个分支、
   * 把它们当未知事件静默丢了。用户由此判定「响应太慢」。
   */
  runPhaseBySession: Record<string, string | null>;
  /**
   * 模型**自述**的进度（网关 `item` 流的 `kind:"preamble"`）。
   *
   * 为什么要它：正文本就不流式（整轮结束才蹦出来，见 `waiting-copy.ts` 的结论），
   * 所以那一大段"卡住"的时间里，**这是唯一在动的东西**。
   * 网关一直在报，我们此前整块丢掉 —— `AgentItemData` 里声明了 `progressText` 却没人读。
   *
   * ⚠️ 是模型的**原话**，不是我们写的文案 —— 界面上要让它跟自家文案能区分开。
   * ⚠️ 不落库：本轮界面状态，与 `runPhaseBySession` 同性质。
   */
  progressTextBySession: Record<string, string | null>;
  /**
   * 「会话已压缩」这句话的**播报记账** —— 只为一件事：**同一个会话别报两次**。
   *
   * 为什么需要：压缩有**两条**来源，都可能说这句话 ——
   * ① 网关的 `sessions.changed {reason:"compact", compacted:true}`（手动压缩走它）；
   * ② 手动压缩那条 RPC 的返回值兜底（万一 ① 没送到）。
   * 两边都只认"真的压了"，但**都要防重复**：事件先到就别再兜底，兜底报过就别再被事件重复。
   *
   * ⚠️ 不落库：本轮界面状态，与 `runPhaseBySession` 同性质。
   *
   * ⚠️ **用"轮次号"而不是时间戳**：时间戳在毫秒内撞车（两轮压缩落在同一毫秒）时，
   *    "同一轮只报一次"的判断会把**新一轮**误杀。轮次号单调递增，没有这个歧义。
   *    （这个坑是测试抓出来的：连做两轮压缩，第二轮被去重挡掉了。）
   */
  compactionAnnouncedEpisodeBySession: Record<string, number>;
  /**
   * **本轮压缩是从什么时候开始的**（ms）。两条路各自在"开始那一刻"记一次：
   * 自动压缩记在网关的 `compaction start` 上；手动压缩记在发出 RPC 那一刻。
   *
   * ⚠️ 为什么必须有它：播报去重是"**同一轮的 `since` 之后只报一次**"，
   *    两条路必须拿到**同一个** `since`，否则会漏判一种顺序 ——
   *    兜底先报(T3)、事件迟到(T4)：若事件用"到达时刻"当 since，T3<T4 就挡不住了 ⇒ 报两次。
   */
  compactionEpisodeBySession: Record<string, number>;
  /**
   * 这个会话**正在压缩上下文**（活动条据此显示"正在压缩上下文…"）。
   *
   * ⚠️ 刻意**不复用** `progressTextBySession`：那一槽的约定是"**模型的原话**，
   *    不是我们写的文案"，而这句是**我们的**文案 —— 塞进去会破坏那条约定
   *    （界面就分不清"模型在说"还是"系统在说"了）。
   * ⚠️ 压缩会让界面**停住一会儿**，这段时间必须看得见东西（用户抱怨的"卡住"）。
   */
  compactingBySession: Record<string, boolean>;
  /**
   * 本轮**从什么时候开始等**（`Date.now()` 毫秒），要么没有这条键。
   *
   * 为什么要它：输入框上方要显示一个**一直在走的秒数** —— 用户骂"卡住"多半是
   * **看不出是否还在动**，一个持续在变的数字比任何 spinner 都能证明"它没死"。
   *
   * ⚠️ 起算点**只在"从空闲变忙"那一刻**打一次：一轮里 `setProcessing(true)`
   * 会被重复调到（重连、迟到的 lifecycle.start），每次都拨表的话，
   * 等了两分钟的用户会看着计时器跳回 3 秒 —— 比不显示还糟。
   * 不落库（与本文件其它 `*BySession` 同性质：本轮界面状态，不是对话数据）。
   */
  turnStartedAtBySession: Record<string, number>;
  /**
   * 「临时会话」（多模型对比的每一列）本轮的失败文案，按 sessionKey 存。
   *
   * 为什么不复用时间线的 system 消息：对比的每一列**还没被采纳**，它不是这个任务的
   * 对话内容 —— 写进时间线等于让用户看到一条他没采纳的回答/报错。而失败**必须让用户看见**
   *（要求「单列失败只在该列显示可读错误 + 重试」），所以给它开一条**旁路**：
   * 错误留在该列自己身上，采纳/退出对比时随 session 一起丢掉。
   *
   * ⚠️ 不落库：这是**本轮界面状态**，不是对话数据（与 `runPhaseBySession` 同性质）。
   */
  errorBySession: Record<string, string>;
  highlightedMessageId: string | null;

  addMessage: (
    taskId: string,
    role: MessageRole,
    content: string,
    attachments?: MessageAttachment[],
    options?: { persist?: boolean; sessionKey?: string; timestamp?: string },
  ) => Message;
  removeMessage: (taskId: string, messageId: string) => void;
  upsertToolCall: (sessionKey: string, taskId: string, tc: ToolCall) => void;
  bulkLoad: (taskId: string, msgs: Message[]) => void;
  appendStreamDelta: (sessionKey: string, delta: string) => void;
  appendThinkingDelta: (sessionKey: string, delta: string) => void;
  finalizeStream: (sessionKey: string, meta?: { runId?: string }) => void;
  promoteActiveTurn: (sessionKey: string, taskId: string, canonical: Message) => void;
  /**
   * 把一个**已经跑完**的临时会话（对比的某一列）的回复收编成任务里的正式 assistant 消息。
   *
   * 与 `promoteActiveTurn` 的区别：那个是「网关历史已经替我们写好了正文，拿它当权威」，
   * 这个的正文**只有本地这一份**（对比列不在这条会话上，网关历史里没有它对应到这个 task 的行），
   * 所以直接用 activeTurn 的内容落库。
   *
   * `options.timestamp` 是**网关侧的**那条回复的生成时刻（调用方从 `chat.history` 探到，
   * 已经过 `toISOTimestamp`）。为什么必须用它而不是本地 `now()`：
   *   ① 对账去重键是 `${sessionKey}|${timestamp}` —— 采纳进时间线的那条要是用本地时间，
   *      事后 `doSyncSession` 就认不出"网关历史里这条已经在时间线上了"，同一段答案会被
   *      再 promote 一遍（用户看到重复回答）；
   *   ② 时间线是按 timestamp 升序读回的（`data:list-messages` 的 `orderBy`）——
   *      问题与答案必须用同一基准，否则重启后答案会排在问题前面。
   * 传不进来（探不到）时才退回 activeTurn 自己的本地时间戳。
   *
   * 返回被收编的消息；**没得采纳时返回 null**（没开过跑、还没 finalize、正文为空）。
   * 调用方据此决定要不要改任务会话指针 —— 收编失败却把指针指过去，下一条消息就发进一个
   * 没有上下文的会话里了。
   */
  adoptActiveTurn: (
    sessionKey: string,
    taskId: string,
    options?: { model?: string; timestamp?: string },
  ) => Message | null;
  clearActiveTurn: (sessionKey: string) => void;
  clearMessages: (taskId: string) => void;
  setHighlightedMessage: (id: string | null) => void;
  setProcessing: (sessionKey: string, processing: boolean) => void;
  /** 传 `null` 表示这一轮结束，清掉进行中提示。 */
  setRunPhase: (sessionKey: string, phase: string | null) => void;
  /** 传 `null` 清掉；空串由调用方挡在外面（别把上一句盖成空的）。 */
  setSessionProgressText: (sessionKey: string, text: string | null) => void;
  /** 传 `null` 清掉该会话的失败文案（重试时用）。 */
  setSessionError: (sessionKey: string, message: string | null) => void;
  /**
   * 播报一次「会话已压缩」。
   *
   * **幂等**：同一个会话在 `since`（这次压缩的开始时刻）之后**已经报过**就什么都不做、
   * 返回 false —— 这是"两条来源各报一次 ⇒ 只出现一条"的那道闸。
   * `text` 由调用方翻译好（store 不该依赖翻译器）。
   */
  announceCompactionOnce: (taskId: string, sessionKey: string, episode: number, text: string) => boolean;
  /** 开一轮压缩，返回本轮轮次号（自动那条记在网关的 `compaction start` 上）。 */
  beginCompactionEpisode: (sessionKey: string) => number;
  /** 取当前轮次号；还没有过就开一轮（事件先到、start 没收到时用）。 */
  ensureCompactionEpisode: (sessionKey: string) => number;
  /** 压缩进行中标记（活动条显示"正在压缩上下文…"用）。 */
  setSessionCompacting: (sessionKey: string, compacting: boolean) => void;
}

export interface MessageStoreDeps {
  persistMessage: (msg: {
    id: string;
    taskId: string;
    role: string;
    content: string;
    timestamp: string;
    sessionKey?: string;
    agentId?: string;
    runId?: string;
    attachments?: unknown[];
    toolCalls?: unknown[];
    thinkingContent?: string;
    /** 实际生成这条回复的模型 id（逐条来自网关）。 */
    model?: string;
  }) => Promise<IpcResult>;
}

function generateId(): string {
  return crypto.randomUUID();
}

function newActiveTurn(): ActiveTurn {
  return {
    id: generateId(),
    streamingText: '',
    streamingThinking: '',
    toolCalls: [],
    finalized: false,
    content: '',
    timestamp: new Date().toISOString(),
  };
}

function toolStatusRank(status: ToolCall['status']): number {
  switch (status) {
    case 'error':
      return 3;
    case 'done':
      return 2;
    case 'running':
      return 1;
  }
}

function mergeToolCallState(existing: ToolCall | undefined, incoming: ToolCall): ToolCall {
  if (!existing) return incoming;

  const preferIncoming = toolStatusRank(incoming.status) >= toolStatusRank(existing.status);
  return {
    ...existing,
    ...incoming,
    status: preferIncoming ? incoming.status : existing.status,
    args: incoming.args ?? existing.args,
    result: incoming.result ?? existing.result,
    // `title` 来自 `item` 流、`args` 来自 `tool` 流 —— 两条流各带一半，
    // 谁先到都不许把对方那半冲掉（`...incoming` 会把显式 undefined 一起铺过来）。
    title: incoming.title ?? existing.title,
    startedAt: existing.startedAt || incoming.startedAt,
    completedAt: incoming.completedAt ?? existing.completedAt,
  };
}

function mergeToolCalls(canonical: ToolCall[], turn: ToolCall[]): ToolCall[] {
  const merged = new Map<string, ToolCall>();
  for (const toolCall of canonical) {
    merged.set(toolCall.id, toolCall);
  }
  for (const toolCall of turn) {
    merged.set(toolCall.id, mergeToolCallState(merged.get(toolCall.id), toolCall));
  }
  return Array.from(merged.values());
}

export function mergeCanonicalMessageWithActiveTurn(canonical: Message, turn?: ActiveTurn): Message {
  return {
    ...canonical,
    thinkingContent: turn?.thinkingContent ?? canonical.thinkingContent,
    toolCalls: mergeToolCalls(canonical.toolCalls, turn?.toolCalls ?? []),
    runId: turn?.runId ?? canonical.runId,
  };
}

export function activeTurnToMessage(turn: ActiveTurn, taskId: string, sessionKey?: string): Message {
  return {
    id: turn.id,
    taskId,
    role: 'assistant',
    content: turn.content,
    thinkingContent: turn.thinkingContent,
    artifacts: [],
    toolCalls: turn.toolCalls,
    sessionKey,
    agentId: sessionKey ? parseAgentIdFromSessionKey(sessionKey) : undefined,
    runId: turn.runId,
    timestamp: turn.timestamp,
  };
}

function persistMessageUpdate(deps: MessageStoreDeps, msg: Message): void {
  deps
    .persistMessage({
      id: msg.id,
      taskId: msg.taskId,
      role: msg.role,
      content: msg.content,
      timestamp: msg.timestamp,
      sessionKey: msg.sessionKey,
      agentId: msg.agentId,
      runId: msg.runId,
      attachments: msg.attachments as unknown[] | undefined,
      toolCalls: msg.toolCalls,
      thinkingContent: msg.thinkingContent,
      // 中途 upsert（工具调用/推理）拿不到它 ⇒ undefined ⇒ 主进程那边条件覆盖，不会抹掉已有值。
      model: msg.model,
    })
    .catch((err) => {
      console.error('[persist:message]', err);
    });
}

export { EMPTY_MESSAGES };

export function createMessageStore(deps: MessageStoreDeps) {
  return createStore<MessageState>((set, get) => ({
    messagesByTask: {},
    activeTurnBySession: {},
    processingBySession: new Set(),
    runPhaseBySession: {},
    compactionAnnouncedEpisodeBySession: {},
    compactionEpisodeBySession: {},
    compactingBySession: {},
    progressTextBySession: {},
    turnStartedAtBySession: {},
    errorBySession: {},
    highlightedMessageId: null,

    addMessage: (taskId, role, content, attachments?, options?) => {
      const sessionKey = options?.sessionKey;
      const msg: Message = {
        id: generateId(),
        taskId,
        role,
        content,
        artifacts: [],
        toolCalls: [],
        attachments: attachments?.length ? attachments : undefined,
        // 允许调用方钉一个时间（对比采纳时，问题要用与答案同一基准的时间，
        // 见 `adoptActiveTurn` 的说明）；不传就是此刻。
        timestamp: options?.timestamp ?? new Date().toISOString(),
        sessionKey,
        agentId: sessionKey ? parseAgentIdFromSessionKey(sessionKey) : undefined,
      };
      set((s) => ({
        messagesByTask: {
          ...s.messagesByTask,
          [taskId]: [...(s.messagesByTask[taskId] ?? []), msg],
        },
      }));
      if (options?.persist !== false) {
        persistMessageUpdate(deps, msg);
      }
      return msg;
    },

    removeMessage: (taskId, messageId) =>
      set((s) => ({
        messagesByTask: {
          ...s.messagesByTask,
          [taskId]: (s.messagesByTask[taskId] ?? []).filter((message) => message.id !== messageId),
        },
      })),

    upsertToolCall: (sessionKey, taskId, tc) => {
      let persistedMessage: Message | null = null;

      set((s) => {
        const turn = s.activeTurnBySession[sessionKey];
        if (turn) {
          const idx = turn.toolCalls.findIndex((t) => t.id === tc.id);
          const next = [...turn.toolCalls];
          if (idx >= 0) next[idx] = mergeToolCallState(next[idx], tc);
          else next.push(tc);
          return {
            activeTurnBySession: {
              ...s.activeTurnBySession,
              [sessionKey]: { ...turn, toolCalls: next },
            },
          };
        }

        const msgs = s.messagesByTask[taskId] ?? [];
        let lastAssistantIdx = -1;
        let lastUserIdx = -1;
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (lastAssistantIdx < 0 && msgs[i].role === 'assistant') lastAssistantIdx = i;
          if (lastUserIdx < 0 && msgs[i].role === 'user') lastUserIdx = i;
          if (lastAssistantIdx >= 0 && lastUserIdx >= 0) break;
        }

        const targetIdx = lastAssistantIdx >= 0 && lastAssistantIdx > lastUserIdx ? lastAssistantIdx : -1;
        if (targetIdx >= 0) {
          const updatedMsgs = [...msgs];
          const target = updatedMsgs[targetIdx];
          const idx = target.toolCalls.findIndex((t) => t.id === tc.id);
          const next = [...target.toolCalls];
          if (idx >= 0) next[idx] = mergeToolCallState(next[idx], tc);
          else next.push(tc);
          updatedMsgs[targetIdx] = { ...target, toolCalls: next };
          persistedMessage = updatedMsgs[targetIdx];
          return { messagesByTask: { ...s.messagesByTask, [taskId]: updatedMsgs } };
        }

        return {
          activeTurnBySession: {
            ...s.activeTurnBySession,
            [sessionKey]: { ...newActiveTurn(), toolCalls: [tc] },
          },
        };
      });

      if (persistedMessage) {
        persistMessageUpdate(deps, persistedMessage);
      }
    },

    // ⚠️ 装载**本地已存**的消息时也要切一次行内推理。
    //    否则「修好之前就落库的那些」永远是脏的 —— 它们早就在磁盘上定形了，
    //    之后无论怎么改代码都不会被重新归一化（实测：修完当场看仍是脏的）。
    bulkLoad: (taskId, msgs) =>
      set((s) => ({
        messagesByTask: {
          ...s.messagesByTask,
          [taskId]: msgs.map((m) => {
            if (m.role !== 'assistant' || !m.content) return m;
            const { text, thinkingText } = splitInlineThinking(m.content, m.thinkingContent ?? '');
            if (text === m.content && !thinkingText) return m;
            return { ...m, content: text, thinkingContent: thinkingText || undefined };
          }),
        },
      })),

    appendStreamDelta: (sessionKey, delta) =>
      set((s) => {
        const turn = s.activeTurnBySession[sessionKey] ?? newActiveTurn();
        return {
          activeTurnBySession: {
            ...s.activeTurnBySession,
            [sessionKey]: {
              ...turn,
              streamingText: mergeGatewayStreamText(turn.streamingText, delta),
            },
          },
        };
      }),

    appendThinkingDelta: (sessionKey, delta) =>
      set((s) => {
        const turn = s.activeTurnBySession[sessionKey] ?? newActiveTurn();
        return {
          activeTurnBySession: {
            ...s.activeTurnBySession,
            [sessionKey]: {
              ...turn,
              streamingThinking: mergeGatewayStreamText(turn.streamingThinking, delta),
            },
          },
        };
      }),

    finalizeStream: (sessionKey, meta?) => {
      set((s) => {
        const turn = s.activeTurnBySession[sessionKey];
        if (!turn) return s;

        // ⚠️ 推理可能**混在正文里**（有些模型只给闭标签 `</think>`、没有单独的 thinking
        //    块 —— 2026-09-14 线上实测 qwen3.5-27b）。这里原本是
        //    `content = turn.streamingText` 原样收下，于是**流式**这条路径把推理留在了
        //    正文里，而 `normalizeAssistantTurns` 那条路径是干净的 —— 同一会话两条路径
        //    结果不一致。两处共用同一个切分函数。
        const { text: content, thinkingText: inlineThinking } = splitInlineThinking(
          turn.streamingText,
          turn.streamingThinking,
        );
        const thinkingContent = inlineThinking || undefined;

        if (!content && !thinkingContent && turn.toolCalls.length === 0) {
          return {
            activeTurnBySession: {
              ...s.activeTurnBySession,
              [sessionKey]: { ...turn, streamingText: '', streamingThinking: '' },
            },
          };
        }

        return {
          activeTurnBySession: {
            ...s.activeTurnBySession,
            [sessionKey]: {
              ...turn,
              finalized: true,
              content,
              thinkingContent,
              streamingText: '',
              streamingThinking: '',
              runId: meta?.runId ?? turn.runId,
            },
          },
        };
      });
    },

    promoteActiveTurn: (sessionKey, taskId, canonical) =>
      set((s) => {
        const turn = s.activeTurnBySession[sessionKey];
        const merged = mergeCanonicalMessageWithActiveTurn(canonical, turn);
        const nextTurns = { ...s.activeTurnBySession };
        delete nextTurns[sessionKey];
        return {
          messagesByTask: {
            ...s.messagesByTask,
            [taskId]: [...(s.messagesByTask[taskId] ?? []), merged],
          },
          activeTurnBySession: nextTurns,
        };
      }),

    adoptActiveTurn: (sessionKey, taskId, options?) => {
      const turn = get().activeTurnBySession[sessionKey];
      // 只有**跑完**的一轮才可采纳。半途采纳等于把一段没写完的正文落成正式回复，
      // 而且它的「最终正文」还在 streamingText 里、content 是空的。
      if (!turn || !turn.finalized) return null;

      const adopted: Message = {
        ...activeTurnToMessage(turn, taskId, sessionKey),
        // 实际生成它的模型：**只有**调用方从网关历史探到了才传（见 compare-store 的采纳流程）。
        // 拿列的配置模型兜底是被禁止的 —— 那字段是「我发给谁」不是「谁答的」。
        model: options?.model,
        // 同上：探到网关时间戳就用它（对账去重键 + 时间线排序都要），否则保留 activeTurn 的。
        timestamp: options?.timestamp ?? turn.timestamp,
      };
      if (!adopted.content && !adopted.thinkingContent && adopted.toolCalls.length === 0) return null;

      set((s) => {
        const nextTurns = { ...s.activeTurnBySession };
        delete nextTurns[sessionKey];
        const nextErrors = { ...s.errorBySession };
        delete nextErrors[sessionKey];
        return {
          messagesByTask: { ...s.messagesByTask, [taskId]: [...(s.messagesByTask[taskId] ?? []), adopted] },
          activeTurnBySession: nextTurns,
          errorBySession: nextErrors,
        };
      });
      persistMessageUpdate(deps, adopted);
      return adopted;
    },

    clearActiveTurn: (sessionKey) =>
      set((s) => {
        if (!s.activeTurnBySession[sessionKey]) return s;
        const next = { ...s.activeTurnBySession };
        delete next[sessionKey];
        return { activeTurnBySession: next };
      }),

    clearMessages: (taskId) =>
      set((s) => {
        const nextMessages = { ...s.messagesByTask };
        const nextTurns = { ...s.activeTurnBySession };
        const nextProcessing = new Set(s.processingBySession);
        const nextErrors = { ...s.errorBySession };
        const nextTurnStartedAt = { ...s.turnStartedAtBySession };

        delete nextMessages[taskId];
        for (const key of Object.keys(nextTurns)) {
          if (parseTaskIdFromSessionKey(key) === taskId) delete nextTurns[key];
        }
        for (const key of nextProcessing) {
          if (parseTaskIdFromSessionKey(key) === taskId) nextProcessing.delete(key);
        }
        for (const key of Object.keys(nextErrors)) {
          if (parseTaskIdFromSessionKey(key) === taskId) delete nextErrors[key];
        }
        for (const key of Object.keys(nextTurnStartedAt)) {
          if (parseTaskIdFromSessionKey(key) === taskId) delete nextTurnStartedAt[key];
        }

        return {
          messagesByTask: nextMessages,
          activeTurnBySession: nextTurns,
          processingBySession: nextProcessing,
          errorBySession: nextErrors,
          turnStartedAtBySession: nextTurnStartedAt,
        };
      }),

    setHighlightedMessage: (id) => set({ highlightedMessageId: id }),

    setProcessing: (sessionKey, processing) =>
      set((s) => {
        const wasProcessing = s.processingBySession.has(sessionKey);
        const next = new Set(s.processingBySession);
        if (processing) next.add(sessionKey);
        else next.delete(sessionKey);

        // ⚠️ 只在**从空闲变忙**那一刻打点。已经在忙时再收到 `true`（重连、迟到的
        //    lifecycle.start）绝不能拨表 —— 见 `turnStartedAtBySession` 的说明。
        const startedAt = { ...s.turnStartedAtBySession };
        if (processing) {
          if (!wasProcessing) startedAt[sessionKey] = Date.now();
        } else {
          delete startedAt[sessionKey];
        }

        return { processingBySession: next, turnStartedAtBySession: startedAt };
      }),

    setRunPhase: (sessionKey, phase) =>
      set((s) => ({
        runPhaseBySession: { ...s.runPhaseBySession, [sessionKey]: phase },
      })),

    setSessionProgressText: (sessionKey, text) =>
      set((s) => ({
        progressTextBySession: { ...s.progressTextBySession, [sessionKey]: text },
      })),

    announceCompactionOnce: (taskId, sessionKey, episode, text) => {
      // ⚠️ 判断与写入必须在**同一次** `set` 里（zustand 的 updater 是同步的）——
      //    分两步读-改-写的话，两条来源几乎同时到达时会**都**通过检查。
      let announced = false;
      set((s) => {
        if ((s.compactionAnnouncedEpisodeBySession[sessionKey] ?? 0) >= episode) return s;
        announced = true;
        return {
          compactionAnnouncedEpisodeBySession: { ...s.compactionAnnouncedEpisodeBySession, [sessionKey]: episode },
        };
      });
      if (!announced) return false;
      get().addMessage(taskId, 'system', text, undefined, { sessionKey });
      return true;
    },

    beginCompactionEpisode: (sessionKey) => {
      const next = (get().compactionEpisodeBySession[sessionKey] ?? 0) + 1;
      set((s) => ({ compactionEpisodeBySession: { ...s.compactionEpisodeBySession, [sessionKey]: next } }));
      return next;
    },

    ensureCompactionEpisode: (sessionKey) => {
      const current = get().compactionEpisodeBySession[sessionKey];
      return current ?? get().beginCompactionEpisode(sessionKey);
    },

    setSessionCompacting: (sessionKey, compacting) =>
      set((s) => {
        if (compacting) return { compactingBySession: { ...s.compactingBySession, [sessionKey]: true } };
        if (!(sessionKey in s.compactingBySession)) return s;
        const next = { ...s.compactingBySession };
        delete next[sessionKey];
        return { compactingBySession: next };
      }),

    setSessionError: (sessionKey, message) =>
      set((s) => {
        if (message === null) {
          if (!(sessionKey in s.errorBySession)) return s;
          const next = { ...s.errorBySession };
          delete next[sessionKey];
          return { errorBySession: next };
        }
        return { errorBySession: { ...s.errorBySession, [sessionKey]: message } };
      }),
  }));
}
