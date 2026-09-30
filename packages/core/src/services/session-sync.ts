import { parseAgentIdFromSessionKey, parseTaskIdFromSessionKey } from '@clawwork/shared';
import type { Message, MessageRole, ToolCall, IpcResult, ChatDispatchReceipt } from '@clawwork/shared';
import type { RawHistoryMessage } from '../protocol/types.js';
import type { ActiveTurn, MessageState } from '../stores/message-store.js';
import { mergeCanonicalMessageWithActiveTurn } from '../stores/message-store.js';
import {
  sanitizeModel,
  normalizeContentBlocks,
  normalizeAssistantTurns,
  collapseDiscoveredMessages,
  mergeMessageAttachments,
} from '../protocol/normalize-history.js';

type DiscoveredSyncMessage = {
  role: string;
  content: string;
  timestamp: string;
  attachments?: unknown[];
  toolCalls?: ToolCall[];
  /** 实际生成这条回复的模型（逐条来自网关）。见 `Message.model`。 */
  model?: string;
};

export interface SessionSyncDeps {
  persistence: {
    loadMessages: (taskId: string) => Promise<{
      ok: boolean;
      rows?: {
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
        model?: string | null;
      }[];
    }>;
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
      model?: string;
    }) => Promise<IpcResult>;
  };
  gateway: {
    getHttpBase?: (gatewayId: string) => string | undefined | Promise<string | undefined>;
    chatHistory: (gatewayId: string, sessionKey: string, limit?: number) => Promise<IpcResult>;
    syncSessions: () => Promise<{
      ok: boolean;
      discovered?: {
        gatewayId: string;
        taskId: string;
        sessionKey: string;
        title: string;
        updatedAt: string;
        agentId: string;
        model?: string;
        modelProvider?: string;
        thinkingLevel?: string;
        inputTokens?: number;
        outputTokens?: number;
        contextTokens?: number;
        messages: DiscoveredSyncMessage[];
      }[];
    }>;
  };
  getTaskStore: () => {
    tasks: { id: string; gatewayId: string; sessionKey: string }[];
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
    updateTaskMetadata: (
      id: string,
      meta: {
        model?: string;
        modelProvider?: string;
        thinkingLevel?: string;
        inputTokens?: number;
        outputTokens?: number;
        contextTokens?: number;
        /**
         * 这一轮的"最后活动时间"。**同步元数据时必须带上它** —— 缺省时 store 会填
         * `new Date()`（见 `task-store.ts` 的 `meta.updatedAt ?? new Date()`），
         * 于是每启动同步一圈就把所有任务的排序时间抹平（2026-09-20 实测 42 个任务
         * 全落在 5 毫秒里），侧栏「最近任务」的排序退化成任意顺序。
         */
        updatedAt?: string;
      },
    ) => void;
  };
  getMessageStore: () => Pick<
    MessageState,
    'messagesByTask' | 'activeTurnBySession' | 'bulkLoad' | 'promoteActiveTurn' | 'clearActiveTurn'
  > & {
    setState: (
      updater: (state: {
        messagesByTask: Record<string, Message[]>;
      }) => Partial<{ messagesByTask: Record<string, Message[]> }>,
    ) => void;
  };
  /**
   * 这个会话是不是**临时会话**（多模型对比的某一列，见 gateway-dispatcher 的同名依赖）。
   *
   * 对账路径上它是第二道闸：对比列的会话键解析出来的 taskId 是**真**任务，
   * 于是 `retrySyncPending`（重连时）会把它当成"这个任务有一条跑完但还没落库的回复"
   * 去拉 `chat.history` —— 那样**用户没采纳的答案会被写进时间线**。
   * 第一道闸在 dispatcher（final 时不触发 sync），这里兜住重连这条旁路。
   */
  isEphemeralSession?: (sessionKey: string) => boolean;
}

const RETRY_DELAYS = [2000, 4000, 8000];
export type RunSyncResult =
  | { kind: 'pending' }
  | { kind: 'completed'; messageIds: string[]; content: string }
  | { kind: 'failed'; reason: 'invalid-receipt' | 'persistence' | 'history' };
type PersistenceScope = { taskId: string; sessionKey: string; gatewayId: string };
export type LateToolUpdate = { gatewayId: string; runId: string; toolCall: ToolCall };
class CanonicalPersistenceError extends Error {}

function normalizeLocalAssistantMessage(row: { role: string; content: string; attachments?: unknown[] }): {
  content: string;
  attachments?: Message['attachments'];
} {
  const existingAttachments = Array.isArray(row.attachments) ? (row.attachments as Message['attachments']) : undefined;
  if (row.role !== 'assistant') return { content: row.content, attachments: existingAttachments };
  const normalized = normalizeContentBlocks([{ type: 'text', text: row.content }]);
  return {
    content: normalized.content,
    attachments: mergeMessageAttachments(existingAttachments, normalized.attachments),
  };
}

export function createSessionSync(deps: SessionSyncDeps) {
  let hydrationPromise: Promise<void> | null = null;
  const syncChains = new Map<string, Promise<void>>();
  const pendingWrites = new Map<string, PersistenceScope & { message: Message }>();
  const lateTools = new Map<string, PersistenceScope & { runId: string; tools: Map<string, ToolCall> }>();
  let syncEpoch = 0;

  function lateToolKey(scope: PersistenceScope, runId: string): string {
    return JSON.stringify([scope.gatewayId, scope.taskId, scope.sessionKey, runId]);
  }

  function queueLateTool(scope: PersistenceScope, update: LateToolUpdate): void {
    const key = lateToolKey(scope, update.runId);
    if (!lateTools.has(key) && lateTools.size >= 128) {
      lateTools.delete(lateTools.keys().next().value!);
      console.warn('[sync] late tool run buffer reached its limit');
    }
    const entry = lateTools.get(key) ?? { ...scope, runId: update.runId, tools: new Map<string, ToolCall>() };
    if (!entry.tools.has(update.toolCall.id) && entry.tools.size >= 64) {
      entry.tools.delete(entry.tools.keys().next().value!);
      console.warn('[sync] late tool call buffer reached its limit');
    }
    const merged = mergeCanonicalMessageWithActiveTurn(
      {
        id: '',
        taskId: scope.taskId,
        role: 'assistant',
        content: '',
        artifacts: [],
        timestamp: '',
        toolCalls: [...entry.tools.values()],
      },
      {
        id: '',
        timestamp: '',
        content: '',
        streamingText: '',
        streamingThinking: '',
        finalized: true,
        toolCalls: [update.toolCall],
      },
    );
    entry.tools = new Map(merged.toolCalls.map((tool) => [tool.id, tool]));
    lateTools.set(key, entry);
  }

  function mergeLateTools(message: Message, scope: PersistenceScope): Message {
    const entry = message.runId ? lateTools.get(lateToolKey(scope, message.runId)) : undefined;
    if (!entry) return message;
    return mergeCanonicalMessageWithActiveTurn(message, {
      id: '',
      timestamp: '',
      content: '',
      streamingText: '',
      streamingThinking: '',
      finalized: true,
      runId: entry.runId,
      toolCalls: [...entry.tools.values()],
    });
  }

  async function reconcileLateTools(scope: PersistenceScope, epoch: number): Promise<void> {
    for (const [key, entry] of lateTools) {
      if (entry.taskId !== scope.taskId || entry.gatewayId !== scope.gatewayId || entry.sessionKey !== scope.sessionKey)
        continue;
      const owner = deps.getTaskStore().tasks.find((task) => task.id === scope.taskId);
      if (!owner || owner.gatewayId !== scope.gatewayId) return;
      const messages = deps.getMessageStore().messagesByTask[scope.taskId] ?? [];
      const scoped = messages.filter(
        (message) => message.role === 'assistant' && (message.sessionKey ?? owner.sessionKey) === scope.sessionKey,
      );
      let matches = scoped.filter((message) => message.runId === entry.runId);
      if (matches.length === 0) {
        matches = scoped.filter(
          (message) =>
            !message.runId && [...entry.tools.keys()].every((id) => message.toolCalls.some((tool) => tool.id === id)),
        );
      }
      if (matches.length !== 1) continue;
      const canonical = { ...matches[0], runId: entry.runId };
      const merged = mergeLateTools(canonical, scope);
      await persistCanonicalMessages([merged], scope, epoch);
      if (syncEpoch !== epoch) return;
      deps.getMessageStore().setState((state) => ({
        messagesByTask: {
          ...state.messagesByTask,
          [scope.taskId]: state.messagesByTask[scope.taskId].map((message) =>
            message.id === merged.id ? merged : message,
          ),
        },
      }));
      if (lateTools.get(key) === entry) lateTools.delete(key);
    }
  }

  async function persistCanonicalMessage(message: Message): Promise<void> {
    const result = await deps.persistence.persistMessage({
      id: message.id,
      taskId: message.taskId,
      role: message.role,
      content: message.content,
      timestamp: message.timestamp,
      sessionKey: message.sessionKey,
      agentId: message.agentId,
      runId: message.runId,
      attachments: message.attachments as unknown[] | undefined,
      toolCalls: message.toolCalls,
      thinkingContent: message.thinkingContent,
      // 消息级模型：落库后重启才还在（重载读回见 hydrateFromLocal）。
      model: message.model,
    });
    if (!result.ok) throw new Error(result.error ?? 'Canonical message persistence failed');
  }

  async function flushPendingWrites(scope: PersistenceScope, epoch: number): Promise<void> {
    for (const [id, entry] of pendingWrites) {
      if (syncEpoch !== epoch) return;
      if (entry.taskId !== scope.taskId || entry.sessionKey !== scope.sessionKey || entry.gatewayId !== scope.gatewayId)
        continue;
      for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
        if (syncEpoch !== epoch || pendingWrites.get(id) !== entry) break;
        try {
          await persistCanonicalMessage(entry.message);
          if (syncEpoch === epoch && pendingWrites.get(id) === entry) pendingWrites.delete(id);
          break;
        } catch (error) {
          if (syncEpoch !== epoch || pendingWrites.get(id) !== entry) break;
          if (attempt === RETRY_DELAYS.length) {
            throw new CanonicalPersistenceError('Canonical message persistence exhausted retries', { cause: error });
          }
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS[attempt]));
        }
      }
    }
  }

  async function persistCanonicalMessages(messages: Message[], scope: PersistenceScope, epoch: number): Promise<void> {
    if (syncEpoch !== epoch) return;
    for (const message of messages) pendingWrites.set(message.id, { ...scope, message });
    await flushPendingWrites(scope, epoch);
  }

  async function backfillAssistantAttachments(
    taskId: string,
    sessionKey: string,
    incoming: Array<{ timestamp: string; attachments?: Message['attachments'] }>,
    gatewayId: string,
    epoch: number,
  ): Promise<void> {
    const withAttachments = incoming.filter((message) => message.attachments?.length);
    if (withAttachments.length === 0) return;

    const byTimestamp = new Map(withAttachments.map((message) => [message.timestamp, message]));
    const updated: Message[] = [];

    deps.getMessageStore().setState((s) => {
      const messages = s.messagesByTask[taskId] ?? [];
      let changed = false;
      const next = messages.map((message) => {
        if (message.role !== 'assistant') return message;
        if ((message.sessionKey ?? sessionKey) !== sessionKey) return message;
        const match = byTimestamp.get(message.timestamp);
        if (!match?.attachments?.length) return message;

        const merged = mergeMessageAttachments(message.attachments, match.attachments);
        if ((merged?.length ?? 0) === (message.attachments?.length ?? 0)) return message;

        changed = true;
        const nextMessage = { ...message, attachments: merged };
        updated.push(nextMessage);
        return nextMessage;
      });

      return changed ? { messagesByTask: { ...s.messagesByTask, [taskId]: next } } : {};
    });

    await persistCanonicalMessages(updated, { taskId, sessionKey, gatewayId }, epoch);
  }

  async function hydrateFromLocal(): Promise<void> {
    if (!hydrationPromise) {
      const epoch = syncEpoch;
      hydrationPromise = (async () => {
        const taskStore = deps.getTaskStore();
        const messageStore = deps.getMessageStore();
        await taskStore.hydrate();
        if (syncEpoch !== epoch) return;
        const tasks = deps.getTaskStore().tasks;
        for (const t of tasks) {
          try {
            const res = await deps.persistence.loadMessages(t.id);
            if (syncEpoch !== epoch) return;
            if (res.ok && res.rows && res.rows.length > 0) {
              const msgs: Message[] = res.rows.map((r) => {
                const normalized = normalizeLocalAssistantMessage(r);
                return {
                  id: r.id,
                  taskId: r.taskId,
                  role: r.role as MessageRole,
                  content: normalized.content,
                  artifacts: [],
                  toolCalls: Array.isArray(r.toolCalls) ? (r.toolCalls as ToolCall[]) : [],
                  timestamp: r.timestamp,
                  sessionKey: r.sessionKey,
                  agentId: r.agentId,
                  runId: r.runId,
                  attachments: normalized.attachments,
                  thinkingContent: r.thinkingContent,
                  // 老行没有这一列 ⇒ 读出 `null`，规整成 undefined（UI 据此不渲染徽章）。
                  model: r.model ?? undefined,
                };
              });
              messageStore.bulkLoad(t.id, msgs);
            }
          } catch (err) {
            console.warn('[sync] hydrateFromLocal failed for task', t.id, err);
          }
        }
      })().catch((err) => {
        if (syncEpoch === epoch) hydrationPromise = null;
        throw err;
      });
    }
    await hydrationPromise;
  }

  async function doSyncSession(
    scope: PersistenceScope,
    epoch: number,
    expectedRunId?: string,
  ): Promise<RunSyncResult | void> {
    const { taskId, sessionKey, gatewayId } = scope;
    const task = deps.getTaskStore().tasks.find((t) => t.id === taskId);
    if (!task || task.gatewayId !== gatewayId) return;
    if (expectedRunId && task.sessionKey !== sessionKey) return;
    if (deps.isEphemeralSession?.(sessionKey)) return;

    await flushPendingWrites({ taskId, sessionKey, gatewayId: task.gatewayId }, epoch);
    if (syncEpoch !== epoch) return;
    await reconcileLateTools(scope, epoch);
    if (syncEpoch !== epoch) return;
    const httpBase = await deps.gateway.getHttpBase?.(task.gatewayId);
    if (syncEpoch !== epoch) return;
    const res = await deps.gateway.chatHistory(task.gatewayId, sessionKey);
    if (syncEpoch !== epoch) return;
    if (!res.ok || !res.result) return expectedRunId ? { kind: 'failed', reason: 'history' } : undefined;

    const raw = res.result as { messages?: RawHistoryMessage[] };
    const rawMsgs = raw.messages ?? [];
    let finalTimestamp: string | undefined;
    if (expectedRunId) {
      const finalRaw = rawMsgs.filter((message) => message.role === 'assistant').at(-1);
      const finalTurn = finalRaw ? normalizeAssistantTurns([finalRaw], httpBase).at(-1) : undefined;
      if (finalRaw?.__openclaw?.runId !== expectedRunId || finalRaw.stopReason !== 'stop' || !finalTurn?.content) {
        return { kind: 'pending' };
      }
      finalTimestamp = finalTurn.timestamp;
    }

    const messageStore = deps.getMessageStore();
    const localMsgs = messageStore.messagesByTask[taskId] ?? [];
    const localAssistantMsgs = localMsgs.filter(
      (m) => m.role === 'assistant' && (m.sessionKey ?? task.sessionKey) === sessionKey,
    );
    const localAssistantKeys = new Set(
      localAssistantMsgs.map((m) => `${m.sessionKey ?? task.sessionKey}|${m.timestamp}`),
    );

    const gatewayAssistant = normalizeAssistantTurns(rawMsgs, httpBase);
    const collisions = new Set(
      gatewayAssistant.filter((incoming) =>
        localAssistantMsgs.some(
          (local) =>
            local.timestamp === incoming.timestamp && local.runId && incoming.runId && local.runId !== incoming.runId,
        ),
      ),
    );
    for (const incoming of gatewayAssistant) {
      if (
        gatewayAssistant.some(
          (other) =>
            other.timestamp === incoming.timestamp && other.runId && incoming.runId && other.runId !== incoming.runId,
        )
      )
        collisions.add(incoming);
    }
    if (expectedRunId && collisions.size > 0) return { kind: 'pending' };
    if (collisions.size > 0)
      console.warn('[sync] canonical timestamp collision between distinct runs', { taskId, sessionKey, gatewayId });
    await backfillAssistantAttachments(
      taskId,
      sessionKey,
      gatewayAssistant.filter((incoming) => !collisions.has(incoming)),
      task.gatewayId,
      epoch,
    );
    if (syncEpoch !== epoch) return;

    const newest = gatewayAssistant.filter(
      (m) => !collisions.has(m) && !localAssistantKeys.has(`${sessionKey}|${m.timestamp}`),
    );
    if (newest.length === 0 && !expectedRunId) {
      if (collisions.size > 0) return;
      const currentStore = deps.getMessageStore();
      const activeRunId = currentStore.activeTurnBySession[sessionKey]?.runId;
      const historyRunId = gatewayAssistant.at(-1)?.runId;
      if (gatewayAssistant.length > 0 && (!activeRunId || activeRunId === historyRunId)) {
        currentStore.clearActiveTurn(sessionKey);
      }
      return;
    }

    const acknowledged = new Set<string>();
    for (let i = 0; i < newest.length; i++) {
      if (syncEpoch !== epoch) return;
      const gm = newest[i];
      const canonical: Message = mergeLateTools(
        {
          id: crypto.randomUUID(),
          taskId,
          role: 'assistant',
          content: gm.content,
          // 网关历史里带推理块（实测），换设备/清库后靠它重建。
          // 本轮还在内存里的话，下面的 mergeCanonicalMessageWithActiveTurn 会优先用 activeTurn 的
          //（同一段时间戳、同一段文本，是覆盖不是叠加）。
          thinkingContent: gm.thinkingContent,
          // 这条回复实际是谁生成的（逐条来自网关，不是会话选中的模型）。
          model: gm.model,
          artifacts: [],
          toolCalls: gm.toolCalls,
          runId: gm.runId,
          attachments: gm.attachments,
          sessionKey,
          agentId: parseAgentIdFromSessionKey(sessionKey),
          timestamp: gm.timestamp,
        },
        scope,
      );
      const currentStore = deps.getMessageStore();
      const mergedCanonical = mergeCanonicalMessageWithActiveTurn(
        canonical,
        currentStore.activeTurnBySession[sessionKey],
      );

      if (i === newest.length - 1) {
        currentStore.promoteActiveTurn(sessionKey, taskId, canonical);
      } else {
        currentStore.setState((s) => ({
          messagesByTask: {
            ...s.messagesByTask,
            [taskId]: [...(s.messagesByTask[taskId] ?? []), mergedCanonical],
          },
        }));
      }

      await persistCanonicalMessages([mergedCanonical], { taskId, sessionKey, gatewayId: task.gatewayId }, epoch);
      if (syncEpoch !== epoch) return;
      if (mergedCanonical.runId) lateTools.delete(lateToolKey(scope, mergedCanonical.runId));
      acknowledged.add(mergedCanonical.id);
    }

    if (expectedRunId && syncEpoch === epoch) {
      const finalTurn = gatewayAssistant.find(
        (message) => message.runId === expectedRunId && message.timestamp === finalTimestamp,
      );
      const canonical = deps
        .getMessageStore()
        .messagesByTask[
          taskId
        ]?.find((message) => message.role === 'assistant' && message.sessionKey === sessionKey && (!message.runId || message.runId === expectedRunId) && message.timestamp === finalTimestamp);
      if (!canonical || !finalTurn?.content) return { kind: 'pending' };
      const confirmed = { ...canonical, runId: expectedRunId, content: finalTurn.content };
      if (!acknowledged.has(canonical.id)) {
        deps.getMessageStore().setState((state) => ({
          messagesByTask: {
            ...state.messagesByTask,
            [taskId]: state.messagesByTask[taskId].map((message) =>
              message.id === canonical.id ? confirmed : message,
            ),
          },
        }));
        await persistCanonicalMessages([confirmed], scope, epoch);
      }
      if (syncEpoch !== epoch) return { kind: 'pending' };
      return { kind: 'completed', messageIds: [confirmed.id], content: confirmed.content };
    }
  }

  async function syncRun(taskId: string, receipt: ChatDispatchReceipt): Promise<RunSyncResult> {
    const epoch = syncEpoch;
    const task = deps.getTaskStore().tasks.find((entry) => entry.id === taskId);
    if (!task?.gatewayId || receipt.sessionKey !== task.sessionKey || !receipt.runId.trim()) {
      return { kind: 'failed', reason: 'invalid-receipt' };
    }
    const scope = { taskId, sessionKey: receipt.sessionKey, gatewayId: task.gatewayId };
    let result: RunSyncResult = { kind: 'pending' };
    try {
      await enqueueSync(scope, epoch, async () => {
        result = (await doSyncSession(scope, epoch, receipt.runId)) ?? { kind: 'pending' };
      });
      return syncEpoch === epoch ? result : { kind: 'pending' };
    } catch (error) {
      if (syncEpoch !== epoch) return { kind: 'pending' };
      return { kind: 'failed', reason: error instanceof CanonicalPersistenceError ? 'persistence' : 'history' };
    }
  }

  function syncSessionMessages(taskId: string, sessionKeyOverride?: string, lateTool?: LateToolUpdate): Promise<void> {
    const epoch = syncEpoch;
    const task = deps.getTaskStore().tasks.find((t) => t.id === taskId);
    const sessionKey = sessionKeyOverride ?? task?.sessionKey;
    if (!task?.gatewayId || !sessionKey) return Promise.resolve();
    const scope = { taskId, sessionKey, gatewayId: task.gatewayId };
    if (lateTool) {
      const parsedTaskId = parseTaskIdFromSessionKey(sessionKey);
      const existingOwnedRun = (deps.getMessageStore().messagesByTask[taskId] ?? []).filter(
        (message) =>
          message.role === 'assistant' && message.sessionKey === sessionKey && message.runId === lateTool.runId,
      );
      if (
        lateTool.gatewayId !== task.gatewayId ||
        !lateTool.runId.trim() ||
        (parsedTaskId ? parsedTaskId !== taskId : existingOwnedRun.length !== 1)
      )
        return Promise.resolve();
    }
    return enqueueSync(scope, epoch, () => {
      if (lateTool) queueLateTool(scope, lateTool);
      return syncWithRetry(scope, epoch);
    });
  }

  function enqueueSync(scope: PersistenceScope, epoch: number, work: () => Promise<void>): Promise<void> {
    const chainKey = JSON.stringify([scope.gatewayId, scope.sessionKey]);
    const prev = syncChains.get(chainKey) ?? Promise.resolve();
    const job = prev.then(() => (syncEpoch === epoch ? work() : undefined));
    const settled = job
      .catch(() => {})
      .finally(() => {
        if (syncChains.get(chainKey) === settled) syncChains.delete(chainKey);
      });
    syncChains.set(chainKey, settled);
    return job;
  }

  async function syncWithRetry(scope: PersistenceScope, epoch: number): Promise<void> {
    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
      if (syncEpoch !== epoch) return;
      try {
        await doSyncSession(scope, epoch);
        return;
      } catch (error) {
        if (error instanceof CanonicalPersistenceError) throw error;
        if (attempt < RETRY_DELAYS.length) {
          await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
          if (syncEpoch !== epoch) return;
        }
      }
    }
    if (syncEpoch === epoch) {
      console.warn('[sync] syncSessionMessages exhausted retries for task', scope.taskId);
    }
  }

  function retrySyncPending(): void {
    const pendingSessions = new Map<string, string>();
    for (const entry of pendingWrites.values()) {
      if (deps.getTaskStore().tasks.some((task) => task.id === entry.taskId && task.gatewayId === entry.gatewayId)) {
        pendingSessions.set(entry.sessionKey, entry.taskId);
      }
    }
    const turns = deps.getMessageStore().activeTurnBySession;
    for (const [sessionKey, turn] of Object.entries(turns)) {
      if (deps.isEphemeralSession?.(sessionKey)) continue;
      if ((turn as ActiveTurn).finalized) {
        const taskId = parseTaskIdFromSessionKey(sessionKey);
        if (taskId) pendingSessions.set(sessionKey, taskId);
      }
    }
    for (const [sessionKey, taskId] of pendingSessions) {
      syncSessionMessages(taskId, sessionKey).catch((error) =>
        console.warn('[sync] Pending persistence sync failed', error),
      );
    }
  }

  async function loadAndPersistMessages(params: {
    taskId: string;
    messages: Message[];
    sessionKey: string;
    agentId?: string;
    existingMessages?: Message[];
    gatewayId: string;
    epoch: number;
  }): Promise<void> {
    const mapped: Message[] = params.messages.map((message) => ({
      ...message,
      id: crypto.randomUUID(),
      sessionKey: message.role === 'assistant' ? params.sessionKey : undefined,
      agentId: message.role === 'assistant' ? params.agentId : undefined,
    }));
    const nextMessages = params.existingMessages
      ? [...params.existingMessages, ...mapped].sort((a, b) => a.timestamp.localeCompare(b.timestamp))
      : mapped;

    deps.getMessageStore().bulkLoad(params.taskId, nextMessages);

    await persistCanonicalMessages(mapped, params, params.epoch);
  }

  async function syncFromGateway(): Promise<void> {
    const epoch = syncEpoch;
    try {
      await hydrateFromLocal();
      if (syncEpoch !== epoch) return;
      const res = await deps.gateway.syncSessions();
      if (syncEpoch !== epoch) return;
      if (!res.ok || !res.discovered) return;
      const taskStore = deps.getTaskStore();
      const discovered = res.discovered.map((d) => ({ ...d, model: sanitizeModel(d.model) }));
      taskStore.adoptTasks(discovered);

      for (const d of discovered) {
        if (syncEpoch !== epoch) return;
        await enqueueSync(d, epoch, async () => {
          await flushPendingWrites(d, epoch);
          if (syncEpoch !== epoch) return;
          const collapsedMessages = collapseDiscoveredMessages(
            d.messages.map((message: DiscoveredSyncMessage) => ({
              role: message.role,
              content: message.content,
              timestamp: message.timestamp,
              attachments: message.attachments as Message['attachments'],
              toolCalls: message.toolCalls,
              model: message.model,
            })),
            d.taskId,
          );

          taskStore.updateTaskMetadata(d.taskId, {
            model: d.model,
            modelProvider: d.modelProvider,
            thinkingLevel: d.thinkingLevel,
            inputTokens: d.inputTokens,
            outputTokens: d.outputTokens,
            contextTokens: d.contextTokens,
            // ⚠️ **必须带上**：`updateTaskMetadata` 对缺省的 `updatedAt` 会填 `new Date()`
            //    ⇒ 每启动同步一圈，就把**所有任务**的"最后活动时间"抹平成"现在"
            //    （2026-09-20 实测：42 个任务的 `updated_at` 全落在 5 毫秒里）。
            //    后果是侧栏「最近任务」按时间排序**退化成任意顺序** —— 用户最近那次对话
            //    不一定在最上面，看起来就像"聊天记录找不到了"。
            //    同步元数据（模型/用量）不是"任务又活动了"；网关报的这个值才是真的。
            updatedAt: d.updatedAt,
          });
          if (collapsedMessages.length === 0) return;

          let local = deps.getMessageStore().messagesByTask[d.taskId] ?? [];
          const hasLocalData = local.length > 0;

          if (hasLocalData) {
            await backfillAssistantAttachments(
              d.taskId,
              d.sessionKey,
              collapsedMessages.filter((message) => message.role === 'assistant'),
              d.gatewayId,
              epoch,
            );
            if (syncEpoch !== epoch) return;
            local = deps.getMessageStore().messagesByTask[d.taskId] ?? [];
            const ownerTask = deps.getTaskStore().tasks.find((task) => task.id === d.taskId);
            const localTimestamps = new Set(
              local
                .filter((m) => m.role === 'assistant' && (m.sessionKey ?? ownerTask?.sessionKey) === d.sessionKey)
                .map((m) => m.timestamp),
            );
            const newAssistantMsgs = collapsedMessages.filter(
              (message) => message.role === 'assistant' && !localTimestamps.has(message.timestamp),
            );
            if (newAssistantMsgs.length === 0) return;

            await loadAndPersistMessages({
              taskId: d.taskId,
              messages: newAssistantMsgs,
              sessionKey: d.sessionKey,
              agentId: d.agentId,
              existingMessages: local,
              gatewayId: d.gatewayId,
              epoch,
            });
          } else {
            await loadAndPersistMessages({
              taskId: d.taskId,
              messages: collapsedMessages,
              sessionKey: d.sessionKey,
              agentId: d.agentId,
              gatewayId: d.gatewayId,
              epoch,
            });
          }
        });
      }
    } catch (error) {
      if (error instanceof CanonicalPersistenceError) throw error;
      console.warn('[sync] Gateway session sync failed');
    }
  }

  function resetHydration(): void {
    hydrationPromise = null;
    syncChains.clear();
    pendingWrites.clear();
    lateTools.clear();
    syncEpoch++;
  }

  return { hydrateFromLocal, syncSessionMessages, syncFromGateway, syncRun, retrySyncPending, resetHydration };
}
