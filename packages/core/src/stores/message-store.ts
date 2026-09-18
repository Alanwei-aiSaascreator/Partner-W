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
  /** 传 `null` 清掉该会话的失败文案（重试时用）。 */
  setSessionError: (sessionKey: string, message: string | null) => void;
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

        return {
          messagesByTask: nextMessages,
          activeTurnBySession: nextTurns,
          processingBySession: nextProcessing,
          errorBySession: nextErrors,
        };
      }),

    setHighlightedMessage: (id) => set({ highlightedMessageId: id }),

    setProcessing: (sessionKey, processing) =>
      set((s) => {
        const next = new Set(s.processingBySession);
        if (processing) next.add(sessionKey);
        else next.delete(sessionKey);
        return { processingBySession: next };
      }),

    setRunPhase: (sessionKey, phase) =>
      set((s) => ({
        runPhaseBySession: { ...s.runPhaseBySession, [sessionKey]: phase },
      })),

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
