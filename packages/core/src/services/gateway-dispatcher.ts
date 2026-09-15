import { parseTaskIdFromSessionKey, isSubagentSession, isSystemSession } from '@clawwork/shared';
import type {
  ToolCall,
  ToolCallStatus,
  ModelListResponse,
  AgentListResponse,
  CommandEntry,
  CommandsListResponse,
  SkillStatusReport,
  ToolsCatalog,
} from '@clawwork/shared';
import { extractText, extractThinking, extractToolCalls, parseToolArgs } from '../protocol/parse-content.js';
import type { ChatEventPayload } from '../protocol/types.js';
import { buildAppError, formatErrorForUser, formatErrorForToast } from './error-classify.js';
import type { TranslateFn } from './error-classify.js';
import { autoTitleIfNeeded } from './auto-title.js';
import type { MessageState } from '../stores/message-store.js';
import type { GatewayTransportPort, GatewayStatusEvent } from '../ports/gateway-transport.js';

type AgentEventStream = 'lifecycle' | 'tool' | 'assistant' | 'thinking' | 'error' | 'compaction';

interface AgentToolData {
  phase?: string;
  name?: string;
  toolCallId?: string;
  meta?: string;
  isError?: boolean;
  args?: string;
}

interface AgentLifecycleData {
  phase?: 'start' | 'end' | 'error' | 'fallback';
  error?: string;
  startedAt?: number;
  endedAt?: number;
  selectedProvider?: string;
  selectedModel?: string;
  activeProvider?: string;
  activeModel?: string;
}

interface AgentErrorData {
  reason?: string;
  expected?: number;
  received?: number;
}

interface AgentCompactionData {
  phase?: 'start' | 'end';
  willRetry?: boolean;
  completed?: boolean;
}

interface AgentThinkingData {
  /** **累计快照**（不是本次增量）—— 各产出方都这么发，见下面 `case 'thinking'` 的说明。 */
  text?: string;
  /** 本次增量。 */
  delta?: string;
  /** 只有进度计数的心跳事件，没有文本。 */
  progressTokens?: number;
}

interface AgentEvent {
  sessionKey: string;
  runId?: string;
  stream?: AgentEventStream | string;
  seq?: number;
  ts?: number;
  data?: AgentToolData | AgentLifecycleData | AgentErrorData | AgentCompactionData;
}

interface SessionChangedEvent {
  sessionKey?: string;
  spawnedBy?: string;
  reason?: string;
  phase?: string;
}

interface ErrorCorrelation {
  taskId: string;
  runId?: string;
  code?: string;
  source: string;
  rawMessage: string;
  displayedAt: number;
}

type NotificationSettingKey = 'taskComplete' | 'approvalRequest' | 'gatewayDisconnect';

export interface GatewayDispatcherDeps {
  gateway: GatewayTransportPort;
  getSettings: () => Promise<{
    notifications?: { taskComplete?: boolean; approvalRequest?: boolean; gatewayDisconnect?: boolean };
  } | null>;
  sendNotification: (params: { title: string; body: string; taskId?: string }) => Promise<unknown>;

  getTaskStore: () => {
    tasks: { id: string; title: string; gatewayId: string; sessionKey: string; ensemble?: boolean }[];
    updateTaskTitle: (id: string, title: string) => void;
  };
  getMessageStore: () => Pick<
    MessageState,
    | 'messagesByTask'
    | 'activeTurnBySession'
    | 'addMessage'
    | 'upsertToolCall'
    | 'appendStreamDelta'
    | 'appendThinkingDelta'
    | 'finalizeStream'
    | 'clearActiveTurn'
    | 'setProcessing'
    | 'setRunPhase'
  >;

  getActiveTaskId: () => string | null;
  markUnread: (taskId: string) => void;

  setGatewayStatusByGateway: (gatewayId: string, status: 'connected' | 'connecting' | 'disconnected') => void;
  setGatewayVersion: (gatewayId: string, version: string | undefined) => void;
  setGatewayReconnectInfo: (gatewayId: string, info: { attempt: number; max: number; gaveUp: boolean } | null) => void;
  setDefaultGatewayId: (id: string | null) => void;
  setGatewayInfoMap: (map: Record<string, { id: string; name: string; color?: string }>) => void;
  setGatewaysLoaded: (loaded: boolean) => void;
  getGatewayInfoMap: () => Record<string, { id: string; name: string; color?: string }>;

  setModelCatalogForGateway: (gatewayId: string, models: unknown[]) => void;
  setAgentCatalogForGateway: (gatewayId: string, agents: unknown[], defaultId: string) => void;
  setToolsCatalogForGateway: (gatewayId: string, catalog: ToolsCatalog) => void;
  setSkillsStatusForGateway: (gatewayId: string, report: SkillStatusReport) => void;
  setCommandCatalogForGateway: (gatewayId: string, commands: CommandEntry[]) => void;

  onPerformerCandidate?: (taskId: string, sessionKey: string, gatewayId: string) => void;
  lookupTaskIdBySubagentKey?: (subagentKey: string) => string | undefined;
  onSubagentCandidate?: (sessionKey: string, gatewayId: string) => void;
  onApprovalRequested?: (gatewayId: string, approval: unknown) => void;
  onApprovalResolved?: (id: string) => void;
  notifyAgentResponse?: (sessionKey: string) => void;
  onToast?: (type: 'error' | 'warning' | 'success', title: string, opts?: { description?: string }) => void;
  translate: TranslateFn;
  isWindowFocused: () => boolean;
  reportDebugEvent: (event: {
    domain: string;
    event: string;
    traceId?: string;
    feature?: string;
    data?: Record<string, unknown>;
  }) => void;

  hydrateFromLocal: () => Promise<void>;
  syncFromGateway: () => Promise<void>;
  syncSessionMessages: (taskId: string, sessionKeyOverride?: string) => Promise<void>;
  retrySyncPending: () => void;
}

const DEDUP_FALLBACK_WINDOW_MS = 2000;
const SESSION_DELETE_REASONS = new Set(['delete', 'deleted', 'session-delete']);

/**
 * 空目录的退避重试间隔（ms）。
 *
 * 网关的 `models.list` 对目录加载有 **750ms 超时**，超时后直接返回空目录
 * （openclaw `dist/model-catalog-browse-*.mjs`：`return { entries: [], routeVariants: [] }`；
 * 它打的日志 "using the prepared catalog when available" 会让人以为退了缓存，其实没有）。
 * 而中转目录要联网拉，网关刚 ready 时往往还没热 —— 客户端一重连就撞上，
 * 拿到空目录**当最终结果缓存下来**，模型下拉就会一直显示「暂无可用模型」。
 * 所以空目录不算数，退避再问几次；问完还是空才认。
 *
 * ⚠️ 预算按实测定：2026-09-11 实测，冷启动的网关目录要 **30~45 秒**才热；
 * 在那之前每次 `models.list` 都恰好等满 750ms 再超时，所以退避得太密是白搭
 *（试过 1s/2s/4s 的版本，三次重试全撞在 757ms 上，最后还是空）。
 * 下面这串累计约 60 秒，覆盖整个冷启动窗口。
 */
const CATALOG_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000, 30000];

/**
 * `run_status` 的 phase 是**闭集** —— openclaw `resolveRunStartupPhase` 把内部更细的
 * 阶段归并成对外这 3 个（`tool_execution_started` / `assistant_output_started` 不产出）。
 * 所以映射表可以写死；认不出的 phase 也要显示，不能丢。
 */
const RUN_STARTUP_PHASES = new Set(['preparing_workspace', 'preparing_context', 'starting_model']);

/** 供界面判断「这个 phase 有没有对应的文案」，没有就显示泛化的「正在准备…」。 */
export const RUN_PHASE_IDS: readonly string[] = [...RUN_STARTUP_PHASES];

/**
 * 未知事件种类的告警阈值。
 *
 * 这类问题**会反复出现**：网关的事件种类比我们的 `switch` 多 ——
 * `run_status`（首条消息 9 秒空白）和定时任务的 `heartbeat`（整页白屏）都是这么漏掉的。
 * 静默丢弃一次就够查半天，所以一分钟内累计超阈值就单独上报一条，好在遥测里被发现。
 */
const UNKNOWN_STREAM_ALERT_THRESHOLD = 10;
const UNKNOWN_STREAM_WINDOW_MS = 60_000;

export function createGatewayDispatcher(deps: GatewayDispatcherDeps) {
  const perTaskLastError = new Map<string, ErrorCorrelation>();
  const lifecycleErrorBuffer = new Map<
    string,
    { error: string; runId?: string; timer: ReturnType<typeof setTimeout> }
  >();
  const abortedByUser = new Set<string>();
  const connectedGateways = new Set<string>();
  /** 每个网关最多一个待执行的目录重试定时器（重连/成功后旧的作废）。 */
  const catalogRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let synced = false;

  let unknownStreamWindowStart = 0;
  let unknownStreamCount = 0;

  /** 未知事件种类计数；超阈值时额外上报一条，避免它们永远只躺在 debug 日志里。 */
  function noteUnknownStream(stream: string | undefined, taskId: string, sessionKey: string): void {
    const now = Date.now();
    if (now - unknownStreamWindowStart > UNKNOWN_STREAM_WINDOW_MS) {
      unknownStreamWindowStart = now;
      unknownStreamCount = 0;
    }
    unknownStreamCount += 1;
    if (unknownStreamCount === UNKNOWN_STREAM_ALERT_THRESHOLD) {
      deps.reportDebugEvent({
        domain: 'renderer',
        event: 'renderer.agent.unknown_stream.threshold',
        data: { stream, count: unknownStreamCount, windowMs: UNKNOWN_STREAM_WINDOW_MS, taskId, sessionKey },
      });
    }
  }

  function debugEvent(
    event: string,
    data: Record<string, unknown>,
    extra?: { traceId?: string; feature?: string },
  ): void {
    console.debug(`[debug] ${event}`, data);
    deps.reportDebugEvent({ domain: 'renderer', event, traceId: extra?.traceId, feature: extra?.feature, data });
  }

  function maybeNotify(
    settingKey: NotificationSettingKey,
    params: { title: string; body: string; taskId?: string },
  ): void {
    deps
      .getSettings()
      .then((settings) => {
        if (settings?.notifications?.[settingKey] === false) return;
        deps.sendNotification(params);
      })
      .catch((err) => console.error('[gateway-dispatcher] getSettings failed:', err));
  }

  function isSameFailure(a: ErrorCorrelation, existing: ErrorCorrelation): boolean {
    if (a.taskId !== existing.taskId) return false;
    if (a.runId && existing.runId) return a.runId === existing.runId;
    if (a.code && existing.code) return a.code === existing.code && a.source === existing.source;
    return false;
  }

  function shouldDisplayError(correlation: ErrorCorrelation): boolean {
    const existing = perTaskLastError.get(correlation.taskId);
    if (!existing) return true;
    if (isSameFailure(correlation, existing)) return false;
    if (Date.now() - existing.displayedAt < DEDUP_FALLBACK_WINDOW_MS) {
      if (
        !correlation.runId &&
        !existing.runId &&
        !correlation.code &&
        !existing.code &&
        correlation.source === existing.source &&
        correlation.rawMessage === existing.rawMessage
      )
        return false;
    }
    return true;
  }

  function recordDisplayedError(correlation: ErrorCorrelation): void {
    perTaskLastError.set(correlation.taskId, { ...correlation, displayedAt: Date.now() });
  }

  function clearTaskErrorState(taskId: string): void {
    perTaskLastError.delete(taskId);
    abortedByUser.delete(taskId);
    const buffered = lifecycleErrorBuffer.get(taskId);
    if (buffered) {
      clearTimeout(buffered.timer);
      lifecycleErrorBuffer.delete(taskId);
    }
  }

  function resolveTaskId(sessionKey: string): string | null {
    const direct = parseTaskIdFromSessionKey(sessionKey);
    if (direct) return direct;
    const mapped = deps.lookupTaskIdBySubagentKey?.(sessionKey);
    return mapped ?? null;
  }

  function resolveTaskIdFromSpawnedBy(spawnedBy?: string): string | null {
    if (!spawnedBy) return null;
    const mapped = deps.lookupTaskIdBySubagentKey?.(spawnedBy);
    if (mapped) return mapped;
    return parseTaskIdFromSessionKey(spawnedBy);
  }

  function handleChatEvent(payload: ChatEventPayload, gatewayId: string): void {
    const { sessionKey, state } = payload;
    if (!sessionKey) {
      debugEvent('renderer.event.dropped.missing_session', { state });
      return;
    }

    if (isSystemSession(sessionKey)) return;

    const taskId = resolveTaskId(sessionKey);
    if (!taskId) {
      if (isSubagentSession(sessionKey)) {
        deps.onSubagentCandidate?.(sessionKey, gatewayId);
        debugEvent('renderer.event.subagent_candidate', { gatewayId, sessionKey, state });
      } else {
        debugEvent('renderer.event.dropped.invalid_task', { sessionKey, state });
      }
      return;
    }

    const localTasks = deps.getTaskStore().tasks;
    const matchedTask = localTasks.find((t) => t.id === taskId);
    if (!matchedTask) {
      debugEvent('renderer.event.dropped.unknown_task', { taskId, sessionKey, state });
      return;
    }

    if (matchedTask.ensemble && sessionKey !== matchedTask.sessionKey) {
      deps.onPerformerCandidate?.(taskId, sessionKey, matchedTask.gatewayId);
    }

    if (taskId !== deps.getActiveTaskId()) {
      deps.markUnread(taskId);
    }

    deps.notifyAgentResponse?.(sessionKey);

    const store = deps.getMessageStore();
    const text = extractText(payload);
    const thinking = extractThinking(payload);

    if (state === 'delta') {
      clearTaskErrorState(taskId);
      if (text) {
        store.setProcessing(sessionKey, false);
        store.appendStreamDelta(sessionKey, text);
        debugEvent('renderer.chat.delta.applied', { taskId, sessionKey, chars: text.length });
      }
      if (thinking) {
        store.appendThinkingDelta(sessionKey, thinking);
      }
      const toolCalls = extractToolCalls(payload);
      for (const tc of toolCalls) {
        store.upsertToolCall(sessionKey, taskId, tc);
      }
    } else if (state === 'final') {
      store.setProcessing(sessionKey, false);
      if (text) store.appendStreamDelta(sessionKey, text);
      if (thinking) store.appendThinkingDelta(sessionKey, thinking);
      debugEvent('renderer.chat.final.received', { taskId, sessionKey, chars: text.length });
      const toolCalls = extractToolCalls(payload);
      for (const tc of toolCalls) {
        store.upsertToolCall(sessionKey, taskId, tc);
      }
      store.finalizeStream(sessionKey, { runId: payload.runId });
      debugEvent('renderer.chat.finalized', { taskId, sessionKey });
      autoTitleIfNeeded(taskId, sessionKey, deps.getTaskStore, deps.getMessageStore);
      if (!deps.isWindowFocused() || deps.getActiveTaskId() !== taskId) {
        const task = deps.getTaskStore().tasks.find((t) => t.id === taskId);
        maybeNotify('taskComplete', {
          title: deps.translate('notifications.taskComplete'),
          body: task?.title || taskId,
          taskId,
        });
      }
      deps.syncSessionMessages(taskId, sessionKey).catch((err) => {
        debugEvent('renderer.sync.post-final.failed', {
          taskId,
          sessionKey,
          error: err instanceof Error ? err.message : 'unknown',
        });
      });
    } else if (state === 'error') {
      store.setProcessing(sessionKey, false);
      store.clearActiveTurn(sessionKey);

      const errorCode = payload.errorCode ?? payload.error?.code;
      const rawMessage =
        payload.errorMessage ??
        payload.error?.message ??
        (extractText(payload) || deps.translate('errors.requestFailed'));

      debugEvent('renderer.chat.error', { taskId, sessionKey, rawMessage, code: errorCode, runId: payload.runId });

      if (isSubagentSession(sessionKey) && /^\s*terminated\s*$/i.test(rawMessage)) {
        debugEvent('renderer.chat.subagent_terminated', { taskId, sessionKey });
        return;
      }

      const buffered = lifecycleErrorBuffer.get(taskId);
      if (buffered) {
        clearTimeout(buffered.timer);
        lifecycleErrorBuffer.delete(taskId);
      }

      const errorDetails = payload.error?.details;
      const appError = buildAppError({
        source: 'upstream',
        stage: 'stream',
        rawMessage,
        code: errorCode,
        details: errorDetails,
      });
      const correlation: ErrorCorrelation = {
        taskId,
        runId: payload.runId,
        code: errorCode,
        source: 'upstream',
        rawMessage,
        displayedAt: 0,
      };

      if (shouldDisplayError(correlation)) {
        const userText = formatErrorForUser(appError, deps.translate);
        store.addMessage(taskId, 'system', userText, undefined, { sessionKey });
        const { title, description } = formatErrorForToast(appError, deps.translate);
        deps.onToast?.('error', title, { description });
        recordDisplayedError(correlation);
      }
    } else if (state === 'aborted') {
      store.setProcessing(sessionKey, false);
      store.clearActiveTurn(sessionKey);
      debugEvent('renderer.chat.aborted', { taskId, sessionKey, userInitiated: abortedByUser.has(taskId) });

      if (!abortedByUser.has(taskId)) {
        store.addMessage(
          taskId,
          'system',
          deps.translate('errors.serverAborted', { defaultValue: 'Task interrupted by server' }),
          undefined,
          { sessionKey },
        );
      }
    }
  }

  function handleAgentEvent(payload: AgentEvent, gatewayId: string): void {
    const { sessionKey, stream, data } = payload;
    if (!sessionKey || !data) {
      debugEvent('renderer.agent.dropped.missing_fields', {
        stream,
        hasData: Boolean(data),
        hasSessionKey: Boolean(sessionKey),
      });
      return;
    }

    if (isSystemSession(sessionKey)) return;

    const taskId = resolveTaskId(sessionKey);
    if (!taskId) {
      if (isSubagentSession(sessionKey)) {
        deps.onSubagentCandidate?.(sessionKey, gatewayId);
        debugEvent('renderer.agent.subagent_candidate', { gatewayId, sessionKey, stream });
      } else {
        debugEvent('renderer.agent.dropped.invalid_task', { sessionKey, stream });
      }
      return;
    }

    const localTasks = deps.getTaskStore().tasks;
    const agentTask = localTasks.find((t) => t.id === taskId);
    if (!agentTask) {
      debugEvent('renderer.agent.dropped.unknown_task', { taskId, sessionKey, stream });
      return;
    }

    if (agentTask.ensemble && sessionKey !== agentTask.sessionKey) {
      deps.onPerformerCandidate?.(taskId, sessionKey, agentTask.gatewayId);
    }

    switch (stream) {
      case 'tool':
        handleAgentToolStream(taskId, sessionKey, data as AgentToolData);
        break;
      case 'lifecycle':
        handleAgentLifecycleStream(taskId, sessionKey, data as AgentLifecycleData);
        break;
      case 'error':
        handleAgentErrorStream(taskId, sessionKey, data as AgentErrorData);
        break;
      case 'assistant':
        debugEvent('renderer.agent.assistant_stream', { taskId, sessionKey });
        break;
      case 'thinking': {
        // 模型的推理输出走的是 **agent 通道**，此前被 default 当未知整段丢掉。
        // ⚠️ chat 通道**补不回来**：网关只在 `evt.stream === "assistant"` 时才 emitChatDelta
        //（openclaw `server-chat-*.mjs`），final 的 `message.content` 也从不含 thinking 块 ——
        // 所以 `extractThinking` 那条路在这条链路上一次都不会触发，必须在这里接。
        // 最坏情形实测过：`content` 为空、整条回复都在 `reasoning_content` 里，
        // 界面上一个字都看不到，而账照扣。
        //
        // 喂 `text`（累计快照）而不是 `delta`：store 的 `mergeGatewayStreamText` 对快照幂等，
        // 重复投递（重连 / 重订阅）不会把推理拼成两遍，而纯增量会。
        const reasoning = data as AgentThinkingData;
        const chunk = reasoning.text || reasoning.delta || '';
        // `{progressTokens}` 的进度心跳和空事件都不产出文本。
        if (!chunk) break;
        deps.getMessageStore().appendThinkingDelta(sessionKey, chunk);
        debugEvent('renderer.agent.thinking', { taskId, sessionKey, chars: chunk.length });
        break;
      }
      case 'compaction':
        debugEvent('renderer.agent.compaction', {
          taskId,
          sessionKey,
          phase: (data as AgentCompactionData).phase,
          completed: (data as AgentCompactionData).completed,
        });
        break;
      case 'run_status': {
        // 网关在报「这一轮走到哪一步了」。从前没有这个分支，事件被当未知的丢掉，
        // 于是首条消息有 9 秒界面毫无反应（用户报的「响应太慢」就是这么来的）。
        const phase = (data as Record<string, unknown>)?.phase;
        if (typeof phase === 'string' && phase) {
          deps.getMessageStore().setRunPhase(sessionKey, phase);
          debugEvent('renderer.agent.run_status', {
            taskId,
            sessionKey,
            phase,
            known: RUN_STARTUP_PHASES.has(phase),
          });
        }
        break;
      }
      default:
        debugEvent('renderer.agent.unknown_stream', {
          taskId,
          sessionKey,
          stream,
          topLevelKeys: data ? Object.keys(data) : [],
          phase: (data as Record<string, unknown>)?.phase,
          reason: (data as Record<string, unknown>)?.reason,
        });
        noteUnknownStream(stream, taskId, sessionKey);
        break;
    }
  }

  function handleSessionChangedEvent(payload: SessionChangedEvent, gatewayId: string): void {
    const { sessionKey, spawnedBy, reason, phase } = payload;
    if (!sessionKey) {
      debugEvent('renderer.session.dropped.missing_session', { gatewayId, reason, phase });
      return;
    }

    if (isSystemSession(sessionKey) || !isSubagentSession(sessionKey)) return;

    if (reason && SESSION_DELETE_REASONS.has(reason)) {
      debugEvent('renderer.session.ignored.delete', { gatewayId, sessionKey, reason });
      return;
    }

    const taskId = resolveTaskIdFromSpawnedBy(spawnedBy);
    if (!taskId) {
      debugEvent('renderer.session.subagent_unresolved', { gatewayId, sessionKey, spawnedBy, reason, phase });
      return;
    }

    const localTasks = deps.getTaskStore().tasks;
    const matchedTask = localTasks.find((t) => t.id === taskId);
    if (!matchedTask) {
      debugEvent('renderer.session.dropped.unknown_task', { taskId, sessionKey, reason, phase });
      return;
    }

    if (!matchedTask.ensemble || sessionKey === matchedTask.sessionKey) return;

    deps.onPerformerCandidate?.(taskId, sessionKey, matchedTask.gatewayId);
    debugEvent('renderer.session.performer_candidate', { taskId, sessionKey, spawnedBy, reason, phase });
  }

  function handleAgentToolStream(taskId: string, sessionKey: string, data: AgentToolData): void {
    if (!data.name || !data.toolCallId) return;

    deps.notifyAgentResponse?.(sessionKey);

    if (taskId !== deps.getActiveTaskId()) {
      deps.markUnread(taskId);
    }

    let status: ToolCallStatus = 'running';
    if (data.phase === 'result') status = data.isError ? 'error' : 'done';
    else if (data.phase === 'error') status = 'error';

    const tc: ToolCall = {
      id: data.toolCallId,
      name: data.name,
      status,
      args: parseToolArgs(data.args),
      result: data.meta,
      startedAt: data.phase === 'update' ? new Date().toISOString() : '',
      completedAt: status !== 'running' ? new Date().toISOString() : undefined,
    };

    const store = deps.getMessageStore();
    const existingMsgs = store.messagesByTask[taskId] ?? [];
    for (let i = existingMsgs.length - 1; i >= 0; i--) {
      const existing = existingMsgs[i].toolCalls.find((t) => t.id === tc.id);
      if (existing) {
        tc.startedAt = existing.startedAt;
        break;
      }
    }
    if (!tc.startedAt) tc.startedAt = new Date().toISOString();

    store.upsertToolCall(sessionKey, taskId, tc);
    debugEvent('renderer.toolcall.upserted', {
      taskId,
      sessionKey,
      toolCallId: tc.id,
      status: tc.status,
      name: tc.name,
    });
  }

  function handleAgentLifecycleStream(taskId: string, sessionKey: string, data: AgentLifecycleData): void {
    const store = deps.getMessageStore();

    switch (data.phase) {
      case 'start':
        deps.notifyAgentResponse?.(sessionKey);
        store.setProcessing(sessionKey, true);
        // ⚠️ 这里**不**清 run phase：实测 `starting_model` 会在 lifecycle.start **之后**才到
        //（2026-09-11 实测：start 7.5s、starting_model 7.6s），清了会被立刻覆盖回去。
        // 相位统一在 end / error 清，既没有竞态，也如实反映「这一轮在干什么」。
        debugEvent('renderer.agent.lifecycle.start', { taskId, sessionKey });
        break;
      case 'end':
        store.setProcessing(sessionKey, false);
        store.setRunPhase(sessionKey, null);
        debugEvent('renderer.agent.lifecycle.end', { taskId, sessionKey });
        break;
      case 'error': {
        store.setProcessing(sessionKey, false);
        store.setRunPhase(sessionKey, null);
        debugEvent('renderer.agent.lifecycle.error', { taskId, sessionKey, error: data.error });
        if (!data.error) break;

        const existing = lifecycleErrorBuffer.get(taskId);
        if (existing) clearTimeout(existing.timer);

        const timer = setTimeout(() => {
          lifecycleErrorBuffer.delete(taskId);
          const errorText = data.error!;
          const appError = buildAppError({ source: 'agent', stage: 'lifecycle', rawMessage: errorText });
          const correlation: ErrorCorrelation = {
            taskId,
            runId: undefined,
            source: 'agent',
            rawMessage: errorText,
            displayedAt: 0,
          };
          if (shouldDisplayError(correlation)) {
            store.addMessage(taskId, 'system', formatErrorForUser(appError, deps.translate), undefined, {
              sessionKey,
            });
            const { title, description } = formatErrorForToast(appError, deps.translate);
            deps.onToast?.('error', title, { description });
            recordDisplayedError(correlation);
          }
        }, DEDUP_FALLBACK_WINDOW_MS);

        lifecycleErrorBuffer.set(taskId, { error: data.error, timer });
        break;
      }
      case 'fallback':
        debugEvent('renderer.agent.lifecycle.fallback', {
          taskId,
          sessionKey,
          from: `${data.selectedProvider}/${data.selectedModel}`,
          to: `${data.activeProvider}/${data.activeModel}`,
        });
        if (data.activeModel) {
          const msg = deps.translate('agent.modelFallback', {
            model: data.activeModel,
            defaultValue: `Switched to model: ${data.activeModel}`,
          });
          store.addMessage(taskId, 'system', msg, undefined, { persist: false, sessionKey });
        }
        break;
    }
  }

  function handleAgentErrorStream(taskId: string, sessionKey: string, data: AgentErrorData): void {
    debugEvent('renderer.agent.stream_error', {
      taskId,
      sessionKey,
      reason: data.reason,
      expected: data.expected,
      received: data.received,
    });
  }

  function cancelCatalogRetry(gatewayId: string): void {
    const timer = catalogRetryTimers.get(gatewayId);
    if (timer !== undefined) {
      clearTimeout(timer);
      catalogRetryTimers.delete(gatewayId);
    }
  }

  function scheduleCatalogRetry(gatewayId: string, attempt: number): void {
    cancelCatalogRetry(gatewayId);
    const timer = setTimeout(() => {
      catalogRetryTimers.delete(gatewayId);
      void refetchModelsCatalog(gatewayId, attempt + 1);
    }, CATALOG_RETRY_DELAYS_MS[attempt]);
    catalogRetryTimers.set(gatewayId, timer);
  }

  /** 落目录。空目录先不当真 —— 理由见 CATALOG_RETRY_DELAYS_MS。 */
  function applyModelsCatalog(gatewayId: string, models: unknown[], attempt: number): void {
    if (models.length > 0) {
      cancelCatalogRetry(gatewayId);
      deps.setModelCatalogForGateway(gatewayId, models);
      return;
    }
    if (attempt >= CATALOG_RETRY_DELAYS_MS.length) {
      // 退避用完还是空：当作真的没有模型，让界面如实显示「暂无可用模型」。
      deps.setModelCatalogForGateway(gatewayId, models);
      return;
    }
    scheduleCatalogRetry(gatewayId, attempt);
  }

  async function refetchModelsCatalog(gatewayId: string, attempt: number): Promise<void> {
    try {
      const res = await deps.gateway.listModels(gatewayId);
      if (res.ok && res.result) {
        const data = res.result as unknown as ModelListResponse;
        if (data.models) applyModelsCatalog(gatewayId, data.models, attempt);
      }
    } catch {
      console.warn('[catalogs] Failed to refetch models for gateway', gatewayId);
    }
  }

  async function fetchCatalogs(gatewayId: string): Promise<void> {
    try {
      const [modelsRes, agentsRes, toolsRes, skillsRes, commandsRes] = await Promise.all([
        deps.gateway.listModels(gatewayId),
        deps.gateway.listAgents(gatewayId),
        deps.gateway.getToolsCatalog(gatewayId),
        deps.gateway.getSkillsStatus(gatewayId),
        deps.gateway.listCommands(gatewayId, { scope: 'text', includeArgs: true }),
      ]);
      if (modelsRes.ok && modelsRes.result) {
        const data = modelsRes.result as unknown as ModelListResponse;
        if (data.models) applyModelsCatalog(gatewayId, data.models, 0);
      }
      if (agentsRes.ok && agentsRes.result) {
        const data = agentsRes.result as unknown as AgentListResponse;
        if (data.agents) deps.setAgentCatalogForGateway(gatewayId, data.agents, data.defaultId);
      }
      if (toolsRes.ok && toolsRes.result) {
        const data = toolsRes.result as unknown as ToolsCatalog;
        if (data.groups) deps.setToolsCatalogForGateway(gatewayId, data);
      }
      if (skillsRes.ok && skillsRes.result) {
        const data = skillsRes.result as unknown as SkillStatusReport;
        if (Array.isArray(data.skills)) deps.setSkillsStatusForGateway(gatewayId, data);
      }
      if (commandsRes.ok && commandsRes.result) {
        const data = commandsRes.result as unknown as CommandsListResponse;
        if (Array.isArray(data.commands)) {
          deps.setCommandCatalogForGateway(gatewayId, data.commands);
        }
      }
    } catch (err) {
      console.warn('[catalogs] Failed to fetch catalogs for gateway', gatewayId, err);
    }
  }

  function markAbortedByUser(taskId: string): void {
    abortedByUser.add(taskId);
  }

  async function fetchAgentsForGateway(
    gatewayId: string,
    agentCatalogByGateway: Record<string, unknown>,
    options: { force?: boolean } = {},
  ): Promise<void> {
    if (!options.force && agentCatalogByGateway[gatewayId]) return;
    try {
      const res = await deps.gateway.listAgents(gatewayId);
      if (res.ok && res.result) {
        const data = res.result as unknown as AgentListResponse;
        if (data.agents) deps.setAgentCatalogForGateway(gatewayId, data.agents, data.defaultId);
      }
    } catch {
      console.warn('[catalogs] Failed to fetch agents for gateway', gatewayId);
    }
  }

  function start(): () => void {
    const removeGatewayEvent = deps.gateway.onGatewayEvent((data) => {
      debugEvent('renderer.gateway.event.received', {
        gatewayId: data.gatewayId,
        event: data.event,
        payloadKeys: Object.keys(data.payload ?? {}),
      });
      if (data.event === 'chat') {
        handleChatEvent(data.payload as unknown as ChatEventPayload, data.gatewayId);
      } else if (data.event === 'agent') {
        handleAgentEvent(data.payload as unknown as AgentEvent, data.gatewayId);
      } else if (data.event === 'sessions.changed') {
        handleSessionChangedEvent(data.payload as SessionChangedEvent, data.gatewayId);
      } else if (data.event === 'exec.approval.requested') {
        deps.onApprovalRequested?.(data.gatewayId, data.payload);
      } else if (data.event === 'exec.approval.resolved') {
        deps.onApprovalResolved?.((data.payload as { id: string }).id);
      }
    });

    return removeGatewayEvent;
  }

  async function initialize(): Promise<void> {
    deps.hydrateFromLocal();

    deps.gateway.gatewayStatus().then((statusMap) => {
      for (const [gwId, info] of Object.entries(statusMap)) {
        const status = info.connected
          ? ('connected' as const)
          : info.error
            ? ('disconnected' as const)
            : ('connecting' as const);
        deps.setGatewayStatusByGateway(gwId, status);
        if (info.serverVersion) deps.setGatewayVersion(gwId, info.serverVersion);
        if (info.connected) connectedGateways.add(gwId);
      }
      if (connectedGateways.size > 0 && !synced) {
        synced = true;
        deps.syncFromGateway();
        for (const gwId of connectedGateways) fetchCatalogs(gwId);
      }
    });

    deps.gateway.listGateways().then((gateways) => {
      const defaultGw = gateways.find((g) => g.isDefault);
      if (defaultGw) deps.setDefaultGatewayId(defaultGw.id);
      else if (gateways.length > 0) deps.setDefaultGatewayId(gateways[0].id);
      const infoMap: Record<string, { id: string; name: string; color?: string }> = {};
      for (const gw of gateways) {
        infoMap[gw.id] = { id: gw.id, name: gw.name, color: gw.color };
      }
      deps.setGatewayInfoMap(infoMap);
      deps.setGatewaysLoaded(true);
    });
  }

  function handleGatewayStatus(s: GatewayStatusEvent): void {
    const wasConnected = connectedGateways.has(s.gatewayId);
    const next = s.connected ? ('connected' as const) : s.error ? ('disconnected' as const) : ('connecting' as const);
    deps.setGatewayStatusByGateway(s.gatewayId, next);
    deps.setGatewayVersion(s.gatewayId, s.serverVersion);

    if (s.reconnectAttempt !== undefined && s.maxAttempts !== undefined) {
      deps.setGatewayReconnectInfo(s.gatewayId, {
        attempt: s.reconnectAttempt,
        max: s.maxAttempts,
        gaveUp: s.gaveUp ?? false,
      });
    } else if (s.connected) {
      deps.setGatewayReconnectInfo(s.gatewayId, null);
    }

    if (s.connected && !wasConnected) {
      connectedGateways.add(s.gatewayId);
      deps.onToast?.('success', deps.translate('connection.reconnected'));
      if (!synced) {
        synced = true;
        deps.syncFromGateway();
      }
      deps.retrySyncPending();
      fetchCatalogs(s.gatewayId);
    } else if (!s.connected && wasConnected) {
      connectedGateways.delete(s.gatewayId);
      deps.onToast?.('warning', deps.translate('connection.lostConnection'), {
        description: deps.translate('connection.reconnecting'),
      });
      const gwInfo = deps.getGatewayInfoMap()[s.gatewayId];
      maybeNotify('gatewayDisconnect', {
        title: deps.translate('notifications.gatewayDisconnected'),
        body: gwInfo?.name || s.gatewayId,
      });
    }
  }

  function startGatewayStatus(): () => void {
    return deps.gateway.onGatewayStatus(handleGatewayStatus);
  }

  function reset(): void {
    perTaskLastError.clear();
    for (const b of lifecycleErrorBuffer.values()) clearTimeout(b.timer);
    lifecycleErrorBuffer.clear();
    abortedByUser.clear();
    connectedGateways.clear();
    for (const timer of catalogRetryTimers.values()) clearTimeout(timer);
    catalogRetryTimers.clear();
    synced = false;
  }

  return { start, initialize, startGatewayStatus, markAbortedByUser, fetchAgentsForGateway, reset };
}
