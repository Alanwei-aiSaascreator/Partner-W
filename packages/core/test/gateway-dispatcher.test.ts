import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createGatewayDispatcher,
  DELIBERATELY_IGNORED_STREAMS,
  ITEM_FAILURE_STATUSES,
  ITEM_PHASE_IDS,
  ITEM_STATUS_IDS,
  RETRY_RUN_PHASE,
  RUN_PHASE_IDS,
  SESSION_CHANGE_REASONS,
  TOOL_IGNORED_PHASES,
  TOOL_PHASE_IDS,
  UNWIRED_APPROVAL_EVENTS,
  WIRED_APPROVAL_EVENTS,
  type GatewayDispatcherDeps,
} from '../src/services/gateway-dispatcher.js';
import type { GatewayEvent, GatewayStatusEvent, RuntimeStatusEvent } from '../src/ports/gateway-transport.js';
import type { ChatEventPayload } from '../src/protocol/types.js';

type EventListener = (data: GatewayEvent) => void;

const TASK = {
  id: 'task-1',
  title: 'Task',
  gatewayId: 'gw-1',
  sessionKey: 'agent:main:clawwork:task:task-1',
};

const DEDUP_FALLBACK_WINDOW_MS = 2000;

function createHarness() {
  let listener: EventListener | null = null;
  let statusListener: ((status: GatewayStatusEvent) => void) | null = null;
  let runtimeStatusListener: ((status: RuntimeStatusEvent) => void) | null = null;

  const systemMessages: Array<{ taskId: string; content: string; sessionKey?: string }> = [];
  const toasts: Array<{ type: string; title: string; description?: string }> = [];

  const messageStore = {
    messagesByTask: {} as Record<string, unknown[]>,
    activeTurnBySession: {} as Record<string, unknown>,
    addMessage: vi.fn(
      (taskId: string, _role: string, content: string, _attachments?: unknown, options?: { sessionKey?: string }) => {
        systemMessages.push({ taskId, content, sessionKey: options?.sessionKey });
        return { id: 'msg-1', taskId, role: _role, content, artifacts: [], toolCalls: [], timestamp: '' };
      },
    ),
    upsertToolCall: vi.fn(),
    appendStreamDelta: vi.fn(),
    appendThinkingDelta: vi.fn(),
    finalizeStream: vi.fn(),
    clearActiveTurn: vi.fn(),
    setProcessing: vi.fn(),
    setRunPhase: vi.fn(),
    setSessionProgressText: vi.fn(),
    // ⭐ B8：压缩那三个**真的实现**（不是空 vi.fn()）—— 去重/幂等是要被断言的行为，
    //    桩成空函数的话"报两次"这种 bug 在测试里根本看不出来。
    compactionAnnouncedEpisodeBySession: {} as Record<string, number>,
    compactionEpisodeBySession: {} as Record<string, number>,
    compactingBySession: {} as Record<string, boolean>,
    setSessionCompacting: vi.fn(),
    beginCompactionEpisode: vi.fn((sessionKey: string) => {
      const next = (messageStore.compactionEpisodeBySession[sessionKey] ?? 0) + 1;
      messageStore.compactionEpisodeBySession[sessionKey] = next;
      return next;
    }),
    ensureCompactionEpisode: vi.fn((sessionKey: string) => {
      return messageStore.compactionEpisodeBySession[sessionKey] ?? messageStore.beginCompactionEpisode(sessionKey);
    }),
    announceCompactionOnce: vi.fn((taskId: string, sessionKey: string, episode: number, text: string) => {
      if ((messageStore.compactionAnnouncedEpisodeBySession[sessionKey] ?? 0) >= episode) return false;
      messageStore.compactionAnnouncedEpisodeBySession[sessionKey] = episode;
      messageStore.addMessage(taskId, 'system', text, undefined, { sessionKey });
      return true;
    }),
    /** 临时会话（多模型对比的一列）的失败走这条旁路，不进时间线。 */
    setSessionError: vi.fn(),
    /** delta 的 `replace` 语义要用它（见 `extractDeltaText`）。 */
    replaceStreamText: vi.fn(),
    /** B10：可重试错误的登记（界面据此给「重试」按钮）。 */
    markRetryableError: vi.fn(),
    /** 包 D：自动重试候选的登记（界面据此决定要不要自动重发一次）。 */
    markAutoRetryFailure: vi.fn(),
  };

  const deps: GatewayDispatcherDeps = {
    gateway: {
      onGatewayEvent: (cb: EventListener) => {
        listener = cb;
        return () => {
          listener = null;
        };
      },
      onGatewayStatus: (cb: (status: GatewayStatusEvent) => void) => {
        statusListener = cb;
        return () => {
          statusListener = null;
        };
      },
      onRuntimeStatus: (cb: (status: RuntimeStatusEvent) => void) => {
        runtimeStatusListener = cb;
        return () => {
          runtimeStatusListener = null;
        };
      },
      gatewayStatus: async () => ({}),
      listGateways: async () => [],
      listModels: async () => ({ ok: true, result: {} }),
      listAgents: async () => ({ ok: true, result: { defaultId: 'main', agents: [{ id: 'main' }] } }),
      getToolsCatalog: async () => ({ ok: true, result: {} }),
      getSkillsStatus: async () => ({ ok: true, result: {} }),
      listCommands: async () => ({ ok: true, result: {} }),
      chatHistory: async () => ({ ok: true, result: {} }),
      abortChat: async () => ({ ok: true }),
      patchSession: async () => ({ ok: true }),
      listSessionsBySpawner: async () => ({ ok: true }),
      syncSessions: async () => ({ ok: true }),
      sendMessage: async () => ({ ok: true }),
      createSession: async () => ({ ok: true }),
    } as unknown as GatewayDispatcherDeps['gateway'],
    getSettings: async () => null,
    sendNotification: async () => {},
    getTaskStore: () => ({
      tasks: [TASK],
      updateTaskTitle: vi.fn(),
    }),
    getMessageStore: () => messageStore as unknown as ReturnType<GatewayDispatcherDeps['getMessageStore']>,
    getActiveTaskId: () => null,
    markUnread: vi.fn(),
    setGatewayStatusByGateway: vi.fn(),
    setGatewayVersion: vi.fn(),
    setGatewayMaxPayloadByGateway: vi.fn(),
    setGatewayReconnectInfo: vi.fn(),
    setRuntimeBootstrapFailure: vi.fn(),
    setDefaultGatewayId: vi.fn(),
    setGatewayInfoMap: vi.fn(),
    setGatewaysLoaded: vi.fn(),
    getGatewayInfoMap: () => ({}),
    setModelCatalogForGateway: vi.fn(),
    setModelCatalogFailureForGateway: vi.fn(),
    setAgentCatalogForGateway: vi.fn(),
    setToolsCatalogForGateway: vi.fn(),
    setEffectiveToolsState: vi.fn(),
    setSkillsStatusForGateway: vi.fn(),
    setCommandCatalogForGateway: vi.fn(),
    onToast: vi.fn((type: string, title: string, opts?: { description?: string }) => {
      toasts.push({ type, title, description: opts?.description });
    }),
    translate: (key: string) => key,
    isWindowFocused: () => true,
    reportDebugEvent: vi.fn(),
    hydrateFromLocal: async () => {},
    syncFromGateway: async () => {},
    syncSessionMessages: vi.fn(async () => {}),
    retrySyncPending: vi.fn(),
  };

  const dispatcher = createGatewayDispatcher(deps);
  dispatcher.start();

  function emit(event: string, payload: Record<string, unknown>, gatewayId = 'gw-1') {
    listener?.({ event, payload, gatewayId });
  }

  function emitStatus(status: GatewayStatusEvent) {
    statusListener?.(status);
  }

  function emitRuntimeStatus(status: RuntimeStatusEvent) {
    runtimeStatusListener?.(status);
  }

  return { emit, emitStatus, emitRuntimeStatus, dispatcher, deps, systemMessages, toasts, messageStore };
}

function emitChatError(
  h: ReturnType<typeof createHarness>,
  opts: { errorMessage: string; errorCode?: string; runId?: string; errorKind?: string },
) {
  h.emit('chat', {
    sessionKey: TASK.sessionKey,
    state: 'error',
    errorMessage: opts.errorMessage,
    errorCode: opts.errorCode,
    errorKind: opts.errorKind,
    runId: opts.runId,
  });
}

describe('canonical discovery persistence failures', () => {
  it.each(['initialize', 'status'] as const)('reports rejected discovery writes from %s', async (path) => {
    const h = createHarness();
    const error = new Error('Canonical message persistence exhausted retries');
    const failed = Promise.reject(error);
    void failed.catch(() => undefined);
    h.deps.syncFromGateway = () => failed;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      if (path === 'initialize') {
        h.deps.gateway.gatewayStatus = async () => ({ 'gw-1': { name: 'Gateway', connected: true } });
        await h.dispatcher.initialize();
      } else {
        h.dispatcher.startGatewayStatus();
        h.emitStatus({ gatewayId: 'gw-1', connected: true });
      }
      await Promise.resolve();
      expect(warn).toHaveBeenCalledWith('[sync] Gateway session sync failed', error);
    } finally {
      warn.mockRestore();
    }
  });
});

function emitLifecycleError(h: ReturnType<typeof createHarness>, error: string) {
  h.emit('agent', {
    sessionKey: TASK.sessionKey,
    stream: 'lifecycle',
    data: { phase: 'error', error },
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('canonical media session messages', () => {
  const media = {
    sessionKey: TASK.sessionKey,
    messageId: 'canonical-video-1',
    message: {
      role: 'assistant',
      content: [{ type: 'video', url: '/api/chat/media/outgoing/session/video/full', mimeType: 'video/mp4' }],
    },
  };

  it('refreshes canonical history when media arrives after the final text', () => {
    const h = createHarness();
    h.emit('session.message', media);
    expect(h.deps.syncSessionMessages).toHaveBeenCalledWith(TASK.id, TASK.sessionKey);
    expect(h.messageStore.addMessage).not.toHaveBeenCalled();
    expect(h.messageStore.finalizeStream).not.toHaveBeenCalled();
  });

  it('does not import another gateway, another session, or ephemeral media', () => {
    const h = createHarness();
    h.emit('session.message', media, 'gw-other');
    h.emit('session.message', { ...media, sessionKey: 'agent:other:clawwork:task:task-1' });
    h.deps.isEphemeralSession = () => true;
    h.emit('session.message', media);
    expect(h.deps.syncSessionMessages).not.toHaveBeenCalled();
  });

  it('ignores user messages and text-only or malformed payloads', () => {
    const h = createHarness();
    h.emit('session.message', {});
    h.emit('session.message', { ...media, message: null });
    h.emit('session.message', { ...media, message: { ...media.message, role: 'user' } });
    h.emit('session.message', {
      ...media,
      message: { role: 'assistant', content: [{ type: 'text', text: 'Video ready' }] },
    });
    expect(h.deps.syncSessionMessages).not.toHaveBeenCalled();
  });
});

describe('fetchAgentsForGateway', () => {
  it('keeps the cache for ordinary reads', async () => {
    const h = createHarness();
    h.deps.gateway.listAgents = vi.fn();

    await h.dispatcher.fetchAgentsForGateway('gw-1', { 'gw-1': { agents: [] } });

    expect(h.deps.gateway.listAgents).not.toHaveBeenCalled();
  });

  it('replaces a stale catalog when force is requested', async () => {
    const h = createHarness();
    const agents = [{ id: 'main' }, { id: 'rongying-content' }];
    h.deps.gateway.listAgents = vi.fn(async () => ({ ok: true, result: { agents, defaultId: 'main' } }));

    await h.dispatcher.fetchAgentsForGateway('gw-1', { 'gw-1': { agents: [{ id: 'main' }] } }, { force: true });

    expect(h.deps.gateway.listAgents).toHaveBeenCalledWith('gw-1');
    expect(h.deps.setAgentCatalogForGateway).toHaveBeenCalledWith('gw-1', agents, 'main');
  });

  it('surfaces a failed forced refresh instead of trusting stale data', async () => {
    const h = createHarness();
    h.deps.gateway.listAgents = vi.fn(async () => ({ ok: false, error: 'gateway busy' }));

    await expect(
      h.dispatcher.fetchAgentsForGateway('gw-1', { 'gw-1': { agents: [{ id: 'main' }] } }, { force: true }),
    ).rejects.toThrow('gateway busy');
  });
});

describe('isSameFailure — chat error dedup by runId / code + source', () => {
  it('suppresses a repeat error that shares taskId + code + source', () => {
    const h = createHarness();

    emitChatError(h, { errorMessage: 'rate limit exceeded', errorCode: 'rate_limit' });
    expect(h.systemMessages).toHaveLength(1);
    expect(h.toasts).toHaveLength(1);

    emitChatError(h, { errorMessage: 'rate limit exceeded again', errorCode: 'rate_limit' });
    expect(h.systemMessages).toHaveLength(1);
    expect(h.toasts).toHaveLength(1);
  });

  it('displays a follow-up error whose code differs', () => {
    const h = createHarness();

    emitChatError(h, { errorMessage: 'rate limit', errorCode: 'rate_limit' });
    expect(h.systemMessages).toHaveLength(1);

    emitChatError(h, { errorMessage: 'network down', errorCode: 'network_error' });
    expect(h.systemMessages).toHaveLength(2);
    expect(h.toasts).toHaveLength(2);
  });

  it('suppresses a repeat error that shares taskId + runId', () => {
    const h = createHarness();

    emitChatError(h, { errorMessage: 'first failure', runId: 'run-abc' });
    expect(h.systemMessages).toHaveLength(1);

    emitChatError(h, { errorMessage: 'second failure', runId: 'run-abc' });
    expect(h.systemMessages).toHaveLength(1);
    expect(h.toasts).toHaveLength(1);
  });

  it('displays a follow-up error whose runId differs', () => {
    const h = createHarness();

    emitChatError(h, { errorMessage: 'first failure', runId: 'run-abc' });
    expect(h.systemMessages).toHaveLength(1);

    emitChatError(h, { errorMessage: 'second failure', runId: 'run-xyz' });
    expect(h.systemMessages).toHaveLength(2);
    expect(h.toasts).toHaveLength(2);
  });
});

describe('shouldDisplayError — first error for a task, then an identical repeat', () => {
  it('displays the first error for a task, then suppresses an identical repeat', () => {
    vi.useFakeTimers();
    const h = createHarness();

    emitChatError(h, { errorMessage: 'something failed' });
    expect(h.systemMessages).toHaveLength(1);

    emitChatError(h, { errorMessage: 'something failed' });
    expect(h.systemMessages).toHaveLength(1);
    expect(h.toasts).toHaveLength(1);
  });
});

describe('DEDUP_FALLBACK_WINDOW_MS — 2000ms fallback window', () => {
  it('suppresses an identical rawMessage + source repeat inside the window, then re-displays after it elapses', () => {
    vi.useFakeTimers();
    const h = createHarness();

    emitChatError(h, { errorMessage: 'boom' });
    expect(h.systemMessages).toHaveLength(1);

    vi.advanceTimersByTime(1000);
    emitChatError(h, { errorMessage: 'boom' });
    expect(h.systemMessages).toHaveLength(1);

    vi.advanceTimersByTime(1000);
    emitChatError(h, { errorMessage: 'boom' });
    expect(h.systemMessages).toHaveLength(2);
  });
});

/**
 * B10：把 `retryable` 接上 —— 可重试的失败给界面一个「重试」入口。
 *
 * 这里盯的**只有一件事**：**该不该登记**。判据是网关给的结构化 `errorKind`
 * （chat 错误帧里没有 `code`，这也是这个字段长期恒为 `unknown` 的原因）。
 *
 * ⚠️ 最关键的一条是"**不**登记"：模型拒答、上下文超长这类重发同一句话只会再失败一次，
 *    给了按钮等于劝用户白花一次钱。宁可少给，不可乱给。
 */
describe('可重试错误的登记（B10）', () => {
  const TARGET = { taskId: 'task-1', messageId: 'msg-1' };

  it('⭐ 网关说"太频繁/超时" ⇒ 登记，并指向刚落下的那句错误', () => {
    for (const errorKind of ['rate_limit', 'timeout']) {
      const h = createHarness();
      emitChatError(h, { errorMessage: 'RateLimitExceededError: slow down', errorKind });

      expect(h.messageStore.markRetryableError, `kind=${errorKind}`).toHaveBeenCalledWith(TASK.sessionKey, TARGET);
    }
  });

  it('⭐ 重发也没用的（拒答 / 上下文超长）⇒ **不**登记 —— 不给按钮就是不劝人白花钱', () => {
    for (const errorKind of ['refusal', 'context_length']) {
      const h = createHarness();
      emitChatError(h, { errorMessage: 'model refused', errorKind });

      expect(h.messageStore.markRetryableError, `kind=${errorKind} 不该给重试入口`).not.toHaveBeenCalled();
      // 但失败本身照旧要说出来 —— "不给重试"不等于"不告诉用户"
      expect(h.systemMessages).toHaveLength(1);
    }
  });

  it('认不出类别（unknown / 没有 kind）⇒ 不登记', () => {
    for (const errorKind of ['unknown', undefined]) {
      const h = createHarness();
      emitChatError(h, { errorMessage: 'SomethingNewError: x', ...(errorKind ? { errorKind } : {}) });

      expect(h.messageStore.markRetryableError).not.toHaveBeenCalled();
    }
  });

  it('去重挡掉的重复错误不再登记 —— 没有新消息，就不该冒出一个新按钮', () => {
    vi.useFakeTimers();
    const h = createHarness();

    emitChatError(h, { errorMessage: 'boom', errorKind: 'rate_limit' });
    emitChatError(h, { errorMessage: 'boom', errorKind: 'rate_limit' });

    expect(h.messageStore.markRetryableError).toHaveBeenCalledTimes(1);
  });

  it('临时会话（对比的一列）不登记：那列的错误走旁路，时间线上没有可挂按钮的消息', () => {
    const h = createHarness();
    const KEY_0 = 'agent:main:clawwork:compare-run-1-0:task:task-1';
    h.deps.isEphemeralSession = (k: string) => k === KEY_0;

    h.emit('chat', { sessionKey: KEY_0, state: 'error', errorMessage: 'boom', errorKind: 'rate_limit' });

    expect(h.messageStore.markRetryableError).not.toHaveBeenCalled();
    expect(h.messageStore.setSessionError).toHaveBeenCalled();
  });
});

/**
 * 包 D（2026-10-07，「整轮失败自动重发 1 次」）：失败候选的**登记**。
 *
 * 这里登记的不是 B10 那个「重试」按钮（`markRetryableError`），而是
 * 「这条失败值不值得让界面自动重发一次」：
 *   - **确定性**失败（`refusal` / `context_length`）**两边都不登记** —— 重发同一句话
 *     只会再失败一次（与 B10 同一条结论）；
 *   - **瞬时**失败（`rate_limit` / `timeout`）登记成 `transient` 候选；
 *   - **认不出类别**的登记成 `unclassified` 候选 —— 保留登记（排查现场），但
 *     渲染层的类别门**不会**自动重发它们（BUG-050 收紧：malformed / unknown 都在这里）。
 *   - 候选一律携带 `producedOutput`：**清理之前**取的「本轮已产出」证据快照（BUG-050）——
 *     登记发生在 `clearActiveTurn` 之后，不留快照的话渲染层就判不出"跑过工具没有"。
 *     其余判据（本轮无新产物、无已结算交付）本体在 `useAutoRetryFailedTurn` 的用例里。
 *
 * ⚠️ 两份登记**故意分开**：B10 的按钮判据在 lifecycle 这条路上恒为 `unknown`
 *    （帧里没有结构化的 code/kind），若复用同一份登记，等于给这类失败凭空加个
 *    「重试」按钮 —— 而那正是 B10 明确拒绝过的行为。
 */
describe('自动重试候选的登记（包 D）', () => {
  it('⭐ lifecycle error 释放成 system 消息时登记为「未分类」候选（真机事故走的正是这条）', async () => {
    vi.useFakeTimers();
    const h = createHarness();

    emitLifecycleError(h, '⚠️ Agent run failed (model: clawrouter/deepseek-v4-flash)');
    expect(h.messageStore.markAutoRetryFailure).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(DEDUP_FALLBACK_WINDOW_MS);
    expect(h.messageStore.markAutoRetryFailure).toHaveBeenCalledWith(TASK.sessionKey, {
      taskId: 'task-1',
      messageId: 'msg-1',
      kind: 'unclassified',
      producedOutput: false,
    });
  });

  it('被去重窗挡掉的重复 lifecycle error 不再登记（没有新消息，就没有新候选）', async () => {
    vi.useFakeTimers();
    const h = createHarness();

    // 同一个去重窗内的两条：第二条把第一条的定时器顶掉，最终只落一条消息
    emitLifecycleError(h, 'provider unavailable');
    emitLifecycleError(h, 'provider unavailable');
    await vi.advanceTimersByTimeAsync(DEDUP_FALLBACK_WINDOW_MS);

    expect(h.systemMessages).toHaveLength(1);
    expect(h.messageStore.markAutoRetryFailure).toHaveBeenCalledTimes(1);
  });

  it('lifecycle error 走临时会话时**不**登记（那一列的失败只写它自己）', async () => {
    vi.useFakeTimers();
    const h = createHarness();
    const KEY_0 = 'agent:main:clawwork:compare-run-1-0:task:task-1';
    h.deps.isEphemeralSession = (k: string) => k === KEY_0;

    h.emit('agent', {
      sessionKey: KEY_0,
      stream: 'lifecycle',
      data: { phase: 'error', error: 'provider unavailable' },
    });
    await vi.advanceTimersByTimeAsync(DEDUP_FALLBACK_WINDOW_MS);

    expect(h.messageStore.setSessionError).toHaveBeenCalled();
    expect(h.messageStore.markAutoRetryFailure).not.toHaveBeenCalled();
  });

  it('瞬时类 chat 失败（rate_limit / timeout）⇒ 登记为 transient 候选', () => {
    for (const errorKind of ['rate_limit', 'timeout']) {
      const h = createHarness();
      emitChatError(h, { errorMessage: 'RateLimitExceededError: slow down', errorKind });

      expect(h.messageStore.markAutoRetryFailure, `kind=${errorKind}`).toHaveBeenCalledWith(TASK.sessionKey, {
        taskId: 'task-1',
        messageId: 'msg-1',
        kind: 'transient',
        producedOutput: false,
      });
    }
  });

  it('⭐ 确定性类（refusal / context_length）⇒ **不**登记 —— 自动重发也白搭', () => {
    for (const errorKind of ['refusal', 'context_length']) {
      const h = createHarness();
      emitChatError(h, { errorMessage: 'model refused', errorKind });

      expect(h.messageStore.markAutoRetryFailure, `kind=${errorKind} 不该自动重发`).not.toHaveBeenCalled();
      // 失败本身照旧要说出来 —— "不自动重发"不等于"不告诉用户"
      expect(h.systemMessages).toHaveLength(1);
    }
  });

  it('认不出类别（unknown / 没有 kind）⇒ 登记为未分类候选（渲染层的类别门不会自动重发它）', () => {
    for (const errorKind of ['unknown', undefined]) {
      const h = createHarness();
      emitChatError(h, { errorMessage: 'SomethingNewError: x', ...(errorKind ? { errorKind } : {}) });

      expect(h.messageStore.markAutoRetryFailure, `kind=${errorKind ?? '(missing)'}`).toHaveBeenCalledWith(
        TASK.sessionKey,
        { taskId: 'task-1', messageId: 'msg-1', kind: 'unclassified', producedOutput: false },
      );
    }
  });

  it('⭐ 本轮跑过工具 ⇒ 候选带「已产出」快照，且确证快照取在 clearActiveTurn **之前**（BUG-050）', () => {
    const h = createHarness();
    // 真身 clearActiveTurn 会**删掉** turn —— 用一个真删的桩，顺序错了这里立刻红
    //（登记发生在清理之后：清理时不留证据就永远拿不回来了）。
    h.messageStore.clearActiveTurn = vi.fn((sessionKey: string) => {
      delete h.messageStore.activeTurnBySession[sessionKey];
    });
    h.messageStore.activeTurnBySession[TASK.sessionKey] = {
      id: 'turn-1',
      streamingText: '',
      streamingThinking: '',
      toolCalls: [{ id: 't1', name: 'exec', status: 'done' }],
      finalized: false,
      content: '',
      timestamp: '2026-10-08T00:00:00.000Z',
    };

    emitChatError(h, { errorMessage: 'RateLimitExceededError: slow down', errorKind: 'rate_limit' });

    expect(h.messageStore.clearActiveTurn).toHaveBeenCalledWith(TASK.sessionKey);
    expect(h.messageStore.activeTurnBySession[TASK.sessionKey]).toBeUndefined();
    expect(h.messageStore.markAutoRetryFailure).toHaveBeenCalledWith(TASK.sessionKey, {
      taskId: 'task-1',
      messageId: 'msg-1',
      kind: 'transient',
      producedOutput: true,
    });
  });

  it('⭐ lifecycle error 路径同样带快照（取在事件那一刻，不看 2s 去重窗之后的现场）', async () => {
    vi.useFakeTimers();
    const h = createHarness();
    h.messageStore.activeTurnBySession[TASK.sessionKey] = {
      id: 'turn-1',
      streamingText: '正在写第 1 页…',
      streamingThinking: '',
      toolCalls: [],
      finalized: false,
      content: '',
      timestamp: '2026-10-08T00:00:00.000Z',
    };

    emitLifecycleError(h, 'provider unavailable');
    // 去重窗里现场被清（别的清理路径），登记照旧要带上"这一轮出过正文"。
    delete h.messageStore.activeTurnBySession[TASK.sessionKey];
    await vi.advanceTimersByTimeAsync(DEDUP_FALLBACK_WINDOW_MS);

    expect(h.messageStore.markAutoRetryFailure).toHaveBeenCalledWith(TASK.sessionKey, {
      taskId: 'task-1',
      messageId: 'msg-1',
      kind: 'unclassified',
      producedOutput: true,
    });
  });

  it('只有思考流不算产出（快照为 false）—— 空转的判据是"有没有交付物"', () => {
    const h = createHarness();
    h.messageStore.activeTurnBySession[TASK.sessionKey] = {
      id: 'turn-1',
      streamingText: '',
      streamingThinking: '让我想想…',
      toolCalls: [],
      finalized: false,
      content: '',
      timestamp: '2026-10-08T00:00:00.000Z',
    };

    emitChatError(h, { errorMessage: 'RateLimitExceededError: slow down', errorKind: 'rate_limit' });

    expect(h.messageStore.markAutoRetryFailure).toHaveBeenCalledWith(TASK.sessionKey, {
      taskId: 'task-1',
      messageId: 'msg-1',
      kind: 'transient',
      producedOutput: false,
    });
  });

  it('临时会话（对比的一列）不登记自动重试候选', () => {
    const h = createHarness();
    const KEY_0 = 'agent:main:clawwork:compare-run-1-0:task:task-1';
    h.deps.isEphemeralSession = (k: string) => k === KEY_0;

    h.emit('chat', { sessionKey: KEY_0, state: 'error', errorMessage: 'boom', errorKind: 'rate_limit' });

    expect(h.messageStore.markAutoRetryFailure).not.toHaveBeenCalled();
  });

  it('去重挡掉的重复 chat 错误不再登记（与新按钮同一条纪律）', () => {
    const h = createHarness();

    emitChatError(h, { errorMessage: 'boom', errorKind: 'rate_limit' });
    emitChatError(h, { errorMessage: 'boom', errorKind: 'rate_limit' });

    expect(h.messageStore.markAutoRetryFailure).toHaveBeenCalledTimes(1);
  });
});

/**
 * 🔴 正文的**追加 vs 替换**（2026-09-19 实测定位的真 bug）。
 *
 * 原来一律 `appendStreamDelta(extractText(...))`，而 `extractText` 取的是
 * `message.content[0].text` —— **到此刻为止的全文**。结果：流式期间正文重复膨胀，
 * 09-14 实测一轮 Σdelta **84,927** 字符 vs final **1,486**，**57 倍**。
 *
 * 这里钉的是**接线**：判定在 `extractDeltaText`（有自己的用例），
 * 但"判定结果有没有真的走到 store 的对应动作"只有在这一层才看得见。
 */
describe('chat delta：追加还是替换（接线）', () => {
  const SK = TASK.sessionKey;

  it('⭐ 旧形状（`content` 是全文快照）⇒ 走 **replace**，不是 append', () => {
    const h = createHarness();

    h.emit('chat', {
      sessionKey: SK,
      state: 'delta',
      message: { role: 'assistant', content: [{ type: 'text', text: '到此刻为止的全文' }] },
    });

    expect(h.messageStore.replaceStreamText).toHaveBeenCalledWith(SK, '到此刻为止的全文');
    expect(h.messageStore.appendStreamDelta, '把全文当增量追加 = 那个 57 倍').not.toHaveBeenCalled();
  });

  it('⭐ v4：有 `deltaText`（增量）⇒ 走 **append**', () => {
    const h = createHarness();

    h.emit('chat', {
      sessionKey: SK,
      state: 'delta',
      deltaText: '增量',
      message: { role: 'assistant', content: [{ type: 'text', text: '很长很长的全文' }] },
    });

    expect(h.messageStore.appendStreamDelta).toHaveBeenCalledWith(SK, '增量');
    expect(h.messageStore.replaceStreamText).not.toHaveBeenCalled();
  });

  it('⭐ v4 + `replace: true` ⇒ `deltaText` 是全文 ⇒ 走 **replace**', () => {
    const h = createHarness();

    h.emit('chat', { sessionKey: SK, state: 'delta', deltaText: '重写的全文', replace: true });

    expect(h.messageStore.replaceStreamText).toHaveBeenCalledWith(SK, '重写的全文');
    expect(h.messageStore.appendStreamDelta).not.toHaveBeenCalled();
  });

  it('⚠️ `replace` 但文本为空 ⇒ **两个都不调**（空的替换会把正文清空）', () => {
    const h = createHarness();

    h.emit('chat', { sessionKey: SK, state: 'delta', deltaText: '', replace: true });

    expect(h.messageStore.replaceStreamText).not.toHaveBeenCalled();
    expect(h.messageStore.appendStreamDelta).not.toHaveBeenCalled();
  });

  it('`final` 的正文也是**全文** ⇒ 也走 replace（不是 append）', () => {
    const h = createHarness();

    h.emit('chat', {
      sessionKey: SK,
      state: 'final',
      message: { role: 'assistant', content: [{ type: 'text', text: '最终全文' }] },
    });

    expect(h.messageStore.replaceStreamText).toHaveBeenCalledWith(SK, '最终全文');
    expect(h.messageStore.appendStreamDelta).not.toHaveBeenCalled();
  });
});

/**
 * `run_status` 的 **`retrying`** 相位 —— 第 8 个取值，我们此前不认。
 *
 * 实测（`~/git/openclaw`，2026-09-09）：`src/agents/embedded-agent-runner/run/attempt-recovery.ts`
 * 在重试时发 `{stream:"run_status", data:{phase:"retrying", message, retryAttempt, maxRetries,
 * delayMs, attempt, maxAttempts, reason}}`。
 *
 * ⚠️ 而 `server-chat.ts` 的 **chat 投影会把它改写成 `phase:"starting_model"`** ——
 * 所以只有 **agent 流**上是原样的 `retrying`，正好是我们消费的那条。
 * ⇒ 我们此前 `RUN_STARTUP_PHASES` 里没有它 ⇒ 界面退回泛化的「正在准备…」，
 * 用户看不出"它在重试、而且已经试到第 2 次了"。
 */
describe('run_status 的重试相位', () => {
  it('⭐ `phase:"retrying"` 要**认**（并把它当已知，不落进泛化文案）', () => {
    const h = createHarness();

    h.emit('agent', { sessionKey: TASK.sessionKey, stream: 'run_status', data: { phase: 'retrying' } });

    expect(h.deps.reportDebugEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'renderer.agent.run_status',
        data: expect.objectContaining({ phase: 'retrying', known: true }),
      }),
    );
  });

  it('⭐ 把重试的**次数**一起带给 store（"第 2/4 次"比"正在重试"有用得多）', () => {
    const h = createHarness();

    h.emit('agent', {
      sessionKey: TASK.sessionKey,
      stream: 'run_status',
      data: { phase: 'retrying', attempt: 2, maxAttempts: 4, reason: 'rate_limit' },
    });

    expect(h.messageStore.setRunPhase).toHaveBeenCalledWith(TASK.sessionKey, 'retrying', {
      attempt: 2,
      maxAttempts: 4,
    });
  });

  it('普通相位**不带**次数（别把上一轮的残留带进去）', () => {
    const h = createHarness();

    h.emit('agent', {
      sessionKey: TASK.sessionKey,
      stream: 'run_status',
      data: { phase: 'preparing_workspace' },
    });

    expect(h.messageStore.setRunPhase).toHaveBeenCalledWith(TASK.sessionKey, 'preparing_workspace');
  });

  it('⭐ **非重试相位即使帧里带了次数，也不许往下传**（数字粘到别的相位上就是说谎）', () => {
    // `attempt`/`maxAttempts` 是重试帧的字段；别的相位若碰巧带着它们（网关改动 / 转发污染），
    // 我们**只能认相位说得通的那一半** —— 否则界面会显示"正在准备（第 2/4 次）"。
    const h = createHarness();

    h.emit('agent', {
      sessionKey: TASK.sessionKey,
      stream: 'run_status',
      data: { phase: 'starting_model', attempt: 2, maxAttempts: 4 },
    });

    expect(h.messageStore.setRunPhase).toHaveBeenCalledWith(TASK.sessionKey, 'starting_model');
    expect(h.messageStore.setRunPhase).not.toHaveBeenCalledWith(TASK.sessionKey, 'starting_model', expect.anything());
  });

  it('⚠️ `retrying` 但**没有次数**（畸形/裁剪过的帧）⇒ 仍然切相位，只是不带数字', () => {
    const h = createHarness();

    h.emit('agent', {
      sessionKey: TASK.sessionKey,
      stream: 'run_status',
      data: { phase: 'retrying', attempt: 'x' },
    });

    expect(h.messageStore.setRunPhase).toHaveBeenCalledWith(TASK.sessionKey, 'retrying');
  });
});

/**
 * `lifecycle` 的 **`finishing`** 相位 —— **一个危险的陷阱**，我们此前不认它。
 *
 * 实测（`~/git/openclaw`，2026-09-09）：`src/agents/command/lifecycle.ts`
 * 的 terminal 相位联合是 **`"finishing" | "end" | "error"`**，而
 * `src/agents/embedded-agent-runner/run/attempt-stream-prepare.ts` 写着：
 *
 * ```js
 * terminalLifecyclePhase: attempt.deferTerminalLifecycle ? "finishing" : "end"
 * ```
 *
 * ⇒ **`finishing` 是 `end` 的替代品**，在"还有后续尝试"时发。网关自己的注释说得更明白：
 *   「Finishing is an **attempt fence**, not the outer execution's final publication」、
 *   「the caller owns the terminal」。
 *
 * ## 为什么必须钉住
 *
 * 它今天走 `default` ⇒ 记 `lifecycle.unknown`、**不改状态** ⇒ 行为是对的（碰巧）。
 * 但那是一条**没有护栏的对**：后人看到日志里 `lifecycle.unknown {phase:"finishing"}`，
 * 最自然的"修复"就是**照着 `end` 那样补一个 case** —— 于是在还有后续尝试时
 * `setProcessing(false)` + 清 run phase ⇒ **活动条在 agent 还在干活时消失**，
 * 用户以为它做完了。
 *
 * ⚠️ 所以这一组用例是**护栏**：`finishing` **必须什么都不改**。
 */
describe('lifecycle.finishing —— 是"还要继续"，不是"结束"', () => {
  const emitLifecycle = (h: ReturnType<typeof createHarness>, phase: string) =>
    h.emit('agent', { sessionKey: TASK.sessionKey, stream: 'lifecycle', data: { phase } });

  it('⭐ `finishing` **不许**收掉这一轮（它是 attempt fence，不是终态）', () => {
    const h = createHarness();
    h.messageStore.setProcessing.mockClear();

    emitLifecycle(h, 'finishing');

    expect(h.messageStore.setProcessing, '把它当 end 处理 = 活动条在 agent 还在干活时消失').not.toHaveBeenCalled();
  });

  it('⭐ `finishing` **不许**清掉 run phase / 进度文本', () => {
    const h = createHarness();
    h.messageStore.setRunPhase.mockClear();
    h.messageStore.setSessionProgressText.mockClear();

    emitLifecycle(h, 'finishing');

    expect(h.messageStore.setRunPhase).not.toHaveBeenCalled();
    expect(h.messageStore.setSessionProgressText).not.toHaveBeenCalled();
  });

  it('⭐ 它要记成**自己的**事件，不是"未知相位"（否则后人会去"补上处理"）', () => {
    const h = createHarness();

    emitLifecycle(h, 'finishing');

    expect(h.deps.reportDebugEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'renderer.agent.lifecycle.finishing' }),
    );
    expect(h.deps.reportDebugEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'renderer.agent.lifecycle.unknown' }),
    );
  });

  it('对照：`end` 照旧收尾（别为了 finishing 把 end 也改了）', () => {
    const h = createHarness();

    emitLifecycle(h, 'end');

    expect(h.messageStore.setProcessing).toHaveBeenCalledWith(TASK.sessionKey, false);
    expect(h.messageStore.setRunPhase).toHaveBeenCalledWith(TASK.sessionKey, null);
  });

  it('对照：**真**未知的相位仍然走 unknown（default 那条不能被吃掉）', () => {
    const h = createHarness();

    emitLifecycle(h, 'some_future_phase');

    expect(h.deps.reportDebugEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'renderer.agent.lifecycle.unknown',
        data: expect.objectContaining({ phase: 'some_future_phase' }),
      }),
    );
  });
});

/**
 * `item` 的 **`kind`** —— 又一个**开放词表**，而我们的丢弃是**静默的**。
 *
 * ## 实测（`~/git/openclaw`，2026-09-09）
 *
 * 运行时自己的类型（`src/infra/agent-activity-events.ts`）写着：
 *
 * ```ts
 * type AgentItemEventKind = "tool" | "command" | "patch" | "search" | "analysis" | (string & {});
 * ```
 *
 * ⚠️ **最后那个 `(string & {})` 是关键：它是开放式词表。**
 * 逐一核过发射点：
 * - `tool` / `preamble` —— 我们已接；
 * - `command` —— 真会发（exec 专用，C2 已决定不接实时输出）；
 * - `patch` —— 真会发，但**只对 `apply_patch`**（我们的 agent 不用这个工具）；
 * - `search` / `analysis` —— **一个发射点都没有**（类型里声明了，没人发）。
 *
 * ## 问题不在"我们丢了哪几个"，而在"**丢得没有声音**"
 *
 * 我们的代码是：
 *
 * ```ts
 * if (data.kind === 'preamble') { …; return; }
 * if (data.kind !== 'tool') return;   // ← 其余 kind 一句日志都没有
 * ```
 *
 * `preamble` 当初就是这么被整块丢掉的（后来才发现它有用）。词表**开放** + 丢弃**无声**
 * = 下次网关加一个我们其实想要的 kind，我们**还是**要等几个月才知道。
 *
 * ⇒ 这一刀**零行为变更**：照旧不往 store 里写，但**分开记两种**：
 *   知道但不接的（`command`/`patch`）记 `ignored_kind`；**认不出的**记 `unknown_kind`。
 */

describe('item 的 kind：丢可以，但不能丢得没声音', () => {
  const emitItem = (h: ReturnType<typeof createHarness>, data: Record<string, unknown>) =>
    h.emit('agent', { sessionKey: TASK.sessionKey, stream: 'item', data });

  it('⭐ 知道但不接的 kind（`command`）⇒ 记 `ignored_kind`，**不是** unknown', () => {
    const h = createHarness();

    emitItem(h, { kind: 'command', itemId: 'command:tc-1', phase: 'update', toolCallId: 'tc-1' });

    expect(h.deps.reportDebugEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'renderer.agent.item.ignored_kind',
        data: expect.objectContaining({ kind: 'command' }),
      }),
    );
    expect(h.deps.reportDebugEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'renderer.agent.item.unknown_kind' }),
    );
  });

  it('⭐ `patch` 同样算"知道但不接"（只为 `apply_patch` 发，我们的 agent 不用）', () => {
    const h = createHarness();

    emitItem(h, { kind: 'patch', itemId: 'patch:tc-2', phase: 'end', toolCallId: 'tc-2' });

    expect(h.deps.reportDebugEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'renderer.agent.item.ignored_kind',
        data: expect.objectContaining({ kind: 'patch' }),
      }),
    );
  });

  it('⭐⭐ **认不出的** kind ⇒ 记 `unknown_kind` 并**带上 kind 名**（否则没法定位）', () => {
    // 这条才是真正要防的：`kind` 是开放词表，将来会冒出新值。
    const h = createHarness();

    emitItem(h, { kind: 'some_future_kind', itemId: 'x:1', phase: 'start', toolCallId: 'tc-9' });

    expect(h.deps.reportDebugEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'renderer.agent.item.unknown_kind',
        data: expect.objectContaining({ kind: 'some_future_kind' }),
      }),
    );
    expect(h.deps.reportDebugEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'renderer.agent.item.ignored_kind' }),
    );
  });

  it('⚠️ `kind` 整个缺失 ⇒ 也要留痕，且用 `(missing)` 而不是 undefined', () => {
    const h = createHarness();

    emitItem(h, { itemId: 'x:1', phase: 'start' });

    expect(h.deps.reportDebugEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'renderer.agent.item.unknown_kind',
        data: expect.objectContaining({ kind: '(missing)' }),
      }),
    );
  });

  it('对照：`kind:"tool"` 走原来的路（两个 kind 事件都不该记）', () => {
    const h = createHarness();

    emitItem(h, {
      kind: 'tool',
      phase: 'start',
      toolCallId: 'tc-3',
      name: 'ls',
      title: 'ls 目录',
    });

    expect(h.messageStore.upsertToolCall).toHaveBeenCalled();
    expect(h.deps.reportDebugEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'renderer.agent.item.unknown_kind' }),
    );
    expect(h.deps.reportDebugEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'renderer.agent.item.ignored_kind' }),
    );
  });

  it('对照：`kind:"preamble"` 也照旧（不记那两个）', () => {
    const h = createHarness();

    emitItem(h, { kind: 'preamble', progressText: '正在核对第三章' });

    expect(h.messageStore.setSessionProgressText).toHaveBeenCalledWith(TASK.sessionKey, '正在核对第三章');
    expect(h.deps.reportDebugEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'renderer.agent.item.unknown_kind' }),
    );
  });
});

/**
 * 补上**剩下两处静默丢弃**（`chat` 的 `state`、`approval` 的 `status`）。
 *
 * 上一组（`item.kind`）把这条纪律写清楚了：**开放词表 + 静默丢弃 = 必然会重演**。
 * 当时把"还没补的三处"记在了队列里，本轮补掉其中两处：
 *
 * | 处 | 现状 |
 * | --- | --- |
 * | `agent` 的 `error` 流 `reason` | ✅ 已经**全量记**了（`stream_error` 带 reason/expected/received）⇒ 不用动 |
 * | **`chat` 的 `state`** | ⚠️ `if/else if` 链**没有 else** ⇒ 未处理的 state **静默穿过** |
 * | **`approval` 的 `status`** | ⚠️ 只认 3 个值，其余**静默 return**（遥测有，但"这个值我不认识"没说出来） |
 */
describe('chat 的 state：未处理的取值要留痕', () => {
  /**
   * ⭐ **类型护栏**：`state` 必须**保持开放**。
   *
   * 下面那行不是断言"运行时行为"，是断言**类型不许被收窄** —— 而它防的是一桩真事：
   * `ChatEventPayload.state` 曾写成恰好四个值的封闭联合 `'delta'|'final'|'aborted'|'error'`。
   * 于是 `handleChatEvent` 的 `if/else if` 链在 TS 眼里**已经穷尽**，谁也不会去写 `else`
   * （写了反而像多余的防御）。而运行时实际发**五个**
   * （`ChatEventSchema` = Status/Delta/Final/Aborted/Error，源码 `~/git/openclaw` 2026-09-09），
   * `state:"status"` 就这么静默穿了很久。
   *
   * ⚠️ 变异验证记过一笔：**只**把类型回退成封闭联合时，`typecheck` 与 `lint` **都抓不住**
   *    （TS 只是把 `else` 里的 `state` 窄成 `never`，不报错）。唯一的抓手就是这里 ——
   *    收窄回去，这行**编译不过** ⇒ `pnpm typecheck:tests` 红。
   */
  it('⭐ 类型护栏：`state` 不许收窄回封闭联合', () => {
    const unknownState: ChatEventPayload['state'] = 'some_state_only_the_runtime_knows';

    expect(unknownState).toBe('some_state_only_the_runtime_knows');
  });

  const emitChatState = (h: ReturnType<typeof createHarness>, state: string | undefined) =>
    h.emit('chat', { sessionKey: TASK.sessionKey, state, message: { content: [{ type: 'text', text: 'x' }] } });

  it('⭐ `state:"status"` ⇒ 记 `ignored_state`，**不许静默**', () => {
    // 运行时**会发**它（`ChatStatusEventSchema`，是 `run_status` 的 chat 投影）。
    // 我们刻意不用那份（agent 流那份才是我们消费的）—— 但"刻意不用"必须写出来。
    const h = createHarness();

    emitChatState(h, 'status');

    expect(h.deps.reportDebugEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'renderer.chat.ignored_state',
        data: expect.objectContaining({ state: 'status' }),
      }),
    );
  });

  it('⭐⭐ **认不出的** state ⇒ 记 `unknown_state` 并带上取值', () => {
    const h = createHarness();

    emitChatState(h, 'some_future_state');

    expect(h.deps.reportDebugEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'renderer.chat.unknown_state',
        data: expect.objectContaining({ state: 'some_future_state' }),
      }),
    );
  });

  it('⚠️ `state` 整个缺失 ⇒ 也留痕，用 `(missing)`', () => {
    const h = createHarness();

    emitChatState(h, undefined);

    expect(h.deps.reportDebugEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'renderer.chat.unknown_state',
        data: expect.objectContaining({ state: '(missing)' }),
      }),
    );
  });

  it.each(['delta', 'final', 'aborted', 'error'])('对照：`%s` 走原来的路（不记那两个）', (state) => {
    const h = createHarness();

    emitChatState(h, state);

    expect(h.deps.reportDebugEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'renderer.chat.unknown_state' }),
    );
    expect(h.deps.reportDebugEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'renderer.chat.ignored_state' }),
    );
  });
});

/**
 * ⭐ state-only 的 `chat` 帧**不许**当成"助手回应了"。
 *
 * ## 现场（2026-09-20 实机，store 级取证 —— 不是推的）
 *
 * 用户报障：「我发完要求，那个对话头像会消失一下，然后再给我反馈」。
 * 在 dev 客户端上把 store 的 `setProcessing` 包起来抓调用栈，一次发送里它被这样调用：
 *
 * ```
 * +  88ms  → true    （发送：chat-composer 打开"处理中"）
 * +1581ms  → false   ← notifyResponse（handleChatEvent）
 * +2148ms  → true    （lifecycle.start）
 * +2235ms  → false   ← notifyResponse（handleChatEvent）
 * ```
 *
 * 两次 `false` 让 `MainArea` 的等待块**被卸载又重建**
 * （MutationObserver 实录：`移除[BLOCK(flex gap-3.5 py-4)]` / `新增[BLOCK(...)]`）——
 * 用户看到的就是"头像消失一下"。而那两帧是 `state:"status"`
 * （准备相位的 chat 投影）：**只带状态、一个字的内容都没有**。
 *
 * ⇒ 判据：这一帧真的带来了回应内容（正文/推理/工具），或者标记了这一轮结束
 *   （`final`/`aborted`/`error`）—— 才叫"回应了"。
 *   `notifyAgentResponse` 的下游是 `composer.notifyResponse` → `setProcessing(session,false)`
 *   （`useGatewayDispatcherSetup.ts` 的接线），所以这里断言的就是"等待块会不会被关掉"。
 */
describe('chat 的 state-only 帧不许当成"助手回应了"', () => {
  const emitState = (h: ReturnType<typeof createHarness>, state: string | undefined, extra = {}) =>
    h.emit('chat', { sessionKey: TASK.sessionKey, state, ...extra });

  const harnessWithNotify = () => {
    const h = createHarness();
    const notify = vi.fn();
    h.deps.notifyAgentResponse = notify;
    return { h, notify };
  };

  it('⭐ `state:"status"`（一个字都没有）⇒ 不通知（否则等待块会被卸载）', () => {
    const { h, notify } = harnessWithNotify();

    emitState(h, 'status');

    expect(notify).not.toHaveBeenCalled();
  });

  it('⭐ 认不出的 state 同理（陌生帧不该让等待块闪一下）', () => {
    const { h, notify } = harnessWithNotify();

    emitState(h, 'some_future_state');

    expect(notify).not.toHaveBeenCalled();
  });

  it('⭐ `delta` 但**什么都没带**（无正文/推理/工具）⇒ 也不算回应', () => {
    const { h, notify } = harnessWithNotify();

    emitState(h, 'delta');

    expect(notify).not.toHaveBeenCalled();
  });

  it('对照：`delta` 带正文 ⇒ 照旧通知', () => {
    const { h, notify } = harnessWithNotify();

    emitState(h, 'delta', { message: { content: [{ type: 'text', text: '你好' }] } });

    expect(notify).toHaveBeenCalledWith(TASK.sessionKey);
  });

  it('对照：`delta` **只带推理** ⇒ 也算（思考块要渲染出来）', () => {
    const { h, notify } = harnessWithNotify();

    emitState(h, 'delta', { message: { content: [{ type: 'thinking', thinking: '在想…' }] } });

    expect(notify).toHaveBeenCalledWith(TASK.sessionKey);
  });

  it('对照：`delta` 只带工具调用 ⇒ 也算', () => {
    const { h, notify } = harnessWithNotify();

    emitState(h, 'delta', {
      message: { content: [{ type: 'toolCall', id: 'call-1', name: 'search', arguments: '{}' }] },
    });

    expect(notify).toHaveBeenCalledWith(TASK.sessionKey);
  });

  it.each(['final', 'aborted', 'error'])('对照：`%s` ⇒ 照旧通知（这一轮结束了）', (state) => {
    const { h, notify } = harnessWithNotify();

    emitState(h, state);

    expect(notify).toHaveBeenCalledWith(TASK.sessionKey);
  });

  /**
   * ⚠️ 同一类错误的**另一个出口**：`markUnread` 与 `notify` 在同一个 `if (!ephemeral)` 块里。
   * 未读小红点的语义是"那边**有内容**可看" —— 纯状态帧把它点亮，用户点进去会一脸茫然。
   */
  it('⭐ `state:"status"` ⇒ 不许把**别的**任务标未读（小红点要对得上内容）', () => {
    const { h } = harnessWithNotify();
    h.deps.getActiveTaskId = () => 'another-task';

    emitState(h, 'status');

    expect(h.deps.markUnread).not.toHaveBeenCalled();
  });

  it('对照：`delta` 带正文 ⇒ 照旧标未读', () => {
    const { h } = harnessWithNotify();
    h.deps.getActiveTaskId = () => 'another-task';

    emitState(h, 'delta', { message: { content: [{ type: 'text', text: '你好' }] } });

    expect(h.deps.markUnread).toHaveBeenCalledWith('task-1');
  });
});

/**
 * `approval` 的 `status` —— 运行时的闭集是
 * **`"pending" | "unavailable" | "approved" | "denied" | "failed"`**（`~/git/openclaw`，2026-09-09）。
 *
 * ⚠️ 我们只对 **`unavailable` / `denied` / `failed`** 动手（"确定没跑成"），
 * 而 **`approved` 从没被记录过** —— 核过判定规则后结论是**我们是对的**：
 * `approved` 意味着命令**会跑**，把它当"没执行"才是撒谎（与 `pending` 同一条纪律）。
 *
 * ⇒ 但"正确"和"有护栏"是两件事：新冒出来的 status 今天会**静默 return**。
 */
describe('approval 的 status：未处理的取值要留痕', () => {
  const emitApproval = (h: ReturnType<typeof createHarness>, status: string) =>
    h.emit('agent', {
      sessionKey: TASK.sessionKey,
      stream: 'approval',
      data: { phase: 'resolved', status, toolCallId: 'tc-1', kind: 'exec' },
    });

  it('⭐ `approved` ⇒ 记 `ignored_status`（**刻意不接**：它意味着命令会跑）', () => {
    const h = createHarness();

    emitApproval(h, 'approved');

    expect(h.deps.reportDebugEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'renderer.agent.approval.ignored_status',
        data: expect.objectContaining({ status: 'approved' }),
      }),
    );
  });

  it('⭐⭐ `pending` **不再是**"知道但不接" —— A2 起它被显式标成「等待批准」', () => {
    // ⚠️ 这条**从前断言的是 `ignored_status`**。A2（2026-09-19）把它改成"接"：
    //    命令停在等人时，用户得知道**为什么没有进展**、以及**该谁动**。
    //    ⇒ 断言方向没放松：从"记一条'我不接它'"变成"**必须**把它标出来"。
    const h = createHarness();

    emitApproval(h, 'pending');

    expect(h.deps.reportDebugEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'renderer.agent.approval.ignored_status' }),
    );
  });

  it('⭐⭐ **认不出的** status ⇒ 记 `unknown_status`（这条才是要防的）', () => {
    const h = createHarness();

    emitApproval(h, 'some_future_status');

    expect(h.deps.reportDebugEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'renderer.agent.approval.unknown_status',
        data: expect.objectContaining({ status: 'some_future_status' }),
      }),
    );
  });

  it.each(['denied', 'failed', 'unavailable'])('对照：`%s` 走原来的路（不记那两个）', (status) => {
    const h = createHarness();

    emitApproval(h, status);

    expect(h.deps.reportDebugEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'renderer.agent.approval.unknown_status' }),
    );
    expect(h.deps.reportDebugEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'renderer.agent.approval.ignored_status' }),
    );
  });
});

/**
 * `tool` 流的 `phase` —— **词表是五个，不是四个**。
 *
 * ⚠️ 我们的 `AgentToolData.phase` docblock 曾经白纸黑字写着「实测四个值
 * （2026-09-19 扫随包运行时的 emit 点）：`start`/`result`/`update`/`review`」——
 * **那是个完整性声明，而它是错的**。2026-09-19 拿源码重扫（`~/git/openclaw` 0153d84c，
 * 生产代码里 25 个 `stream:"tool"` 发射点）多出第五个：
 * `src/agents/embedded-agent-subscribe.handlers.messages.update.ts:73`
 * ⇒ `phase:"input_delta"`（活体编辑差异）。
 *
 * 那次漏掉的原因值得记：我只扫了 `handlers.tools.*` 那几个文件，
 * **而发射点不在那里**。「扫过一遍」写成了「只有这些」—— 那句声明才是真正的盖子：
 * 后一个人看到"已实测四个"，就不会再去数第五个。
 *
 * ⚠️ 附带核清的：`phase:"error"` 我们**有个分支在防守，但运行时一次都不发**
 *（11 个生产发射点里没有它）。留着无害（真发出来能接住），但它**不该被当成活代码** ——
 * 那正是当初没人发现三个真实非终态相位没被命名的原因之一。
 *
 * ⚠️ 还有一件：`phase` **可以整个缺失**（`host-hooks.contract.test.ts` 那类帧
 * 就发 `data:{name}`）。缺失也要留痕，不许静默。
 */
describe('tool 的 phase：词表是五个，丢弃不许没声音', () => {
  const emitTool = (h: ReturnType<typeof createHarness>, data: Record<string, unknown>) =>
    h.emit('agent', {
      sessionKey: TASK.sessionKey,
      stream: 'tool',
      data: { name: 'shell', toolCallId: 'tc-1', ...data },
    });

  it('result-only events do not invent a start time after completion', () => {
    const h = createHarness();
    emitTool(h, { phase: 'result' });
    expect(h.messageStore.upsertToolCall).toHaveBeenCalledWith(
      TASK.sessionKey,
      TASK.id,
      expect.objectContaining({ startedAt: '', status: 'done' }),
    );
  });

  it('result events preserve the active turn start before canonical history exists', () => {
    const h = createHarness();
    h.messageStore.activeTurnBySession[TASK.sessionKey] = {
      toolCalls: [{ id: 'tc-1', startedAt: '2026-09-29T14:39:37.150Z' }],
    };
    emitTool(h, { phase: 'result' });
    expect(h.messageStore.upsertToolCall).toHaveBeenCalledWith(
      TASK.sessionKey,
      TASK.id,
      expect.objectContaining({ startedAt: '2026-09-29T14:39:37.150Z' }),
    );
  });

  it('⭐⭐ `phase:"input_delta"` ⇒ 记 `ignored_phase`（**实测第五个，我们的清单漏了它**）', () => {
    const h = createHarness();

    emitTool(h, { phase: 'input_delta' });

    expect(h.deps.reportDebugEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'renderer.agent.tool.ignored_phase',
        data: expect.objectContaining({ phase: 'input_delta' }),
      }),
    );
  });

  it.each(['start', 'update', 'review'])(
    '⭐ `phase:"%s"` ⇒ 记 `ignored_phase`（已知非终态：卡片停在"进行中"就是对的）',
    (phase) => {
      const h = createHarness();

      emitTool(h, { phase });

      expect(h.deps.reportDebugEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'renderer.agent.tool.ignored_phase',
          data: expect.objectContaining({ phase }),
        }),
      );
    },
  );

  it('⭐⭐ **认不出的** phase ⇒ 记 `unknown_phase` 并带上取值', () => {
    const h = createHarness();

    emitTool(h, { phase: 'some_future_phase' });

    expect(h.deps.reportDebugEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'renderer.agent.tool.unknown_phase',
        data: expect.objectContaining({ phase: 'some_future_phase' }),
      }),
    );
  });

  it('⚠️ `phase` 整个缺失 ⇒ 也留痕，用 `(missing)`', () => {
    const h = createHarness();

    emitTool(h, { phase: undefined });

    expect(h.deps.reportDebugEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'renderer.agent.tool.unknown_phase',
        data: expect.objectContaining({ phase: '(missing)' }),
      }),
    );
  });

  it('对照：`phase:"result"`（**终态**，会改卡片状态）不记那两个', () => {
    const h = createHarness();

    emitTool(h, { phase: 'result' });

    expect(h.messageStore.upsertToolCall).toHaveBeenCalled();
    expect(h.deps.reportDebugEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'renderer.agent.tool.unknown_phase' }),
    );
    expect(h.deps.reportDebugEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'renderer.agent.tool.ignored_phase' }),
    );
  });

  it('对照：`phase:"error"`（防守用的、运行时**不发**的值）也不记', () => {
    const h = createHarness();

    emitTool(h, { phase: 'error' });

    expect(h.deps.reportDebugEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'renderer.agent.tool.unknown_phase' }),
    );
  });

  it('⚠️ 缺 `name`/`toolCallId` 的帧从前**静默 return**（卡片永远不出现）⇒ 现在留痕', () => {
    const h = createHarness();

    h.emit('agent', { sessionKey: TASK.sessionKey, stream: 'tool', data: { phase: 'result' } });

    expect(h.deps.reportDebugEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'renderer.agent.tool.dropped_missing_fields',
        data: expect.objectContaining({ hasName: false, hasToolCallId: false, phase: 'result' }),
      }),
    );
  });

  it('⭐⭐ 冻结名单：运行时发过的**每一个** phase 都说得出归哪一类', () => {
    // 这条是**灵敏度哨兵**：上游加了相位、或我们把某个相位从名单里删掉，这里都会红。
    // 归类只有三种，且必须穷尽 —— "落在 `unknown` 里" 不该是**默认**结果，只该是意外。
    expect(TOOL_PHASE_IDS).toEqual(['start', 'result', 'update', 'review', 'input_delta']);

    const handled = new Set(['result', 'error']);
    const ignored = new Set(TOOL_IGNORED_PHASES);
    for (const phase of TOOL_PHASE_IDS) {
      const inHandled = handled.has(phase);
      const inIgnored = ignored.has(phase);
      expect(inHandled || inIgnored, `phase "${phase}" 既没被处理也不在"知道但不接"名单里`).toBe(true);
      expect(inHandled && inIgnored, `phase "${phase}" 同时落在两个名单里`).toBe(false);
    }
    // 反向：名单里不许出现运行时根本不发的值（否则"知道"是假的 —— `error` 就是这种，
    // 所以它**故意**不在这两个名单里，它是我们自己的防守分支）。
    for (const phase of ignored) {
      expect(TOOL_PHASE_IDS, `"知道但不接"名单里的 "${phase}" 运行时并不发`).toContain(phase as never);
    }
  });
});

/**
 * `item` 流 —— **最后一个**没有"认不出就留痕"的处理点。
 *
 * 两个词表都是运行时**自己的类型**定义的（不是我们扫出来的）：
 * `src/infra/agent-activity-events.ts`
 *
 * ```ts
 * type AgentItemEventPhase  = "start" | "update" | "end";                      // 三个
 * type AgentItemEventStatus = "running" | "completed" | "failed" | "blocked";  // 四个
 * type AgentItemEventKind   = "tool" | "command" | "patch" | "search" | "analysis" | (string & {});
 * ```
 *
 * ⚠️ 跑一遍下来发现**前两处都有静默**：
 * 1. `kind:"tool"` 但缺 `toolCallId`/`name` 的帧**直接 `return`**（卡片永远不出现、日志一行没有）；
 * 2. 认不出的 `status` 会被**默默归类** —— `phase:"end"` 落 `done`、`start`/`update` 落 `running`。
 *    后者正是 `blocked` 当初那条老路（`fc4afa3`）：**帧序在兜底，不是我们认对了**。
 */
describe('item 流的两个词表：未处理的取值要留痕', () => {
  const emitItem = (h: ReturnType<typeof createHarness>, data: Record<string, unknown>) =>
    h.emit('agent', { sessionKey: TASK.sessionKey, stream: 'item', data });

  it('⭐ `kind:"tool"` 却缺 `toolCallId` ⇒ 从前**静默 return**（卡片永远不出现）⇒ 现在留痕', () => {
    const h = createHarness();

    emitItem(h, { kind: 'tool', phase: 'end', name: 'ls', status: 'completed' });

    expect(h.deps.reportDebugEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'renderer.agent.item.dropped_missing_fields',
        data: expect.objectContaining({ hasToolCallId: false, hasName: true, phase: 'end', status: 'completed' }),
      }),
    );
    expect(h.messageStore.upsertToolCall).not.toHaveBeenCalled();
  });

  it('⭐ 缺 `name` 同样留痕', () => {
    const h = createHarness();

    emitItem(h, { kind: 'tool', phase: 'end', toolCallId: 'tc-1', status: 'completed' });

    expect(h.deps.reportDebugEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'renderer.agent.item.dropped_missing_fields',
        data: expect.objectContaining({ hasToolCallId: true, hasName: false }),
      }),
    );
  });

  /**
   * ⚠️ **这条用例原来断言的是单个 `classifiedAs: 'done'`，而那是一条形同虚设的断言**：
   *    变异验证实测，把 `classifiedAs` 硬编码成 `'done'` 后 **191 条用例一条都不红**。
   *    原因很简单 —— 输入固定、期望值也固定，一个常量就能满足，等于没在测。
   *
   * ⇒ 改成**两个会产生不同归类的输入**：`phase:"end"` ⇒ `done`、`phase:"start"` ⇒ `running`。
   *    任何硬编码都**不可能同时满足**这两条。这才是"记下我们把它归成了什么"该有的强度。
   */
  it.each([
    ['end', 'done'],
    // 【V2 白名单】start ⇒ dispatched（调用进入处理；running 只留给有执行证据的适配器）
    ['start', 'dispatched'],
  ])('⭐⭐ 认不出的 `status` ⇒ 记 `unknown_status`，并如实记下归类（phase=%s ⇒ %s）', (phase, expectedClassifiedAs) => {
    const h = createHarness();

    emitItem(h, { kind: 'tool', phase, toolCallId: 'tc-1', name: 'ls', status: 'some_future_status' });

    expect(h.deps.reportDebugEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'renderer.agent.item.unknown_status',
        data: expect.objectContaining({
          status: 'some_future_status',
          phase,
          // 顺手记下**我们把它归成了什么** —— 否则光看日志没法判断影响面。
          classifiedAs: expectedClassifiedAs,
        }),
      }),
    );
  });

  it('⚠️ `status` 整个缺失 ⇒ 也留痕（用 `(missing)`）', () => {
    const h = createHarness();

    emitItem(h, { kind: 'tool', phase: 'end', toolCallId: 'tc-1', name: 'ls' });

    expect(h.deps.reportDebugEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'renderer.agent.item.unknown_status',
        data: expect.objectContaining({ status: '(missing)' }),
      }),
    );
  });

  it('⭐⭐ **行为刻意不变**：认不出的 status + `phase:"end"` 仍然落 `done`（不知道就别改它的样子）', () => {
    // 这是个**判断**，理由写在这里：`phase:"end"` 说的是"这条目结束了"，
    // 而 `running` 是**确定的错**（它确实结束了）；改成 `error` 则是朝另一个方向猜。
    // ⇒ 认不出时**保留原有归类**，只在日志里把它点出来 —— 那才是能让人来修的东西。
    const h = createHarness();

    emitItem(h, { kind: 'tool', phase: 'end', toolCallId: 'tc-1', name: 'ls', status: 'some_future_status' });

    const calls = h.messageStore.upsertToolCall.mock.calls;
    expect((calls[calls.length - 1]![2] as { status: string }).status).toBe('done');
  });

  it.each(['running', 'completed', 'failed', 'blocked'])('对照：已知 status `%s` 不记 `unknown_status`', (status) => {
    const h = createHarness();

    emitItem(h, { kind: 'tool', phase: 'end', toolCallId: 'tc-1', name: 'ls', status });

    expect(h.deps.reportDebugEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'renderer.agent.item.unknown_status' }),
    );
  });

  it('⭐⭐ 冻结名单：两个词表都来自运行时的类型，且分类**穷尽**', () => {
    // 灵敏度哨兵：上游加了取值、或我们把某个值从名单里删掉，这里都会红。
    expect(ITEM_PHASE_IDS).toEqual(['start', 'update', 'end']);
    expect(ITEM_STATUS_IDS).toEqual(['running', 'completed', 'failed', 'blocked']);

    // 四个 status 必须**说得出**归哪一类，且只归一类。
    // `error` 是容错多出来的，不在运行时词表里（所以它不参与这条断言）。
    const failure = new Set(ITEM_FAILURE_STATUSES);
    const nonFailure = new Set(['running', 'completed']);
    for (const status of ITEM_STATUS_IDS) {
      const inFailure = failure.has(status);
      const inNonFailure = nonFailure.has(status);
      expect(inFailure || inNonFailure, `status "${status}" 既不在失败集也不在非失败集`).toBe(true);
      expect(inFailure && inNonFailure, `status "${status}" 同时落在两个集合里`).toBe(false);
    }
    // 反向：失败集里**允许**有词表外的容错值（`error`），但要显式知道它是谁。
    expect([...failure].filter((s) => !ITEM_STATUS_IDS.includes(s))).toEqual(['error']);
  });

  it('冻结名单：三个 phase 里只有 `end` 算"结束"（这条钉的是分类本身）', () => {
    const h = createHarness();

    emitItem(h, { kind: 'tool', phase: 'start', toolCallId: 'tc-1', name: 'ls', status: 'running' });

    const calls = h.messageStore.upsertToolCall.mock.calls;
    // 【V2 白名单】start 归 dispatched（非终态 ⇒ 调用进入处理）
    expect((calls[calls.length - 1]![2] as { status: string }).status).toBe('dispatched');
  });

  /**
   * ⭐⭐ `phase` 的护栏 —— 之前**只有常量没有护栏**。
   *
   * `ITEM_PHASE_IDS` 早就定义了（还带灵敏度哨兵用例），但**生产代码里一次都没用过**：
   * `status` 有 `unknown_status`，`tool` 流的 `phase` 也有 `unknown_phase`，
   * 唯独 `item` 的 `phase` 是**裸奔**的。
   *
   * ## 为什么这条值得防
   *
   * 判"结没结束"全靠这一行：`const settled = data.phase === 'end' || failed;`
   * ⇒ 运行时**若给 item 加一个表示"结束"的新相位**，`settled` 会是 `false`，
   *   条目**永远停在"进行中"**（卡片一直转），而且**一声不响**。
   *
   * 这不是假想：`tool` 流的 `phase` 就真从 4 个长到过 5 个（漏掉 `input_delta`，
   * 见本文件 `tool` 流那一节）。同一条河，`item` 这边没有护栏。
   *
   * ⚠️ **行为刻意不变**：与 `unknown_status` 同一条纪律 ——
   *    "不知道就别改它的样子，但要留下能被查的痕迹"。所以这里既断言**留痕**，
   *    也断言**归类没被改动**。
   */
  it('⭐⭐ 认不出的 `phase` ⇒ 记 `unknown_phase`，**不许默默归类**', () => {
    const h = createHarness();

    // ⚠️ 这里**故意**让 `status` 与 `phase` 的归类不同：`status:"failed"` 无论
    //    `phase` 认不认得出都会归成 `error`，所以 `classifiedAs` 必须记 **`error`**。
    //    若把 `status` 写成 `"running"`，那条断言用硬编码的 `'running'` 也能过
    //    —— 变异测试里这种断言等于没写（本项目栽过这个）。
    emitItem(h, { kind: 'tool', phase: 'some_future_phase', toolCallId: 'tc-1', name: 'ls', status: 'failed' });

    expect(h.deps.reportDebugEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'renderer.agent.item.unknown_phase',
        data: expect.objectContaining({
          phase: 'some_future_phase',
          status: 'failed',
          // 顺手记下**我们把它归成了什么** —— 否则光看日志没法判断影响面。
          classifiedAs: 'error',
        }),
      }),
    );
  });

  it('⚠️ `phase` 整个缺失 ⇒ 也留痕（用 `(missing)`）', () => {
    const h = createHarness();

    emitItem(h, { kind: 'tool', toolCallId: 'tc-1', name: 'ls', status: 'running' });

    expect(h.deps.reportDebugEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'renderer.agent.item.unknown_phase',
        data: expect.objectContaining({ phase: '(missing)' }),
      }),
    );
  });

  it('⚠️ **行为刻意不变**：认不出的 phase 仍然按原判据归类（不知道就别改它的样子）', () => {
    // `phase` 认不出 ⇒ 不满足 `phase === 'end'` ⇒ `settled` 只看 `failed`。
    // 这里给 `status: 'running'`，所以归类**本来就是** dispatched（非终态 ⇒ 调用进入处理；
    // 【V2 白名单】旧口径是 running —— 现在 running 有"执行证据"含义，不再由 item 流产生）
    // 护栏**不许**把它改成别的（那才是朝另一个方向猜）。
    const h = createHarness();

    emitItem(h, { kind: 'tool', phase: 'some_future_phase', toolCallId: 'tc-1', name: 'ls', status: 'running' });

    const calls = h.messageStore.upsertToolCall.mock.calls;
    expect((calls[calls.length - 1]![2] as { status: string }).status).toBe('dispatched');
  });

  it.each(['start', 'update', 'end'])('对照：已知 phase `%s` 不记 `unknown_phase`', (phase) => {
    const h = createHarness();

    emitItem(h, { kind: 'tool', phase, toolCallId: 'tc-1', name: 'ls', status: 'running' });

    expect(h.deps.reportDebugEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'renderer.agent.item.unknown_phase' }),
    );
  });
});

/**
 * `sessions.changed` 的 `reason` —— **没有权威词表**，所以规则不一样。
 *
 * ## 与前面几刀的关键差别
 *
 * 前面几处（`item.status` / `tool.phase` / `chat.state` …）都有运行时的**闭集**，
 * 所以"认不出的"必然是**少数**，逐条留痕是**信号**。
 * 这里不是：运行时的类型就写着
 *
 * ```ts
 * // src/gateway/server-methods/session-change-event.ts
 * type SessionChangedPayload = { …, reason: string, … };   // ← string，没有联合
 * ```
 *
 * **⇒ 无权威词表。** 数出来的已知取值有 **26 个以上**（44 个带字面量 reason 的发射点），
 * 而我们对其中**绝大多数**都是"不处理"。⇒ 如果对每条 `sessions.changed` 都记一条
 * "认不出的 reason"，那不是信号，是**噪音**。
 *
 * ## 所以留痕放在哪儿：**过滤之后**，位置是刻意的
 *
 * `isSystemSession(sessionKey) || !isSubagentSession(sessionKey)` 那道过滤是
 * **设计边界**（非子代理会话的任何 reason 我们都不处理），不是"丢弃"。
 * 而在它**下面**，`reason` 决定要不要把这条会话**提名为对比列**
 * ⇒ **一个没见过的新 reason 在这里是有后果的**。那才值得留痕。
 *
 * ⚠️ 另一头：这份"已知"名单**不是全集也不是证明**，它是**会长的**。
 *    `unknown_reason` 就是让它长的机制 —— 看到一条就从这里补一个。
 *    （记忆里曾把 reason 记成"五个" —— 那份清单本身就是这种"盖子"。）
 */
describe('sessions.changed 的 reason：无权威词表，认不出要留痕', () => {
  /** 真形状：`/^agent:([^:]+):subagent:([a-f0-9-]+)$/`（`shared/src/constants.ts`）。 */
  const SUBAGENT_KEY = 'agent:main:subagent:11111111-2222-3333-4444-555555555555';
  const SYSTEM_KEY = 'agent:main:clawwork:system:memory:a1b2c3d4-e5f6-7890-abcd-ef1234567890';

  const emitSessionChanged = (h: ReturnType<typeof createHarness>, payload: Record<string, unknown>) =>
    h.emit('sessions.changed', { gatewayId: 'gw-1', ...payload });

  /** 让子代理会话能一路走到「提名对比列」那一步。 */
  function asEnsembleTask(h: ReturnType<typeof createHarness>) {
    h.deps.getTaskStore = () => ({ tasks: [{ ...TASK, ensemble: true }], updateTaskTitle: vi.fn() });
    const onPerformerCandidate = vi.fn();
    h.deps.onPerformerCandidate = onPerformerCandidate;
    return onPerformerCandidate;
  }

  it('⭐ 未知 reason（子代理会话）⇒ 留痕一条，带 reason 原值 / sessionKey / 来源', () => {
    const h = createHarness();
    asEnsembleTask(h);

    emitSessionChanged(h, { sessionKey: SUBAGENT_KEY, spawnedBy: TASK.sessionKey, reason: 'some_future_reason' });

    expect(h.deps.reportDebugEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'renderer.session.unknown_reason',
        data: expect.objectContaining({
          reason: 'some_future_reason',
          sessionKey: SUBAGENT_KEY,
          gatewayId: 'gw-1',
        }),
      }),
    );
  });

  it('⭐⭐ **行为不变**（这是刻意的）：未知 reason 照旧走 fallthrough ⇒ 仍然提名对比列', () => {
    // ⚠️ 这条**钉的是现有行为**，不是"我们认为它对"。
    //    口径是「认不出的 reason：**不改行为**、只加留痕」，所以这里只把现状写下来。
    //    留痕的意义**正是**：将来真要决定"新 reason 该不该提名"时，日志里有据可查。
    const h = createHarness();
    const onPerformerCandidate = asEnsembleTask(h);

    emitSessionChanged(h, { sessionKey: SUBAGENT_KEY, spawnedBy: TASK.sessionKey, reason: 'some_future_reason' });

    expect(onPerformerCandidate).toHaveBeenCalledWith('task-1', SUBAGENT_KEY, 'gw-1');
  });

  it('⚠️ `reason` **整个缺失**（畸形帧）⇒ 也留痕，用 `(missing)`', () => {
    const h = createHarness();
    asEnsembleTask(h);

    emitSessionChanged(h, { sessionKey: SUBAGENT_KEY, spawnedBy: TASK.sessionKey });

    expect(h.deps.reportDebugEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'renderer.session.unknown_reason',
        data: expect.objectContaining({ reason: '(missing)' }),
      }),
    );
  });

  it('⭐ 非子代理会话 + 未知 reason ⇒ 过滤照旧（**行为不变，且不记**）', () => {
    // 位置是刻意的：那条过滤是**设计边界**（非子代理会话的任何 reason 都不处理）。
    // 在它上面记 = 对**每一条** sessions.changed 记一条 ⇒ 噪音，没有信号。
    const h = createHarness();

    emitSessionChanged(h, { sessionKey: TASK.sessionKey, reason: 'some_future_reason' });

    expect(h.deps.reportDebugEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'renderer.session.unknown_reason' }),
    );
  });

  it('⭐ 系统会话 + 未知 reason ⇒ 同样被挡在前面，且不记', () => {
    const h = createHarness();

    emitSessionChanged(h, { sessionKey: SYSTEM_KEY, reason: 'some_future_reason' });

    expect(h.deps.reportDebugEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'renderer.session.unknown_reason' }),
    );
  });

  it.each(['delete', 'deleted', 'session-delete'])(
    '对照：已知的删除 reason `%s` ⇒ 走原分支、行为与留痕都不变',
    (reason) => {
      const h = createHarness();
      const onPerformerCandidate = asEnsembleTask(h);

      emitSessionChanged(h, { sessionKey: SUBAGENT_KEY, spawnedBy: TASK.sessionKey, reason });

      expect(h.deps.reportDebugEvent).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'renderer.session.ignored.delete' }),
      );
      expect(onPerformerCandidate, '删掉的会话不许被提名为对比列').not.toHaveBeenCalled();
      expect(h.deps.reportDebugEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ event: 'renderer.session.unknown_reason' }),
      );
    },
  );

  it('⭐ 对照：`compact` 是**已知**的（别把它也记成认不出）', () => {
    const h = createHarness();

    emitSessionChanged(h, { sessionKey: TASK.sessionKey, reason: 'compact', compacted: true });

    expect(h.systemMessages, '压缩提示照旧').toHaveLength(1);
    expect(h.deps.reportDebugEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'renderer.session.unknown_reason' }),
    );
  });

  it('⭐⭐ `compact` 分支**必须仍在过滤之前**（普通会话也收得到）—— 钉住顺序', () => {
    // 这条是给"顺手调顺序"准备的：`compact` 分支若被挪到
    // `isSystemSession || !isSubagentSession` 之后，普通任务会话的压缩就**永远收不到**。
    const h = createHarness();

    // TASK.sessionKey 是**普通任务会话**（不是子代理）——这正是关键。
    emitSessionChanged(h, { sessionKey: TASK.sessionKey, reason: 'compact', compacted: true });

    expect(h.systemMessages, '普通会话的压缩也要说').toHaveLength(1);
  });

  it('⭐⭐ 冻结名单：数出来的 reason 全在里面，且没有塞假的', () => {
    // ⚠️ 这份名单**不是权威闭集**（运行时就是 `string`），它是**数出来的**。
    //    这条用例只保证"我们数过的那些没被误删"，**不保证**它等于全集 ——
    //    这正是它和 `ITEM_STATUS_IDS` 那类常量的**根本区别**。
    // 灵敏度：上游数出来的样本抽查（覆盖常见的、漏了会出事的那几个）。
    for (const r of ['send', 'abort', 'goal', 'create', 'compact', 'delete', 'archive', 'fork', 'checkpoint-branch']) {
      expect(SESSION_CHANGE_REASONS, `数过的 reason "${r}" 不在名单里`).toContain(r);
    }
    expect(SESSION_CHANGE_REASONS.length, '名单短得不像数过').toBeGreaterThanOrEqual(26);
    // 反向：名单里不许塞运行时根本不发的（那等于把"知道"写虚）。
    expect(SESSION_CHANGE_REASONS).not.toContain('some_future_reason');
  });
});

describe('agent lifecycle error buffer', () => {
  it('buffers a lifecycle error for the dedup window, then releases it as a system message', async () => {
    vi.useFakeTimers();
    const h = createHarness();

    emitLifecycleError(h, 'provider unavailable');
    expect(h.systemMessages).toHaveLength(0);
    expect(h.toasts).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(DEDUP_FALLBACK_WINDOW_MS - 1);
    expect(h.systemMessages).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(h.systemMessages).toHaveLength(1);
    expect(h.systemMessages[0].taskId).toBe('task-1');
    expect(h.systemMessages[0].sessionKey).toBe(TASK.sessionKey);
    expect(h.systemMessages[0].content).toContain('provider unavailable');
    expect(h.toasts).toHaveLength(1);
    expect(h.messageStore.addMessage).toHaveBeenCalledWith('task-1', 'system', expect.any(String), undefined, {
      sessionKey: TASK.sessionKey,
    });
  });

  it('clears the buffered lifecycle error when a chat error for the same task arrives first', async () => {
    vi.useFakeTimers();
    const h = createHarness();

    emitLifecycleError(h, 'provider unavailable');
    expect(h.systemMessages).toHaveLength(0);

    emitChatError(h, { errorMessage: 'upstream boom' });
    expect(h.systemMessages).toHaveLength(1);
    expect(h.systemMessages[0].content).toContain('upstream boom');

    await vi.advanceTimersByTimeAsync(DEDUP_FALLBACK_WINDOW_MS);
    expect(h.systemMessages).toHaveLength(1);
    expect(h.systemMessages.some((m) => m.content.includes('provider unavailable'))).toBe(false);
    expect(h.toasts).toHaveLength(1);
  });
});

describe('catalog refresh without dispatcher reset', () => {
  async function connectedHarness() {
    vi.useFakeTimers();
    const h = createHarness();
    h.deps.hydrateFromLocal = vi.fn(async () => {});
    h.deps.gateway.listModels = vi.fn().mockResolvedValue({
      ok: true,
      result: { models: [{ id: 'cli-model', provider: 'codex-cli' }] },
    });
    h.dispatcher.startGatewayStatus();
    h.emitStatus({ gatewayId: 'gw-1', connected: true });
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(h.deps.setModelCatalogForGateway).mockClear();
    return h;
  }

  it('replaces a CLI-only catalog after relay ready using the existing transport and owner', async () => {
    const h = await connectedHarness();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.deps.gateway.listModels).toHaveBeenCalledTimes(1);
    const models = [{ id: 'deepseek-v4-flash', provider: 'clawrouter' }];
    h.deps.gateway.listModels = vi.fn().mockResolvedValue({ ok: true, result: { models } });
    await h.dispatcher.refreshCatalogsForGateway('gw-1', { isCurrent: () => true });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.deps.gateway.listModels).toHaveBeenCalledWith('gw-1', 'main');
    expect(h.deps.setModelCatalogForGateway).toHaveBeenCalledWith('gw-1', models);
    expect(h.deps.hydrateFromLocal).not.toHaveBeenCalled();
    expect(h.deps.setGatewayStatusByGateway).toHaveBeenCalledTimes(1);
  });

  it('does not issue catalog RPCs when the caller scope is already invalid', async () => {
    const h = await connectedHarness();
    h.deps.gateway.listAgents = vi.fn();
    await h.dispatcher.refreshCatalogsForGateway('gw-1', { isCurrent: () => false });
    expect(h.deps.gateway.listAgents).not.toHaveBeenCalled();
    expect(h.deps.setModelCatalogForGateway).not.toHaveBeenCalled();
  });

  it('discards a delayed agent response after the caller scope changes', async () => {
    const h = await connectedHarness();
    let current = true;
    let finish = (_response: { ok: boolean; result: { agents: { id: string }[]; defaultId: string } }) => {};
    h.deps.gateway.listAgents = vi.fn(() => new Promise<Parameters<typeof finish>[0]>((resolve) => (finish = resolve)));
    vi.mocked(h.deps.setAgentCatalogForGateway).mockClear();
    vi.mocked(h.deps.gateway.listModels).mockClear();
    const refresh = h.dispatcher.refreshCatalogsForGateway('gw-1', { isCurrent: () => current });
    current = false;
    finish({ ok: true, result: { agents: [{ id: 'old-owner' }], defaultId: 'old-owner' } });
    await refresh;
    expect(h.deps.setAgentCatalogForGateway).not.toHaveBeenCalled();
    expect(h.deps.gateway.listModels).not.toHaveBeenCalled();
  });

  it.each(['scope', 'disconnect', 'superseded'] as const)(
    'discards delayed model output after %s',
    async (boundary) => {
      const h = await connectedHarness();
      let current = true;
      let finish = (_response: { ok: boolean; result: { models: { id: string }[] } }) => {};
      h.deps.gateway.listModels = vi.fn(
        () => new Promise<Parameters<typeof finish>[0]>((resolve) => (finish = resolve)),
      );
      await h.dispatcher.refreshCatalogsForGateway('gw-1', { isCurrent: () => current });
      if (boundary === 'scope') current = false;
      if (boundary === 'disconnect') h.emitStatus({ gatewayId: 'gw-1', connected: false });
      if (boundary === 'superseded') {
        h.deps.gateway.listModels = vi.fn().mockResolvedValue({ ok: true, result: { models: [{ id: 'new' }] } });
        await h.dispatcher.refreshCatalogsForGateway('gw-1', { isCurrent: () => true });
      }
      finish({ ok: true, result: { models: [{ id: 'old' }] } });
      await vi.advanceTimersByTimeAsync(0);
      expect(h.deps.setModelCatalogForGateway).not.toHaveBeenCalledWith('gw-1', [{ id: 'old' }]);
    },
  );

  it('does not continue empty-catalog retries after scope invalidation', async () => {
    const h = await connectedHarness();
    let current = true;
    h.deps.gateway.listModels = vi.fn().mockResolvedValue({ ok: true, result: { models: [] } });
    await h.dispatcher.refreshCatalogsForGateway('gw-1', { isCurrent: () => current });
    await vi.advanceTimersByTimeAsync(0);
    current = false;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.deps.gateway.listModels).toHaveBeenCalledTimes(1);
    expect(h.deps.setModelCatalogForGateway).not.toHaveBeenCalled();
  });

  it('retains the existing finite empty-catalog retry budget', async () => {
    const h = await connectedHarness();
    h.deps.gateway.listModels = vi.fn().mockResolvedValue({ ok: true, result: { models: [] } });
    await h.dispatcher.refreshCatalogsForGateway('gw-1', { isCurrent: () => true });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.deps.gateway.listModels).toHaveBeenCalledTimes(7);
    expect(h.deps.setModelCatalogForGateway).toHaveBeenLastCalledWith('gw-1', []);
  });

  it('retains a pending dispatch and rejects foreign run frames after catalog refresh', async () => {
    const h = await connectedHarness();
    const ticket = h.dispatcher.beginDispatch('gw-1', TASK.sessionKey);
    h.emit('chat', { sessionKey: TASK.sessionKey, runId: 'run-current', state: 'delta', deltaText: 'buffered' });
    expect(h.messageStore.appendStreamDelta).not.toHaveBeenCalled();
    await h.dispatcher.refreshCatalogsForGateway('gw-1', { isCurrent: () => true });
    h.dispatcher.settleDispatch(ticket, { sessionKey: TASK.sessionKey, runId: 'run-current' });
    expect(h.messageStore.appendStreamDelta).toHaveBeenCalledWith(TASK.sessionKey, 'buffered');
    vi.mocked(h.messageStore.appendStreamDelta).mockClear();
    h.emit('chat', { sessionKey: TASK.sessionKey, runId: 'run-foreign', state: 'delta', deltaText: 'wrong' });
    expect(h.messageStore.appendStreamDelta).not.toHaveBeenCalled();
  });

  it('retains user stop markers and closed streams across catalog refresh', async () => {
    const h = await connectedHarness();
    h.dispatcher.markAbortedByUser(TASK.id);
    await h.dispatcher.refreshCatalogsForGateway('gw-1', { isCurrent: () => true });
    h.emit('chat', { sessionKey: TASK.sessionKey, state: 'aborted' });
    expect(h.systemMessages).toHaveLength(0);
    await h.dispatcher.refreshCatalogsForGateway('gw-1', { isCurrent: () => true });
    h.emit('chat', { sessionKey: TASK.sessionKey, state: 'delta', deltaText: 'late' });
    expect(h.messageStore.appendStreamDelta).not.toHaveBeenCalled();
  });
});

describe('catalog ownership', () => {
  function connect(catalog: { defaultId?: string; agents: Array<{ id: string }> }) {
    const h = createHarness();
    h.deps.gateway.listAgents = vi.fn().mockResolvedValue({ ok: true, result: catalog });
    h.deps.gateway.listModels = vi.fn().mockResolvedValue({ ok: true, result: { models: [{ id: 'owned' }] } });
    h.deps.gateway.getSkillsStatus = vi.fn().mockResolvedValue({ ok: true, result: { skills: [] } });
    h.deps.gateway.getToolsCatalog = vi.fn().mockResolvedValue({ ok: true, result: {} });
    h.deps.gateway.listCommands = vi.fn().mockResolvedValue({ ok: true, result: { commands: [] } });
    h.dispatcher.startGatewayStatus();
    return h;
  }

  it('passes the validated management owner to every scoped catalog, not the first agent', async () => {
    vi.useFakeTimers();
    const h = connect({ defaultId: 'office', agents: [{ id: 'video' }, { id: 'office' }] });
    h.emitStatus({ gatewayId: 'gw-1', connected: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.deps.gateway.listModels).toHaveBeenCalledWith('gw-1', 'office');
    expect(h.deps.gateway.getSkillsStatus).toHaveBeenCalledWith('gw-1', 'office');
    expect(h.deps.gateway.getToolsCatalog).toHaveBeenCalledWith('gw-1', 'office');
    expect(h.deps.gateway.listCommands).toHaveBeenCalledWith('gw-1', expect.objectContaining({ agentId: 'office' }));
  });

  it.each([undefined, '', 'missing'])('fails closed for multi-agent default %s', async (defaultId) => {
    vi.useFakeTimers();
    const h = connect({ defaultId, agents: [{ id: 'video' }, { id: 'office' }] });
    h.emitStatus({ gatewayId: 'gw-1', connected: true });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.deps.gateway.listModels).not.toHaveBeenCalled();
    expect(h.deps.gateway.getSkillsStatus).not.toHaveBeenCalled();
    expect(h.deps.gateway.getToolsCatalog).not.toHaveBeenCalled();
    expect(h.deps.gateway.listCommands).not.toHaveBeenCalled();
    expect(h.deps.setModelCatalogFailureForGateway).toHaveBeenLastCalledWith('gw-1', true);
  });

  it('uses the sole agent when the runtime has no default', async () => {
    vi.useFakeTimers();
    const h = connect({ agents: [{ id: 'office' }] });
    h.emitStatus({ gatewayId: 'gw-1', connected: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.deps.gateway.listModels).toHaveBeenCalledWith('gw-1', 'office');
  });

  it('keeps the same owner on model retries', async () => {
    vi.useFakeTimers();
    const h = connect({ defaultId: 'office', agents: [{ id: 'video' }, { id: 'office' }] });
    h.deps.gateway.listModels = vi.fn().mockResolvedValue({ ok: true, result: { models: [] } });
    h.emitStatus({ gatewayId: 'gw-1', connected: true });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(vi.mocked(h.deps.gateway.listModels).mock.calls.length).toBeGreaterThan(1);
    expect(vi.mocked(h.deps.gateway.listModels).mock.calls.every((args) => args[1] === 'office')).toBe(true);
  });

  it('discards old connection catalog responses after a reconnect changes owner', async () => {
    vi.useFakeTimers();
    const h = connect({ defaultId: 'office', agents: [{ id: 'video' }, { id: 'office' }] });
    let resolveOld: (value: { ok: boolean; result: { models: Array<{ id: string }> } }) => void = () => {};
    h.deps.gateway.listModels = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValue({ ok: true, result: { models: [{ id: 'new' }] } });
    h.emitStatus({ gatewayId: 'gw-1', connected: true });
    await vi.advanceTimersByTimeAsync(0);
    h.emitStatus({ gatewayId: 'gw-1', connected: false });
    h.deps.gateway.listAgents = vi
      .fn()
      .mockResolvedValue({ ok: true, result: { defaultId: 'video', agents: [{ id: 'office' }, { id: 'video' }] } });
    h.emitStatus({ gatewayId: 'gw-1', connected: true });
    await vi.advanceTimersByTimeAsync(0);
    resolveOld({ ok: true, result: { models: [{ id: 'old' }] } });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.deps.setModelCatalogForGateway).toHaveBeenLastCalledWith('gw-1', [{ id: 'new' }]);
    expect(h.deps.setModelCatalogForGateway).not.toHaveBeenCalledWith('gw-1', [{ id: 'old' }]);
  });
});

describe('fetchCatalogs — 网关冷目录返回空时要退避重试', () => {
  // 背景（2026-09-11 实测）：openclaw 的 models.list 对目录加载有 750ms 超时，
  // 超时后**直接返回空目录**（dist/model-catalog-browse-*.mjs: `return { entries: [], routeVariants: [] }`），
  // 日志里那句 "using the prepared catalog when available" 会误导人以为它退了缓存。
  // 客户端在网关刚 ready 时重连必然撞上这个窗口；若把空目录当成最终结果缓存下来，
  // 模型下拉会**永久**显示「暂无可用模型」，直到下次重连。
  function connectWith(listModels: () => Promise<{ ok: boolean; result?: unknown }>) {
    const h = createHarness();
    h.deps.gateway.listModels = listModels as unknown as typeof h.deps.gateway.listModels;
    h.dispatcher.startGatewayStatus();
    h.emitStatus({ gatewayId: 'gw-1', connected: true });
    return h;
  }

  it('首次为空时退避重试，最终把非空目录写进 store', async () => {
    vi.useFakeTimers();
    const models = [{ id: 'deepseek-v4-flash', provider: 'clawrouter' }];
    let calls = 0;
    const h = connectWith(async () => {
      calls += 1;
      return calls === 1 ? { ok: true, result: { models: [] } } : { ok: true, result: { models } };
    });

    await vi.advanceTimersByTimeAsync(10_000);

    expect(calls).toBeGreaterThan(1);
    expect(h.deps.setModelCatalogForGateway).toHaveBeenLastCalledWith('gw-1', models);
  });

  it('一直为空时重试有上限，不会无限打网关', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const h = connectWith(async () => {
      calls += 1;
      return { ok: true, result: { models: [] } };
    });

    await vi.advanceTimersByTimeAsync(120_000);

    // 退避预算约 60 秒（覆盖网关冷启动窗口），上限 = 1 次首取 + 6 次重试。
    expect(calls).toBeGreaterThan(1);
    expect(calls).toBeLessThanOrEqual(7);
    expect(h.deps.setModelCatalogForGateway).toHaveBeenLastCalledWith('gw-1', []);
  });
});

describe('fetchCatalogs —— 目录**取失败**也要进退避，用尽后落显式失败态', () => {
  // 背景（2026-09-20，用户报障「一直卡在加载模型」）：
  // 上面那条退避只在"**有回包**但目录为空"时才启动。而取失败的三种形态 ——
  // `ok:false` / `ok:true` 但没有 `models` 字段 / 直接抛异常 —— 原来的处理是
  // **什么都不做**（只有一句 console.warn），于是 store 里那个网关的目录
  // **永远是 `undefined`**，界面把 `undefined` 读成"正在准备模型…" ⇒ **永远在加载**。
  // 修法：取失败与"空目录"走**同一条**有界退避（同一个预算、同一批延迟），
  // 退避用尽后落一个**显式失败态**（不是"没有模型"，也不是"还在加载"）。
  function connectWith(listModels: () => Promise<{ ok: boolean; result?: unknown }>) {
    const h = createHarness();
    h.deps.gateway.listModels = listModels as unknown as typeof h.deps.gateway.listModels;
    h.dispatcher.startGatewayStatus();
    h.emitStatus({ gatewayId: 'gw-1', connected: true });
    return h;
  }

  it('listModels 一直 ok:false ⇒ 会重试，用尽后落显式失败态', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const h = connectWith(async () => {
      calls += 1;
      return { ok: false, error: 'gateway not ready' };
    });

    await vi.advanceTimersByTimeAsync(120_000);

    expect(calls).toBeGreaterThan(1);
    expect(calls).toBeLessThanOrEqual(7);
    expect(h.deps.setModelCatalogFailureForGateway).toHaveBeenLastCalledWith('gw-1', true);
    // 「取不到」**不许**被写成「确实没有模型」—— 那是替网关下结论。
    expect(h.deps.setModelCatalogForGateway).not.toHaveBeenCalled();
  });

  it('listModels 抛异常 ⇒ 同样进退避并落失败态（原来只有一句 console.warn）', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const h = connectWith(async () => {
      calls += 1;
      throw new Error('gateway connection closed');
    });

    await vi.advanceTimersByTimeAsync(120_000);

    expect(calls).toBeGreaterThan(1);
    expect(calls).toBeLessThanOrEqual(7);
    expect(h.deps.setModelCatalogFailureForGateway).toHaveBeenLastCalledWith('gw-1', true);
  });

  it('ok:true 但没有 models 字段 ⇒ 也算取不到，进退避', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const h = connectWith(async () => {
      calls += 1;
      return { ok: true, result: { entries: [] } };
    });

    await vi.advanceTimersByTimeAsync(120_000);

    expect(calls).toBeGreaterThan(1);
    expect(h.deps.setModelCatalogFailureForGateway).toHaveBeenLastCalledWith('gw-1', true);
  });

  it('⭐ 失败几次后成功 ⇒ 落真目录（失败态不是终点，退避链会自己走出去）', async () => {
    vi.useFakeTimers();
    const models = [{ id: 'deepseek-v4-flash', provider: 'clawrouter' }];
    let calls = 0;
    const h = connectWith(async () => {
      calls += 1;
      return calls === 1 ? { ok: false, error: 'not ready' } : { ok: true, result: { models } };
    });

    await vi.advanceTimersByTimeAsync(10_000);

    expect(calls).toBeGreaterThan(1);
    expect(h.deps.setModelCatalogForGateway).toHaveBeenLastCalledWith('gw-1', models);
    // 落目录那一刻"取不到"就该归位。⚠️ 2026-09-20 复核拍板：**清理由 store 的
    // `setModelCatalogForGateway` 原子完成**，dispatcher 里那两处显式清是冗余的、已删。
    // 所以这里不再断言"最后调了一次 (gw,false)"（那其实钉的是**起链时**那次归位），
    // 改成钉住更要紧的那件事：**成功这一路从没把标记写成 true**（写脏了才是真 bug）。
    expect(h.deps.setModelCatalogFailureForGateway).not.toHaveBeenCalledWith('gw-1', true);
  });
});

describe('run_status —— 网关的准备进度要显示出来，不能静默丢', () => {
  // 背景（2026-09-11 实测）：一条 2 字消息发出后有 9 秒界面毫无反应，
  // 网关这 9 秒一直在报 preparing_workspace，被 switch 的 default 分支丢掉了。
  function emitRunStatus(h: ReturnType<typeof createHarness>, phase: unknown) {
    h.emit('agent', { sessionKey: TASK.sessionKey, stream: 'run_status', data: { phase } });
  }

  it('preparing_workspace 落到 store', () => {
    const h = createHarness();
    emitRunStatus(h, 'preparing_workspace');
    expect(h.messageStore.setRunPhase).toHaveBeenCalledWith(TASK.sessionKey, 'preparing_workspace');
  });

  it('认不出的 phase 也照样透传（界面自己退化成泛化文案），不丢', () => {
    const h = createHarness();
    emitRunStatus(h, 'some_brand_new_phase');
    expect(h.messageStore.setRunPhase).toHaveBeenCalledWith(TASK.sessionKey, 'some_brand_new_phase');
  });

  it('phase 缺失/非字符串时不写 store（免得把状态写成 undefined）', () => {
    const h = createHarness();
    emitRunStatus(h, undefined);
    emitRunStatus(h, 42);
    expect(h.messageStore.setRunPhase).not.toHaveBeenCalled();
  });

  it('lifecycle.start **不**清 —— 实测 starting_model 会比 start 晚到，清了会被覆盖回去', () => {
    const h = createHarness();
    h.emit('agent', { sessionKey: TASK.sessionKey, stream: 'lifecycle', data: { phase: 'start' } });
    expect(h.messageStore.setRunPhase).not.toHaveBeenCalled();
  });

  it('lifecycle.end 时清掉', () => {
    const h = createHarness();
    h.emit('agent', { sessionKey: TASK.sessionKey, stream: 'lifecycle', data: { phase: 'end' } });
    expect(h.messageStore.setRunPhase).toHaveBeenCalledWith(TASK.sessionKey, null);
  });

  /**
   * ⚠️ 网关实际会发的准备阶段有 **七个**，我们此前只认三个。
   *
   * 证据（都是随包运行时 2026.9.3 里读出来的，不是猜的）：
   * - schema：`sessions-*.mjs` 的 `ChatRunStartupPhaseSchema` —— 七个字面量，注释写着
   *   *"Coarse startup stages shown while a run has not produced visible activity yet"*；
   * - emit 点：`chat-send-handler-*.mjs`（`preparing_workspace` / `naming_worktree` /
   *   `running_setup` / `creating_worktree`）与 `server-worker-placement-startup-*.mjs`
   *   （`provisioning_environment`）。
   *
   * ⇒ 认不出的那四个会退化成泛化文案「正在准备…」，而这四个**恰恰都发生在"还没有任何
   * 可见活动"的那段**（正是用户说的「卡住好久突然跳出来」那段死时间）——
   * 网关明明在报"正在创建工作树"，我们却只说"正在准备"。
   */
  const REAL_STARTUP_PHASES = [
    'preparing_workspace',
    'naming_worktree',
    'creating_worktree',
    'running_setup',
    'provisioning_environment',
    'preparing_context',
    'starting_model',
  ] as const;

  it('⭐ 七个真实准备阶段都要标成 known（否则遥测里全记成"网关发了没见过的东西"）', () => {
    for (const phase of REAL_STARTUP_PHASES) {
      const h = createHarness();
      emitRunStatus(h, phase);
      expect(h.deps.reportDebugEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'renderer.agent.run_status',
          data: expect.objectContaining({ phase, known: true }),
        }),
      );
    }
  });

  it('RUN_PHASE_IDS 覆盖网关的七阶段（渲染层靠它挑文案，少一个就少一句人话）', () => {
    // ⚠️ 原断言是"**恰好等于**那七个"。现在改成"**包含**那七个 + 重试相位"：
    //    前者与"重试"那条新增的已知相位互斥，而这条用例的**本意**是"网关会发的，
    //    我们都要有文案" —— 包含式才是它要的（且更严：少一个仍然会红）。
    for (const phase of REAL_STARTUP_PHASES) {
      expect(RUN_PHASE_IDS, `少了网关会发的相位 ${phase}`).toContain(phase);
    }
    // 重试相位**不是**启动相位（名字里的 startup 是真的在启动），但它同样要有文案
    expect(RUN_PHASE_IDS).toContain(RETRY_RUN_PHASE);
  });
});

describe('thinking —— 模型的推理输出要显示，不能当未知丢掉', () => {
  // 背景（09-11 遥测阈值抓到、09-12 取证）：网关在 **agent 通道** 发
  // `{stream:"thinking", data:{text, delta}}`，而 switch 没有这个分支 → 整段推理被丢。
  //
  // ⚠️ 而且 chat 通道**补不回来**：网关只在 `evt.stream === "assistant"` 时才 emitChatDelta，
  // final 的 `message.content` 只可能是 `[{type:"text"}]`，从不含 thinking 块。
  // 于是客户端那套 `extractThinking` → `appendThinkingDelta` → `ThinkingSection`
  // 在这条链路上一次都不会触发（死代码），必须由 agent 通道喂。
  //
  // 生产实测过最坏情形：`content` 为空、整条回复都在 `reasoning_content` 里，
  // 已被正常计费，而界面上一个字都看不到。
  //
  // 形状证据：客户端日志 91 条 `unknown_stream {stream:"thinking", topLevelKeys:["text","delta"]}`；
  // 产出方 openclaw `builtin-openclaw-FlPOnMHc.mjs:11863`（text=累计快照、delta=本次增量）。
  function emitThinking(h: ReturnType<typeof createHarness>, data: unknown) {
    h.emit('agent', { sessionKey: TASK.sessionKey, stream: 'thinking', data });
  }

  it('{text,delta} 喂给 appendThinkingDelta', () => {
    const h = createHarness();
    emitThinking(h, { text: '先看 A', delta: '先看 A' });
    expect(h.messageStore.appendThinkingDelta).toHaveBeenCalledWith(TASK.sessionKey, '先看 A');
  });

  it('喂的是累计的 text 而不是 delta —— 快照对 store 的 merge 是幂等的，重复投递不会把推理拼接两遍', () => {
    const h = createHarness();
    emitThinking(h, { text: '先看 A', delta: '先看 A' });
    emitThinking(h, { text: '先看 A，再看 B', delta: '，再看 B' });
    expect(h.messageStore.appendThinkingDelta).toHaveBeenLastCalledWith(TASK.sessionKey, '先看 A，再看 B');
  });

  it('text 缺失时退回 delta（不能整条丢）', () => {
    const h = createHarness();
    emitThinking(h, { delta: '只有增量' });
    expect(h.messageStore.appendThinkingDelta).toHaveBeenCalledWith(TASK.sessionKey, '只有增量');
  });

  it('只有 progressTokens 的心跳不产出文本（那是进度计数，不是内容）', () => {
    const h = createHarness();
    emitThinking(h, { progressTokens: 120 });
    expect(h.messageStore.appendThinkingDelta).not.toHaveBeenCalled();
  });

  it('空事件不写 store（免得堆噪音状态）', () => {
    const h = createHarness();
    emitThinking(h, { text: '', delta: '' });
    emitThinking(h, {});
    expect(h.messageStore.appendThinkingDelta).not.toHaveBeenCalled();
  });

  it('修好之后不再上报为未知事件', () => {
    const h = createHarness();
    for (let i = 0; i < 12; i++) emitThinking(h, { text: `推理片段 ${i}`, delta: '' });
    expect(h.deps.reportDebugEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'renderer.agent.unknown_stream.threshold' }),
    );
  });

  it('chat.final 之后再来的 thinking 丢掉，不再往界面堆', () => {
    const h = createHarness();
    h.emit('chat', {
      sessionKey: TASK.sessionKey,
      state: 'final',
      message: { role: 'assistant', content: [{ type: 'text', text: '最终全文' }] },
    });
    h.messageStore.appendThinkingDelta.mockClear();
    emitThinking(h, { text: '收尾之后的推理', delta: '收尾之后的推理' });
    expect(h.messageStore.appendThinkingDelta).not.toHaveBeenCalled();
    expect(h.deps.reportDebugEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'renderer.chat.dropped_after_final' }),
    );
  });

  it('lifecycle.start 之后 thinking 重新接上', () => {
    const h = createHarness();
    h.emit('chat', {
      sessionKey: TASK.sessionKey,
      state: 'final',
      message: { role: 'assistant', content: [{ type: 'text', text: '最终全文' }] },
    });
    h.emit('agent', { sessionKey: TASK.sessionKey, stream: 'lifecycle', data: { phase: 'start' } });
    h.messageStore.appendThinkingDelta.mockClear();
    emitThinking(h, { text: '下一轮', delta: '下一轮' });
    expect(h.messageStore.appendThinkingDelta).toHaveBeenCalledWith(TASK.sessionKey, '下一轮');
  });
});

describe('未知事件种类的告警阈值', () => {
  // 这类问题会反复出现：run_status（9 秒空白）、cron 的 heartbeat（整页白屏）都是这么漏的。
  it('一分钟内超过阈值就额外上报一条，好让它在遥测里被发现', () => {
    vi.useFakeTimers();
    const h = createHarness();
    for (let i = 0; i < 10; i++) {
      h.emit('agent', { sessionKey: TASK.sessionKey, stream: 'some_new_stream', data: {} });
    }
    expect(h.deps.reportDebugEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'renderer.agent.unknown_stream.threshold' }),
    );
  });

  it('没到阈值就不报（避免噪音）', () => {
    vi.useFakeTimers();
    const h = createHarness();
    for (let i = 0; i < 3; i++) {
      h.emit('agent', { sessionKey: TASK.sessionKey, stream: 'some_new_stream', data: {} });
    }
    expect(h.deps.reportDebugEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'renderer.agent.unknown_stream.threshold' }),
    );
  });
});

/**
 * 「**已知**但刻意不接」的流要从告警里摘出去（C2 调查的结论）。
 *
 * 为什么必须摘：这些流**形状已经验过、决定也写下来了**（见队列「未接流」那一节），
 * 它们不是"协议变了"的信号。可它们照样在真实流量里几十上百条地过 ——
 * 实测日志：`command_output` 72 条、`usage` 73 条。让它们占用那 10 次的额度，
 * 等于告警在**正常流量**上响（真实日志里已经响过 9 次），
 * 真正冒出来的新流反而淹在里面看不见。
 *
 * ⚠️ 摘的只是**计数**，不是**观测**：这些流照旧上遥测，只是换一个事件名说
 *    "我知道它、我故意不接"，而不是"我不认识它"。
 */
describe('已知但刻意不接的流：记遥测，但不计入"未知"告警', () => {
  const IGNORED = ['command_output', 'usage', 'patch', 'stdout', 'stderr', 'acp', 'plan'];

  it('⭐ 这些流来一整屏也不该触发"协议变了"的告警', () => {
    vi.useFakeTimers();
    const h = createHarness();
    for (const stream of IGNORED) {
      for (let i = 0; i < 12; i++) {
        h.emit('agent', { sessionKey: TASK.sessionKey, stream, data: {} });
      }
    }
    expect(h.deps.reportDebugEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'renderer.agent.unknown_stream.threshold' }),
    );
  });

  it('⭐ 它们**不占**真未知流的额度（真未知仍要能自己凑够 10 条）', () => {
    vi.useFakeTimers();
    const h = createHarness();
    // 先灌 30 条已知忽略的 —— 老实现会把计数器推到阈值以上
    for (let i = 0; i < 30; i++) {
      h.emit('agent', { sessionKey: TASK.sessionKey, stream: 'command_output', data: {} });
    }
    // 再来 9 条真未知：没到 10，不该报
    for (let i = 0; i < 9; i++) {
      h.emit('agent', { sessionKey: TASK.sessionKey, stream: 'brand_new_stream', data: {} });
    }
    expect(h.deps.reportDebugEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'renderer.agent.unknown_stream.threshold' }),
    );

    // 第 10 条真未知才报
    h.emit('agent', { sessionKey: TASK.sessionKey, stream: 'brand_new_stream', data: {} });
    expect(h.deps.reportDebugEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'renderer.agent.unknown_stream.threshold',
        data: expect.objectContaining({ stream: 'brand_new_stream' }),
      }),
    );
  });

  it('⚠️ 但仍要看得见 —— 换一个名字上遥测，不是"再也不出声"', () => {
    const h = createHarness();
    h.emit('agent', {
      sessionKey: TASK.sessionKey,
      stream: 'command_output',
      data: { itemId: 'command:tc-1', phase: 'delta', output: 'x' },
    });

    expect(h.deps.reportDebugEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'renderer.agent.ignored_stream',
        data: expect.objectContaining({ stream: 'command_output' }),
      }),
    );
    // 不许再叫"未知"
    expect(h.deps.reportDebugEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'renderer.agent.unknown_stream' }),
    );
  });

  it('⭐ 两种不同的未知流**各算各的**（§11：全局计数会误导排查）', () => {
    // 一个全局计数器的话，9 + 9 = 18 早就越过阈值了；
    // 而真实的信号应该是"**同一个**陌生流反复出现"——各 9 条谁都没到 10，都不该报。
    vi.useFakeTimers();
    const h = createHarness();

    for (let i = 0; i < 9; i++) {
      h.emit('agent', { sessionKey: TASK.sessionKey, stream: 'stream_a', data: {} });
      h.emit('agent', { sessionKey: TASK.sessionKey, stream: 'stream_b', data: {} });
    }
    expect(h.deps.reportDebugEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'renderer.agent.unknown_stream.threshold' }),
    );

    // stream_a 再来一条（它自己满 10）⇒ 只报 a，且带上**它自己的**计数
    h.emit('agent', { sessionKey: TASK.sessionKey, stream: 'stream_a', data: {} });
    expect(h.deps.reportDebugEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'renderer.agent.unknown_stream.threshold',
        data: expect.objectContaining({ stream: 'stream_a', count: 10 }),
      }),
    );
    // stream_b 仍然是 9，不该被顺带报出来
    expect(h.deps.reportDebugEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'renderer.agent.unknown_stream.threshold',
        data: expect.objectContaining({ stream: 'stream_b' }),
      }),
    );
  });

  it('⭐ 告警里的 `count` 是**那个流自己**的次数，不是全局累计', () => {
    // 先把别的未知流灌到 9（全局视角下再加 1 就满 10）
    vi.useFakeTimers();
    const h = createHarness();
    for (let i = 0; i < 9; i++) {
      h.emit('agent', { sessionKey: TASK.sessionKey, stream: 'noise_stream', data: {} });
    }

    // 换一个新的流，凑到它自己的第 10 条
    for (let i = 0; i < 10; i++) {
      h.emit('agent', { sessionKey: TASK.sessionKey, stream: 'real_signal', data: {} });
    }

    expect(h.deps.reportDebugEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'renderer.agent.unknown_stream.threshold',
        data: expect.objectContaining({ stream: 'real_signal', count: 10 }),
      }),
    );
  });

  it('窗口按流**各自**重置（一个流的窗口过了，不该把另一个流的计数也清零）', () => {
    vi.useFakeTimers();
    const h = createHarness();

    for (let i = 0; i < 9; i++) h.emit('agent', { sessionKey: TASK.sessionKey, stream: 'stream_a', data: {} });
    vi.advanceTimersByTime(70_000); // a 的窗口作废
    for (let i = 0; i < 5; i++) h.emit('agent', { sessionKey: TASK.sessionKey, stream: 'stream_b', data: {} });
    // b 只到 5，不该报
    expect(h.deps.reportDebugEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'renderer.agent.unknown_stream.threshold' }),
    );
    // a 的窗口过了 ⇒ 从 1 重新数起，要**再满 10 条**才报（不是接着上一次的 9 往下数）
    for (let i = 0; i < 9; i++) h.emit('agent', { sessionKey: TASK.sessionKey, stream: 'stream_a', data: {} });
    expect(h.deps.reportDebugEvent, '第 9 条还不该报（上一次窗口的 9 条必须已经作废）').not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'renderer.agent.unknown_stream.threshold' }),
    );
    h.emit('agent', { sessionKey: TASK.sessionKey, stream: 'stream_a', data: {} });
    expect(h.deps.reportDebugEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'renderer.agent.unknown_stream.threshold',
        data: expect.objectContaining({ stream: 'stream_a', count: 10 }),
      }),
    );
  });

  it('⚠️ 跟踪的流名有**上限**：被挤掉的老流从头数起（那张表不能无界增长）', () => {
    // 键是**外部数据**（网关给的流名）⇒ 不设上限就是一个长驻进程的内存泄漏。
    // 这里盯的是可观测的后果：老流被挤掉之后，它的计数**重新从 1 开始**。
    vi.useFakeTimers();
    const h = createHarness();

    // 100 个不同的陌生流名各来 1 条（超过 64 的上限 ⇒ 最早的会被挤掉）
    for (let i = 0; i < 100; i++) {
      h.emit('agent', { sessionKey: TASK.sessionKey, stream: `flood_${i}`, data: {} });
    }

    for (let i = 0; i < 9; i++) {
      h.emit('agent', { sessionKey: TASK.sessionKey, stream: 'flood_0', data: {} });
    }
    expect(h.deps.reportDebugEvent, 'flood_0 已经被挤掉了，这 9 条是它新一轮的前 9 条').not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'renderer.agent.unknown_stream.threshold' }),
    );

    h.emit('agent', { sessionKey: TASK.sessionKey, stream: 'flood_0', data: {} });
    expect(h.deps.reportDebugEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'renderer.agent.unknown_stream.threshold',
        data: expect.objectContaining({ stream: 'flood_0', count: 10 }),
      }),
    );
  });

  it('认不出的流照旧算未知（名单不是"什么都收"）', () => {
    const h = createHarness();
    h.emit('agent', { sessionKey: TASK.sessionKey, stream: 'stream_from_the_future', data: {} });

    expect(h.deps.reportDebugEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'renderer.agent.unknown_stream',
        data: expect.objectContaining({ stream: 'stream_from_the_future' }),
      }),
    );
  });

  it('⭐ 名单是**冻结**的：加/删一条都必须是有意的（顺带拦住"死条目"）', () => {
    // 这份名单本身就危险：往里塞一个**其实该被盯着**的流，等于把告警调聋。
    // 而它平时是悄悄生效的 —— 所以这里把成员钉死，任何改动都得先改这条用例，
    // 改的时候就必然要回答"为什么"。
    //
    // ⚠️ 同时拦一种特别隐蔽的情形：把**已经有 `case` 分支**的流写进来。
    //    那种条目**永远不会生效**（它到不了 `default`），却会让下一个人以为
    //    "这个流我们决定不接了" —— 与事实相反。
    expect([...DELIBERATELY_IGNORED_STREAMS].sort()).toEqual([
      'acp',
      'command_output',
      'patch',
      'plan',
      'stderr',
      'stdout',
      'usage',
    ]);
  });
});

/**
 * ⭐ 多 agent 场景下，`tools.catalog` / `commands.list` **必须**带上 agentId。
 *
 * 2026-09-17 实机日志：这两条请求分别只发了 `{includePlugins:true}` /
 * `{scope,includeArgs}`，网关回**431 次**
 * `Multiple agents are configured, but this Gateway request has no explicit owner`。
 * 后果不是"少几个工具"，而是**整份目录拿不到** —— composer 的工具菜单与斜杠命令
 * 一直是空的（`toolsRes.ok` 为假，谁都没报错）。
 */
describe('工具目录与斜杠命令必须带 agentId（多 agent 网关拒绝无主请求）', () => {
  it('⭐ 用网关的默认 agent 作为 owner', async () => {
    const h = createHarness();
    h.deps.gateway.listAgents = vi.fn(async () => ({
      ok: true,
      result: { agents: [{ id: 'main' }, { id: 'rongying-content' }], defaultId: 'main' },
    }));
    const getToolsCatalog = vi.fn(async () => ({ ok: true, result: { groups: [] } }));
    const listCommands = vi.fn(async () => ({ ok: true, result: { commands: [] } }));
    h.deps.gateway.getToolsCatalog = getToolsCatalog;
    h.deps.gateway.listCommands = listCommands;

    h.dispatcher.startGatewayStatus();
    h.emitStatus({ gatewayId: 'gw-1', connected: true });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getToolsCatalog).toHaveBeenCalledWith('gw-1', 'main');
    expect(listCommands).toHaveBeenCalledWith('gw-1', expect.objectContaining({ agentId: 'main' }));
  });

  it('网关只报了一个 agent（没有 defaultId）时，退回用那一个', async () => {
    const h = createHarness();
    h.deps.gateway.listAgents = vi.fn(async () => ({ ok: true, result: { agents: [{ id: 'solo' }] } }));
    const getToolsCatalog = vi.fn(async () => ({ ok: true, result: { groups: [] } }));
    h.deps.gateway.getToolsCatalog = getToolsCatalog;

    h.dispatcher.startGatewayStatus();
    h.emitStatus({ gatewayId: 'gw-1', connected: true });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getToolsCatalog).toHaveBeenCalledWith('gw-1', 'solo');
  });
});

describe('重连后与网关对账未决问题', () => {
  // ⚠️ 事件只在**创建时**发一次；断线或进程重启期间挂起的问题不会补发，
  //    不对账就等于隐形挂起（用户消息照样被当成答案吞掉）。
  it('连上（含重连）时触发一次对账，断开时不触发', () => {
    const h = createHarness();
    const syncPendingQuestions = vi.fn();
    h.deps.syncPendingQuestions = syncPendingQuestions;
    h.dispatcher.startGatewayStatus();

    h.emitStatus({ gatewayId: 'gw-1', connected: true });
    expect(syncPendingQuestions).toHaveBeenCalledWith('gw-1');

    syncPendingQuestions.mockClear();
    h.emitStatus({ gatewayId: 'gw-1', connected: false, error: 'boom' });
    expect(syncPendingQuestions).not.toHaveBeenCalled();
  });
});

describe('结构化提问（question.*）事件路由', () => {
  // ⚠️ 回归点：这条链路以前**根本没人接**，事件被静默丢弃 ⇒ 问题一直 pending ⇒
  //    网关把该会话里用户发的每条消息都当成「答案」吃掉（2026-09-17 Word 任务锁死）。
  it('把 question.requested 交给调用方，而不是丢掉', () => {
    const h = createHarness();
    const onQuestionRequested = vi.fn();
    h.deps.onQuestionRequested = onQuestionRequested;

    const payload = {
      id: 'ask_b331b9ae631f740e1cecf8b24115aaf8',
      questions: [
        { questionId: 'doc_type', header: '文档类型', question: '你要什么文档？', options: [{ label: '教案' }] },
      ],
      sessionKey: TASK.sessionKey,
      createdAtMs: 1,
      expiresAtMs: 2,
      status: 'pending',
    };
    h.emit('question.requested', payload);

    expect(onQuestionRequested).toHaveBeenCalledWith('gw-1', payload);
  });

  it('把 question.resolved 交给调用方，用来收掉卡片', () => {
    const h = createHarness();
    const onQuestionResolved = vi.fn();
    h.deps.onQuestionResolved = onQuestionResolved;

    h.emit('question.resolved', { id: 'ask_b331b9ae631f740e1cecf8b24115aaf8', status: 'cancelled' });

    expect(onQuestionResolved).toHaveBeenCalledWith('ask_b331b9ae631f740e1cecf8b24115aaf8');
  });

  it('没接回调也不炸（老版本宿主）', () => {
    const h = createHarness();
    expect(() => h.emit('question.requested', { id: 'ask_1', questions: [] })).not.toThrow();
  });
});

/**
 * ⭐⭐ **审批有四个家族，我们只接了一个。**
 *
 * 权威来源：运行时的 `src/gateway/server-methods-list.ts` 里的 `GATEWAY_EVENTS`
 *（`~/git/openclaw` 0153d84c）—— 那是一份**常量清单**，不是"数出来的"，可以当准。
 *
 * | 家族 | 事件 | 我们 |
 * | --- | --- | --- |
 * | `exec.approval.*` | requested / resolved | ✅ 已接（→ `ApprovalDialog`） |
 * | `question.*` | requested / resolved | ✅ 已接（→ `QuestionPanel`） |
 * | **`plugin.approval.*`** | requested / resolved | ❌ **没接** |
 * | **`openclaw.approval.*`** | requested / resolved | ❌ **没接** |
 * | **`session.approval`** | （单个） | ❌ **没接** |
 *
 * ⚠️ **三个未接的都带 `APPROVALS_SCOPE`，而我们的连接**正好**申请了 `operator.approvals`**
 *    ⇒ **它们真的会送到我们这儿，然后被丢掉**。
 *
 * ⚠️ **后果要说准**（别夸大）：它们**不会永久卡住** —— 网关那侧有自己的审批超时
 *    （`plugin.approval.request` 的注释写着 "Buffer beyond the approval timeout so the
 *    gateway can clean up"，且审批面不可用时直接按 `CANCELLED` 收场）。
 *    **真正的后果是**：用户**永远看不到这个请求** ⇒ 相关能力**静默不可用**。
 *    这与 `exec.approval`（`23e909e`）和 `question.*`（锁死 15 分钟）是**同一类**，
 *    只是有网关上超时兜着，所以没到"卡死"那么严重。
 *
 * ⇒ 这一刀**不改行为**（接不接是产品决定），只做两件事：
 *    ① 把名单写成**可测常量**；② 收到未接的审批事件时记一条**点名**的日志 ——
 *    否则用户报"插件功能用不了"时，我们连"那条请求其实来过"都查不到。
 */
describe('网关事件的审批家族：接了一个，另外三个要留痕', () => {
  const emitEvent = (h: ReturnType<typeof createHarness>, event: string, payload: Record<string, unknown> = {}) =>
    h.emit(event, payload);

  it.each([
    'plugin.approval.requested',
    'plugin.approval.resolved',
    'openclaw.approval.requested',
    'openclaw.approval.resolved',
    'session.approval',
  ])('⭐⭐ `%s` ⇒ 记一条**点名**的 `approval_event.unwired`', (event) => {
    const h = createHarness();

    emitEvent(h, event, { id: 'ap-1' });

    expect(h.deps.reportDebugEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'renderer.gateway.approval_event.unwired',
        data: expect.objectContaining({ event }),
      }),
    );
  });

  it.each(['exec.approval.requested', 'exec.approval.resolved', 'question.requested', 'question.resolved'])(
    '对照：已接的 `%s` **不**记那条（它有自己的去处）',
    (event) => {
      const h = createHarness();

      emitEvent(h, event, { id: 'ap-1' });

      expect(h.deps.reportDebugEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ event: 'renderer.gateway.approval_event.unwired' }),
      );
    },
  );

  it('对照：无关事件（`tick`）也不记（别把"每个事件都记一条"当留痕）', () => {
    const h = createHarness();

    emitEvent(h, 'tick');

    expect(h.deps.reportDebugEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'renderer.gateway.approval_event.unwired' }),
    );
  });

  /**
   * ⭐⭐ 把 `WIRED_APPROVAL_EVENTS` 与**真实的分派代码**绑起来。
   *
   * ## 为什么需要这条
   *
   * 下面那条「冻结名单」断言的是**常量等于一个字面量清单** —— 它只能证明
   * 「常量没被人手抖改过」，**证明不了"这些事件真的接上了"**。
   * 换句话说：`exec.approval.requested` 的处理分支**被删掉**，那条测试照样绿，
   * 而常量会变成一句**没人验证过的声明**。
   *
   * ⇒ 这正是本项目反复栽的那个形状：**清单本身变成盖子** ——
   *   后人看到"已接：exec.approval.requested"，就不会再去数它到底接没接。
   *
   * ## 这条怎么绑
   *
   * **用常量本身驱动**：`WIRED_APPROVAL_EVENTS` 里每有一个成员，就必须
   * ①在下面的映射表里说得出它该走哪个回调、②发出去真的走到那个回调。
   * 少任何一头都红 ⇒ 常量、映射表、分派分支**三者只能一起改**。
   *
   * ⚠️ 与 `ITEM_PHASE_IDS` 那次是**同一类**（定义了却没接线）；
   *    区别是那次常量根本没人用，这次是常量被用在了"断言自己"上。
   */
  const DEP_FOR_WIRED_EVENT: Record<string, string> = {
    'exec.approval.requested': 'onApprovalRequested',
    'exec.approval.resolved': 'onApprovalResolved',
    'question.requested': 'onQuestionRequested',
    'question.resolved': 'onQuestionResolved',
  };

  it.each([...WIRED_APPROVAL_EVENTS].sort())('⭐⭐ 名单里的 `%s` **真的接了**：发出去会走到对应的处理函数', (event) => {
    const depName = DEP_FOR_WIRED_EVENT[event];
    expect(
      depName,
      `${event} 被 WIRED_APPROVAL_EVENTS 声明为"已接"，但映射表里没有它 —— 加成员时两处都要改`,
    ).toBeDefined();

    const h = createHarness();
    const spy = vi.fn();
    (h.deps as unknown as Record<string, unknown>)[depName] = spy;

    emitEvent(h, event, { id: 'ap-1' });

    expect(spy, `${event} 声明为"已接"，但没有任何分派分支走到 ${depName} —— 常量在撒谎`).toHaveBeenCalled();
  });

  it('⭐⭐ 反向：`UNWIRED_APPROVAL_EVENTS` 里的每个都**不该**走到那四个回调', () => {
    // 与上一条对称：名单说"没接"，那就得真的没接（否则既记 unwired 又走了处理，自相矛盾）。
    const wiredDeps = Object.values(DEP_FOR_WIRED_EVENT);
    for (const event of UNWIRED_APPROVAL_EVENTS) {
      const h = createHarness();
      const spies = wiredDeps.map(() => vi.fn());
      wiredDeps.forEach((d, i) => {
        (h.deps as unknown as Record<string, unknown>)[d] = spies[i];
      });

      emitEvent(h, event, { id: 'ap-1' });

      for (let i = 0; i < wiredDeps.length; i++) {
        expect(spies[i], `${event} 声明为"未接"，却走到了 ${wiredDeps[i]}`).not.toHaveBeenCalled();
      }
    }
  });

  it('⭐⭐ 冻结名单：**已接与未接不相交**，且并集 = 运行时审批家族的全名单', () => {
    // 灵敏度哨兵：运行时哪天加了第五个 `*.approval.*`，这里**不会**自动发现
    //（那份名单在运行时里，不在这边）—— 所以下面这条只能保证"我们现有的分类是自洽的"，
    // 并在注释里点明它**不是**自动哨兵。真要做自动哨兵，得把 `GATEWAY_EVENTS` 快照进来。
    const wired = [...WIRED_APPROVAL_EVENTS];
    const unwired = [...UNWIRED_APPROVAL_EVENTS];

    expect(
      wired.filter((e) => UNWIRED_APPROVAL_EVENTS.has(e)),
      '一个事件不能既接又没接',
    ).toEqual([]);
    expect(unwired.filter((e) => WIRED_APPROVAL_EVENTS.has(e))).toEqual([]);

    // 已知的审批家族一个都不能漏（这四条是从运行时清单里逐字抄的）。
    expect(wired.sort()).toEqual(
      ['exec.approval.requested', 'exec.approval.resolved', 'question.requested', 'question.resolved'].sort(),
    );
    expect(unwired.sort()).toEqual(
      [
        'openclaw.approval.requested',
        'openclaw.approval.resolved',
        'plugin.approval.requested',
        'plugin.approval.resolved',
        'session.approval',
      ].sort(),
    );
  });
});

/**
 * ⭐ 临时会话 = 多模型对比的**某一列**（伪设备号 `compare-<id>-<n>`）。
 *
 * 为什么这道闸必须有：对比列的会话键里嵌的是**真** taskId（不这样事件就路由不回原任务），
 * 于是「路由通」把副作用也一起带通了。没有这道闸，用户**没采纳**的回答会被
 * `syncSessionMessages` promote 进任务时间线（界面上凭空多出一轮没发生过的问答）、
 * 报错插 system 消息 + 弹 toast + 把任务标未读、还会拿列里的内容把空标题任务命名。
 *
 * 每条断言都配了**同形状的普通会话对照**：证明差异来自 ephemeral 这个判据，
 * 而不是"事件根本没被处理"。
 */
describe('临时会话（多模型对比的一列）：只有那一列看得到自己，时间线一律不碰', () => {
  /** 第 0 / 1 列（伪设备号，真 taskId 在内）。 */
  const KEY_0 = 'agent:main:clawwork:compare-run-1-0:task:task-1';
  const KEY_1 = 'agent:main:clawwork:compare-run-1-1:task:task-1';

  function createCompareHarness(ephemeralKeys: string[] = [KEY_0, KEY_1]) {
    const h = createHarness();
    const ephemeral = new Set(ephemeralKeys);
    // 判据刻意做成**动态**读 Set：采纳之后赢家会被移出去（转正），这里要能跟着变。
    h.deps.isEphemeralSession = (sessionKey: string) => ephemeral.has(sessionKey);
    const updateTaskTitle = vi.fn();
    h.deps.getTaskStore = () => ({
      tasks: [{ ...TASK, title: '' }],
      updateTaskTitle,
    });
    return { ...h, ephemeral, updateTaskTitle };
  }

  function emitChat(
    h: ReturnType<typeof createHarness>,
    sessionKey: string,
    state: string,
    extra: Record<string, unknown> = {},
  ) {
    h.emit('chat', { sessionKey, state, ...extra });
  }

  /** 网关在 chat 通道发的是**内容块数组**（不是纯字符串），照它的形状来。 */
  function textBlocks(text: string) {
    return { content: [{ type: 'text', text }] };
  }

  it('事件仍然路由到**真**任务：流式照常落在那一列的会话键上', () => {
    const h = createCompareHarness();
    emitChat(h, KEY_0, 'delta', { ...textBlocks('第 1 列的字') });

    // ⚠️ 断言的是"**落到了那一列的会话键上**"，不是"用了哪个 store 动作"——
    //    这条用的是旧形状（`content` 是全文快照）⇒ 现在走 `replaceStreamText`。
    //    见 `extractDeltaText`：content 是全文，追加它会把正文重复膨胀（实测 57 倍）。
    expect(h.messageStore.replaceStreamText).toHaveBeenCalledWith(KEY_0, '第 1 列的字');
    // 没被当成"认不出的会话"丢掉
    expect(h.deps.reportDebugEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'renderer.event.dropped.invalid_task' }),
    );
    // 对照：不是一个对比键的陌生会话仍然会被丢掉
    emitChat(h, 'agent:main:clawwork:someone-else:task:no-such-task', 'delta', { ...textBlocks('x') });
    expect(h.deps.reportDebugEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'renderer.event.dropped.unknown_task' }),
    );
  });

  it('final 之后**不拉网关历史**（这是"没采纳的答案不会自己跑进对话"的关键路径）', () => {
    const h = createCompareHarness();
    const notify = vi.fn();
    h.deps.notifyAgentResponse = notify;

    emitChat(h, KEY_0, 'final', { ...textBlocks('我是千问') });
    expect(h.messageStore.finalizeStream).toHaveBeenCalledWith(KEY_0, expect.anything());
    expect(h.deps.syncSessionMessages).not.toHaveBeenCalled();
    expect(h.messageStore.addMessage).not.toHaveBeenCalled();
    expect(h.deps.markUnread).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();

    // 对照：普通会话的 final 照旧对账 + 标未读 + 通知
    emitChat(h, TASK.sessionKey, 'final', { ...textBlocks('正式回复') });
    expect(h.deps.syncSessionMessages).toHaveBeenCalledWith('task-1', TASK.sessionKey);
    expect(h.deps.markUnread).toHaveBeenCalledWith('task-1');
    expect(notify).toHaveBeenCalledWith(TASK.sessionKey);
  });

  it('final 不改标题：空的标题不会被**没采纳**的那一列命名', () => {
    const h = createCompareHarness();
    // 列的正文留在 activeTurn 里（auto-title 会读它）
    h.messageStore.activeTurnBySession[KEY_0] = {
      content: '这段是没被采纳的答案',
      finalized: true,
    } as unknown as Record<string, unknown>[string];

    emitChat(h, KEY_0, 'final', { ...textBlocks('这段是没被采纳的答案') });
    expect(h.updateTaskTitle).not.toHaveBeenCalled();

    // 对照：同一个任务走普通会话时，标题照常自动起（正文同样在 activeTurn 里）
    h.messageStore.activeTurnBySession[TASK.sessionKey] = {
      content: '被采纳的答案',
      finalized: true,
    } as unknown as Record<string, unknown>[string];
    emitChat(h, TASK.sessionKey, 'final', { ...textBlocks('被采纳的答案') });
    expect(h.updateTaskTitle).toHaveBeenCalledWith('task-1', expect.stringContaining('被采纳的答案'));
  });

  it('N 列同时撞上同一个错误：**每一列都有自己的错误**，谁都不进时间线', () => {
    const h = createCompareHarness();
    for (const key of [KEY_0, KEY_1]) {
      emitChat(h, key, 'error', { errorMessage: 'rate limit exceeded', errorCode: 'rate_limit' });
    }

    expect(h.messageStore.setSessionError).toHaveBeenCalledWith(KEY_0, expect.stringContaining('rate limit exceeded'));
    expect(h.messageStore.setSessionError).toHaveBeenCalledWith(KEY_1, expect.stringContaining('rate limit exceeded'));
    expect(h.messageStore.addMessage).not.toHaveBeenCalled();
    expect(h.toasts).toHaveLength(0);

    // 对照：普通会话的同一个错误照旧进时间线 + 弹一次 toast，且**会被去重**（这正是列不能复用的原因）
    emitChat(h, TASK.sessionKey, 'error', { errorMessage: 'rate limit exceeded', errorCode: 'rate_limit' });
    emitChat(h, TASK.sessionKey, 'error', { errorMessage: 'rate limit exceeded', errorCode: 'rate_limit' });
    expect(h.systemMessages).toHaveLength(1);
    expect(h.toasts).toHaveLength(1);
  });

  it('lifecycle 失败按**会话**缓冲：两列在同一窗口里各报各的，不互相顶掉', async () => {
    vi.useFakeTimers();
    const h = createCompareHarness();
    for (const key of [KEY_0, KEY_1]) {
      h.emit('agent', {
        sessionKey: key,
        stream: 'lifecycle',
        data: { phase: 'error', error: 'provider unavailable' },
      });
    }
    expect(h.messageStore.setSessionError).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(DEDUP_FALLBACK_WINDOW_MS);
    expect(h.messageStore.setSessionError).toHaveBeenNthCalledWith(
      1,
      KEY_0,
      expect.stringContaining('provider unavailable'),
    );
    expect(h.messageStore.setSessionError).toHaveBeenNthCalledWith(
      2,
      KEY_1,
      expect.stringContaining('provider unavailable'),
    );
    expect(h.messageStore.addMessage).not.toHaveBeenCalled();
  });

  it('这一轮起来之后，之前挂起的那条列错误不再补发（不能"正在输出 + 同时报错"）', async () => {
    vi.useFakeTimers();
    const h = createCompareHarness();
    h.emit('agent', {
      sessionKey: KEY_0,
      stream: 'lifecycle',
      data: { phase: 'error', error: 'provider unavailable' },
    });

    // 同一个任务的正式会话开始出字 ⇒ 那条待发的列错误作废
    emitChat(h, TASK.sessionKey, 'delta', { ...textBlocks('正式回复开始了') });
    await vi.advanceTimersByTimeAsync(DEDUP_FALLBACK_WINDOW_MS);

    expect(h.messageStore.setSessionError).not.toHaveBeenCalled();
  });

  it('服务端单方面中断某一列：那一列说出原因，不写时间线', () => {
    const h = createCompareHarness();
    emitChat(h, KEY_0, 'aborted');

    expect(h.messageStore.setSessionError).toHaveBeenCalledWith(KEY_0, 'errors.serverAborted');
    expect(h.messageStore.addMessage).not.toHaveBeenCalled();

    // 对照：普通会话仍是时间线里的 system 消息
    emitChat(h, TASK.sessionKey, 'aborted');
    expect(h.systemMessages).toHaveLength(1);
    expect(h.systemMessages[0].taskId).toBe('task-1');
  });

  /**
   * 迟到的 `aborted` 帧：用户点「取消对比 / 采纳」时，那一列的登记表键**已经摘了**
   * （摘键之后这一帧看起来就是一条普通会话的中断），而「这一轮是用户自己中断的」记在**会话**上。
   *
   * 少了这条判据的表现：一句「被服务端中断」凭空插进对话时间线（+ 标未读 + 弹通知）。
   */
  it('用户自己中断的列：登记表已摘键，迟到的 aborted 帧也不再往时间线里塞话', () => {
    const h = createCompareHarness();
    // 「采纳」那一刻：赢家从登记表里出去（转正），此后它的事件与普通会话无异
    h.ephemeral.delete(KEY_0);
    h.deps.isSessionAbortedByUser = (sessionKey: string) => sessionKey === KEY_0;

    emitChat(h, KEY_0, 'aborted');

    expect(h.systemMessages).toHaveLength(0);
    // 遥测里看得出这是"用户中断"，不是"服务端单方面中断"
    expect(h.deps.reportDebugEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'renderer.chat.aborted',
        data: expect.objectContaining({ sessionKey: KEY_0, userInitiated: true }),
      }),
    );

    // 对照：同一个键、同一帧，只是没有这条判据（老宿主）⇒ system 消息照样进时间线
    h.deps.isSessionAbortedByUser = undefined;
    emitChat(h, KEY_0, 'aborted');
    expect(h.systemMessages).toHaveLength(1);
    expect(h.systemMessages[0].content).toBe('errors.serverAborted');
    expect(h.systemMessages[0].taskId).toBe('task-1');
  });

  it('工具调用照旧记（列里要显示），但不标未读、不发通知', () => {
    const h = createCompareHarness();
    const notify = vi.fn();
    h.deps.notifyAgentResponse = notify;
    const tool = { name: 'search', toolCallId: 'call-1', phase: 'update', args: '{}' };

    h.emit('agent', { sessionKey: KEY_0, stream: 'tool', data: tool });
    expect(h.messageStore.upsertToolCall).toHaveBeenCalledWith(
      KEY_0,
      'task-1',
      expect.objectContaining({ id: 'call-1' }),
    );
    expect(notify).not.toHaveBeenCalled();
    expect(h.deps.markUnread).not.toHaveBeenCalled();

    // 对照：普通会话的工具流会通知 + 标未读
    h.emit('agent', { sessionKey: TASK.sessionKey, stream: 'tool', data: tool });
    expect(notify).toHaveBeenCalledWith(TASK.sessionKey);
    expect(h.deps.markUnread).toHaveBeenCalledWith('task-1');
  });

  it('「已切换到 X」不写进未采纳的列（列标题就是用户挑的模型）', () => {
    const h = createCompareHarness();
    const fallback = {
      phase: 'fallback',
      selectedProvider: 'p1',
      selectedModel: 'qwen-plus',
      activeProvider: 'p2',
      activeModel: 'glm-4.7',
    };

    h.emit('agent', { sessionKey: KEY_0, stream: 'lifecycle', data: fallback });
    expect(h.messageStore.addMessage).not.toHaveBeenCalled();
    // 但遥测照旧记录（这条降级必须看得见）
    expect(h.deps.reportDebugEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'renderer.agent.lifecycle.fallback' }),
    );

    // 对照：普通会话照旧插一条 system 消息
    h.emit('agent', { sessionKey: TASK.sessionKey, stream: 'lifecycle', data: fallback });
    expect(h.systemMessages).toHaveLength(1);
  });

  it('`fallback_cleared`（切回来）走**同一条**纪律：临时会话不写', () => {
    const h = createCompareHarness();

    h.emit('agent', {
      sessionKey: KEY_0,
      stream: 'lifecycle',
      data: {
        phase: 'fallback_cleared',
        selectedProvider: 'p1',
        selectedModel: 'qwen-plus',
        activeProvider: 'p1',
        activeModel: 'qwen-plus',
        previousActiveModel: 'glm-4.7',
      },
    });

    expect(h.messageStore.addMessage, '列标题就是用户挑的模型，不该被这条动到').not.toHaveBeenCalled();
  });

  it('采纳之后那一列"转正"：同一个键不再是临时会话，final 照常对账', () => {
    const h = createCompareHarness();
    emitChat(h, KEY_0, 'final', { ...textBlocks('没采纳') });
    expect(h.deps.syncSessionMessages).not.toHaveBeenCalled();

    // 采纳 = 这一列成为任务的会话（调用方把它从临时集合里移出去）
    h.ephemeral.delete(KEY_0);
    emitChat(h, KEY_0, 'final', { ...textBlocks('采纳了') });
    expect(h.deps.syncSessionMessages).toHaveBeenCalledWith('task-1', KEY_0);
  });
});

/**
 * 工具过程的**数据质量** —— 夹具一律用**真实网关帧**（2026-09-18 从本机
 * `debug-*.ndjson` 原样抄下来的），不再自己编形状。
 *
 * ⚠️ 为什么这条很重要：从前这里（`gateway-dispatcher.test.ts` 老用例）用的是
 * `phase:'update'` + **字符串** args，而真实网关发的是：
 *   - phase 只有 `start` / `result`（**失败是 `result` + `isError:true`，没有 `error` 这个 phase**）
 *   - `args` 是**对象**，不是 JSON 串
 * 假夹具让两个真缺陷长期测不出来：参数被裹成 `{raw:{…}}`、工具真正的输出被整块丢掉。
 * ⇒ 夹具跟真实对不上，测试就是绿的谎话。
 */
/**
 * ⭐⭐ **一条一步都没跑的命令，卡片不许说「已完成」。**
 *
 * 运行时的 `ExecToolDetails.status` 是闭集，里面 **`approval-pending`**
 * =「命令挂起，等人批准」：
 * - 它**不在** `isToolResultError` 的失败清单里（`src/agents/tool-result-error.ts`）；
 * - 那个分支**没有 `exitCode` 字段** ⇒ 判断一路兜底 `return false`；
 * ⇒ 工具流那一帧带的是 **`isError: false`**（fixture 里工具自己的 `isError` 也是 false，
 *   因为命令没抛错，只是被挂起了）。
 *
 * 照 `isError` 直接落地 ⇒ 我们标 **`done`**。而**没有任何后续帧会纠正它**：
 * - `approval` 流的 `pending` 我们刻意不接（记过理由：命令还有可能跑）；
 * - `item` 的 `kind:"command" + status:"blocked"` 也在"刻意不接"名单里；
 * - 合并器**不许降级**（`done` 一旦落下就粘住）。
 *
 * ⚠️ 同族的 `approval-unavailable` **被 approval 流兜住了**（有回归用例钉着，
 * 它的"前置"还显式断言了 tool 流会给 `done`）⇒ **这一刀只认 `approval-pending`**，
 * 不动那条路（要动是另一个决定，不是顺手改）。
 */
describe('exec 停在「等人批准」时，卡片不许说「已完成」', () => {
  type EmittedToolCall = { id: string; status: string; completedAt?: string };

  function lastToolCall(h: ReturnType<typeof createHarness>): EmittedToolCall {
    const calls = h.messageStore.upsertToolCall.mock.calls;
    expect(calls.length, '应该有工具调用被写进 store').toBeGreaterThan(0);
    return calls[calls.length - 1]![2] as EmittedToolCall;
  }

  /** 真实帧：命令挂起等审批 ⇒ 网关报 `isError:false`（字段照抄运行时 fixture）。 */
  function emitParkedExec(h: ReturnType<typeof createHarness>, toolCallId: string): void {
    h.emit('agent', {
      sessionKey: TASK.sessionKey,
      stream: 'tool',
      data: {
        phase: 'result',
        name: 'exec',
        toolCallId,
        meta: 'npm view diver name version description',
        isError: false,
        commandBearing: true,
        result: {
          content: [{ type: 'text', text: 'Command requires approval.' }],
          details: {
            status: 'approval-pending',
            approvalId: '12345678-1234-1234-1234-123456789012',
            approvalSlug: '12345678',
            expiresAtMs: 1_800_000_000_000,
            host: 'gateway',
            command: 'npm view diver name version description',
            cwd: '/tmp/work',
          },
        },
      },
    });
  }

  it('⭐⭐ `details.status:"approval-pending"` + `isError:false` ⇒ **不许** done', () => {
    const h = createHarness();

    emitParkedExec(h, 'call_park');

    const tc = lastToolCall(h);
    expect(tc.status, '命令一步都没跑 ⇒ 说"已完成"是撒谎').not.toBe('done');
    // 【V2 白名单】旧口径 held result 落 running、approval 帧再改判；现在直接落 awaitingApproval。
    expect(tc.status, '它**确实还没结束** ⇒ 诚实的落点是"等待批准"').toBe('awaitingApproval');
  });

  it('⭐ 也**不许**说 error（它没失败，人还没批呢）', () => {
    const h = createHarness();

    emitParkedExec(h, 'call_park');

    expect(lastToolCall(h).status).not.toBe('error');
  });

  it('⭐ 不许填 `completedAt`（没结束却带结束时间，等于把谎话写进数据里）', () => {
    const h = createHarness();

    emitParkedExec(h, 'call_park');

    expect(lastToolCall(h).completedAt).toBeUndefined();
  });

  it('对照：普通结果（没有 `details`）**照样**是 done', () => {
    const h = createHarness();

    h.emit('agent', {
      sessionKey: TASK.sessionKey,
      stream: 'tool',
      data: {
        phase: 'result',
        name: 'ls',
        toolCallId: 'call_ls',
        isError: false,
        result: { content: [{ type: 'text', text: 'a.md' }] },
      },
    });

    expect(lastToolCall(h).status).toBe('done');
  });

  it('⭐⭐ 「审批不可用」**也不许**先落 done（拍板"不让它先闪"，`edbc8ff` 之后扩的）', () => {
    // 从前的理由是"随后会被 `approval` 流压成 error ⇒ **最终**态是对的"。
    // 但那只是最终对：中间会**先闪一下「已完成」**再被纠正 —— 用户看得见，而且是假话。
    // ⇒ 现在两个 status **同一条待遇**：都不许落 done。
    const h = createHarness();

    h.emit('agent', {
      sessionKey: TASK.sessionKey,
      stream: 'tool',
      data: {
        phase: 'result',
        name: 'exec',
        toolCallId: 'call_unavail',
        isError: false,
        result: {
          content: [{ type: 'text', text: 'Command requires approval.' }],
          details: { status: 'approval-unavailable', reason: 'no-approval-channel' },
        },
      },
    });

    const seen = h.messageStore.upsertToolCall.mock.calls.map(
      (c) => (c[2] as { status: string; completedAt?: string }).status,
    );
    expect(seen, '一次都不许落 done —— 落一次就是"闪一下"').not.toContain('done');
    // 【V2 白名单】held result 直接落 awaitingApproval（旧口径 running）
    expect(lastToolCall(h).status).toBe('awaitingApproval');
    expect(lastToolCall(h).completedAt, '没结束却带结束时间，等于把谎话写进数据里').toBeUndefined();
  });
});

describe('tool 流：真实网关帧下的数据质量', () => {
  type EmittedToolCall = {
    id: string;
    name: string;
    status: string;
    args?: unknown;
    result?: string;
    title?: string;
    startedAt?: string;
    completedAt?: string;
  };

  /** 取最近一次 upsertToolCall 落下去的 ToolCall。 */
  function lastToolCall(h: ReturnType<typeof createHarness>): EmittedToolCall {
    const calls = h.messageStore.upsertToolCall.mock.calls;
    expect(calls.length, '应该有工具调用被写进 store').toBeGreaterThan(0);
    return calls[calls.length - 1]![2] as EmittedToolCall;
  }

  it('⭐ args 是对象时原样用，不能裹成 {raw:{…}}（真实网关发的是对象）', () => {
    const h = createHarness();
    h.emit('agent', {
      sessionKey: TASK.sessionKey,
      stream: 'tool',
      data: {
        phase: 'start',
        name: 'memory_search',
        toolCallId: 'call_f1236bd519f54d6e816e79b1',
        args: { query: '游戏 爆款 创作 内容' },
      },
    });

    expect(lastToolCall(h).args).toEqual({ query: '游戏 爆款 创作 内容' });
  });

  it('⭐ 工具的真实输出要显示出来：data.result.content 的文本，不是只留一行 meta', () => {
    const h = createHarness();
    h.emit('agent', {
      sessionKey: TASK.sessionKey,
      stream: 'tool',
      data: {
        phase: 'result',
        name: 'ls',
        toolCallId: 'call_ls_1',
        meta: '工作区',
        isError: false,
        commandBearing: false,
        result: { content: [{ type: 'text', text: 'a.md\nb.md' }] },
      },
    });

    const tc = lastToolCall(h);
    expect(tc.status).toBe('done');
    expect(tc.result).toContain('a.md');
    expect(tc.result).toContain('b.md');
  });

  it('真实输出缺失时才退回 meta（不能显示空白）', () => {
    const h = createHarness();
    h.emit('agent', {
      sessionKey: TASK.sessionKey,
      stream: 'tool',
      data: { phase: 'result', name: 'ls', toolCallId: 'call_ls_2', meta: '工作区', isError: false },
    });

    expect(lastToolCall(h).result).toBe('工作区');
  });

  it('失败帧是 phase:"result" + isError:true ⇒ error（网关根本没有 "error" 这个 phase）', () => {
    const h = createHarness();
    h.emit('agent', {
      sessionKey: TASK.sessionKey,
      stream: 'tool',
      data: {
        phase: 'result',
        name: 'memory_search',
        toolCallId: 'call_ms_1',
        meta: '游戏 爆款',
        isError: true,
        result: { content: [{ type: 'text', text: 'memory_search timed out after 15s' }] },
      },
    });

    const tc = lastToolCall(h);
    expect(tc.status).toBe('error');
    expect(tc.result).toContain('timed out');
  });
});

/**
 * `item` 流 —— 网关**拼好的**「做了什么操作」人话标题，我们从前整条丢掉
 *（归到 default 分支只记遥测 `renderer.agent.unknown_stream`）。
 *
 * 真实帧（2026-09-18T05:38:37.780Z）里 `title` 是「工具名 + 参数摘要」：
 *   "memory_search 游戏 爆款 创作 内容"
 * 这正是用户说的「显示调用了什么工具、做了什么操作」最直接的数据源。
 */
describe('item 流：网关拼好的人话标题与真实起止时间', () => {
  type EmittedToolCall = {
    id: string;
    name: string;
    status: string;
    title?: string;
    startedAt?: string;
    completedAt?: string;
  };

  function lastToolCall(h: ReturnType<typeof createHarness>): EmittedToolCall {
    const calls = h.messageStore.upsertToolCall.mock.calls;
    expect(calls.length, 'item 应该也走 upsertToolCall').toBeGreaterThan(0);
    return calls[calls.length - 1]![2] as EmittedToolCall;
  }

  it('⭐ kind:"tool" 的 item 带着人话标题，挂到同一个 toolCallId 上', () => {
    const h = createHarness();
    h.emit('agent', {
      sessionKey: TASK.sessionKey,
      stream: 'item',
      data: {
        itemId: 'tool:call_f1236bd519f54d6e816e79b1',
        phase: 'start',
        kind: 'tool',
        title: 'memory_search 游戏 爆款 创作 内容',
        status: 'running',
        name: 'memory_search',
        meta: '游戏 爆款 创作 内容',
        commandBearing: false,
        toolCallId: 'call_f1236bd519f54d6e816e79b1',
        startedAt: 1789709917722,
      },
    });

    const tc = lastToolCall(h);
    expect(tc.id).toBe('call_f1236bd519f54d6e816e79b1');
    expect(tc.title).toBe('memory_search 游戏 爆款 创作 内容');
    expect(tc.startedAt).toBe(new Date(1789709917722).toISOString());
  });

  it('item 的收尾帧（phase:"end" + status:"failed"）落成 error 并带上结束时间', () => {
    const h = createHarness();
    h.emit('agent', {
      sessionKey: TASK.sessionKey,
      stream: 'item',
      data: {
        itemId: 'tool:call_f1236bd519f54d6e816e79b1',
        phase: 'end',
        kind: 'tool',
        title: 'memory_search 游戏 爆款 创作 内容',
        status: 'failed',
        name: 'memory_search',
        toolCallId: 'call_f1236bd519f54d6e816e79b1',
        startedAt: 1789709917722,
        endedAt: 1789709932780,
        error: 'memory_search timed out after 15s',
      },
    });

    const tc = lastToolCall(h);
    expect(tc.status).toBe('error');
    expect(tc.completedAt).toBe(new Date(1789709932780).toISOString());
  });

  /**
   * ⭐ `status:"blocked"` —— **没跑成**的那一类，此前会显示成「已完成」。
   *
   * 实测（随包运行时 2026.9.3，`builtin-openclaw-*.mjs` 原文）：
   *
   * ```js
   * terminalErrorStatus = terminal.executionStarted ? "failed" : "blocked"
   * emitTrackedItemEvent(ctx, { …, phase: "end", kind: "tool",
   *     status: isToolError ? terminalErrorStatus : "completed", … })
   * ```
   *
   * ⇒ 工具**被拦下、根本没执行**时，item 发的是 `phase:"end"` + `status:"blocked"`。
   * 而我们的判定只认 `failed` / `error` ⇒ `failed=false`、`settled=(phase==='end')`
   * ⇒ **算成 `'done'`：一条没跑的命令被标成成功。**
   *
   * ⚠️ 为何"平时看不见"：`tool` 流的 result 帧通常先到（`isError:true` ⇒ `error`，权重 3），
   * 随后的 `done`（权重 2）会被 `mergeToolCallState` 的"不许降级"挡掉。
   * 但那是**排序在兜底**，不是我们认对了 —— 帧序一变、或那条 result 的 `isError` 被网关
   * 压成 false（`isToolError = observerIsError && !approvalUnavailable` 就是这种情形），
   * 界面就会说成功。
   */
  it('⭐ item 的 `status:"blocked"`（工具没执行）不许落成 done', () => {
    const h = createHarness();
    h.emit('agent', {
      sessionKey: TASK.sessionKey,
      stream: 'item',
      data: {
        itemId: 'tool:call_blocked',
        phase: 'end',
        kind: 'tool',
        title: 'exec rm -rf /tmp/x',
        status: 'blocked',
        name: 'exec',
        toolCallId: 'call_blocked',
        startedAt: 1789709917722,
        endedAt: 1789709932780,
      },
    });

    expect(lastToolCall(h).status, '没跑成 ⇒ 不许显示成已完成').toBe('error');
    expect(lastToolCall(h).completedAt, '它确实结束了，结束时间要给').toBe(new Date(1789709932780).toISOString());
  });

  it('成功那条路不受影响（`status:"completed"` + phase:"end" 仍是 done）', () => {
    const h = createHarness();
    h.emit('agent', {
      sessionKey: TASK.sessionKey,
      stream: 'item',
      data: {
        itemId: 'tool:call_ok',
        phase: 'end',
        kind: 'tool',
        title: 'ls 工作区',
        status: 'completed',
        name: 'ls',
        toolCallId: 'call_ok',
        startedAt: 1789709917722,
        endedAt: 1789709932780,
      },
    });

    expect(lastToolCall(h).status).toBe('done');
  });

  /**
   * ⭐ `kind:"preamble"` 的 `progressText` 是**模型自述的进度**（真帧形状见
   * `assistant-text-not-streaming` 记忆里的日志片段）：
   *
   * ```json
   * {"stream":"item","data":{"kind":"preamble","progressText":"…模型自述的进度…"}}
   * ```
   *
   * 它此前被整块丢掉 —— `AgentItemData` 里**声明了** `progressText` 字段却没人读，
   * 而 `handleAgentItemStream` 见到非 tool 就 `return`。
   * 这恰恰是"卡住好久突然跳出来"那段时间里**唯一在动的东西**（正文本就不流式）。
   */
  it('⭐ preamble 的 progressText 要写进本轮进度（不是丢掉，也不是当工具）', () => {
    const h = createHarness();
    h.emit('agent', {
      sessionKey: TASK.sessionKey,
      stream: 'item',
      data: { itemId: 'commentary-1', kind: 'preamble', phase: 'start', progressText: '正在梳理第三章' },
    });

    expect(h.messageStore.setSessionProgressText).toHaveBeenCalledWith(TASK.sessionKey, '正在梳理第三章');
    expect(h.messageStore.upsertToolCall, '它仍然**不是**工具卡片').not.toHaveBeenCalled();
  });

  it('preamble 没带 progressText（或空串）⇒ 不写，别把上一句盖成空的', () => {
    const h = createHarness();
    for (const data of [
      { itemId: 'p1', kind: 'preamble', phase: 'start' },
      { itemId: 'p2', kind: 'preamble', phase: 'start', progressText: '' },
      { itemId: 'p3', kind: 'preamble', phase: 'start', progressText: '   ' },
    ]) {
      h.emit('agent', { sessionKey: TASK.sessionKey, stream: 'item', data });
    }

    expect(h.messageStore.setSessionProgressText).not.toHaveBeenCalled();
  });

  it('认不出的 kind 不写 store（别把 preamble 之类的当工具）', () => {
    const h = createHarness();
    h.emit('agent', {
      sessionKey: TASK.sessionKey,
      stream: 'item',
      data: { itemId: 'commentary-1', kind: 'preamble', phase: 'end', progressText: '正在梳理…' },
    });

    expect(h.messageStore.upsertToolCall).not.toHaveBeenCalled();
  });

  it('修好之后不再上报为未知事件', () => {
    const h = createHarness();
    for (let i = 0; i < 12; i++) {
      h.emit('agent', {
        sessionKey: TASK.sessionKey,
        stream: 'item',
        data: { itemId: `tool:call_${i}`, kind: 'tool', phase: 'start', name: 'ls', toolCallId: `call_${i}` },
      });
    }
    expect(h.deps.reportDebugEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'renderer.agent.unknown_stream.threshold' }),
    );
  });
});

/**
 * `approval` 流 —— 命令被审批拦下时，网关**会把"没跑成"报成"没出错"**。
 *
 * 实测（随包运行时 2026.9.3，`builtin-openclaw-*.mjs` 原文）：
 *
 * ```js
 * observerIsError     = isError || isToolResultError(result)
 * approvalUnavailable = isExecToolName(toolName)
 *                    && readExecToolDetails(sanitizedResult)?.status === "approval-unavailable"
 * isToolError         = observerIsError && !approvalUnavailable   // ← 被强制压成 false
 * ```
 *
 * ⇒ **审批不可用而被拦下的命令，`tool` 流发的是 `isError:false` 的 result**。
 * 只看 tool 流，卡片会显示「已完成」—— 而那条命令**根本没执行**。
 * 对一个会替用户跑 shell 的产品来说，这是**界面在撒谎**，比报错更糟。
 *
 * 真相只在另外两帧里，而这两帧我们**都没接**：
 * - `stream:"approval"`（本文件要接的）：
 *   - `{ phase:"requested", kind:"exec", status:"pending"|"unavailable", title, toolCallId,
 *      approvalId?, command, host, reason?, message }`
 *   - `{ phase:"resolved", kind:"exec", status:"denied"|"failed", title, toolCallId, message }`
 * - `item` 流的 `kind:"command"` + `status:"blocked"`（另一个已知缺口，仍未接）
 *
 * ⚠️ **`status:"pending"` 刻意不处理**：那时命令**还有可能跑**，报成失败是另一种撒谎；
 * 而"退回进行中"当前**做不到** —— `mergeToolCallState` 的状态权重是 `error(3) > done(2) > running(1)`，
 * 它**不许降级**（那是为了防止迟到的 update 把已完成的调用转回 running）。
 * 所以这里只做**唯一能做的诚实修正**：确知没跑成的，不许留在「已完成」。
 */
/**
 * ⭐ A2：「**等待批准**」要单独说一句（2026-09-19 拍板）。
 *
 * 现行：审批等待期只显示"进行中"，与普通运行**看不出区别** ——
 * 用户不知道**为什么没进展**，也不知道**该谁动**。
 *
 * ⚠️ 这一刀**只动显示**：谁批、怎么批、批完干嘛，**一个字节没改**。
 * `awaitingApproval` 也不是终态 —— 它与 `running` **同级**（都算"没结束"），
 * 好让随后的真结果/拒绝照样压得过去。
 */
describe('A2：审批等待期要单独说一句「等待批准」', () => {
  const emitTool = (h: ReturnType<typeof createHarness>, data: Record<string, unknown>) =>
    h.emit('agent', {
      sessionKey: TASK.sessionKey,
      stream: 'tool',
      data: { name: 'exec', toolCallId: 'call_wait', isError: false, ...data },
    });

  const emitApproval = (h: ReturnType<typeof createHarness>, data: Record<string, unknown>) =>
    h.emit('agent', { sessionKey: TASK.sessionKey, stream: 'approval', data });

  /** 真实形状：exec 挂起等审批 ⇒ tool 流先报 `isError:false`，approval 帧随后说 `pending`。 */
  function enterApprovalWait(h: ReturnType<typeof createHarness>, toolCallId = 'call_wait'): void {
    emitTool(h, {
      phase: 'result',
      toolCallId,
      result: {
        content: [{ type: 'text', text: 'Command requires approval.' }],
        details: { status: 'approval-pending', approvalId: 'a1', approvalSlug: '12345678', host: 'gateway' },
      },
    });
    emitApproval(h, {
      phase: 'requested',
      kind: 'exec',
      status: 'pending',
      title: 'Command approval requested',
      itemId: `command:${toolCallId}`,
      toolCallId,
      command: 'npm view diver name version description',
      host: 'gateway',
    });
  }

  const lastStatus = (h: ReturnType<typeof createHarness>): string => {
    const calls = h.messageStore.upsertToolCall.mock.calls;
    expect(calls.length, '应该有工具调用被写进 store').toBeGreaterThan(0);
    return (calls[calls.length - 1]![2] as { status: string }).status;
  };

  it('⭐⭐ 进入审批等待 ⇒ 状态是 `awaitingApproval`，**不是** `running`', () => {
    const h = createHarness();

    enterApprovalWait(h);

    expect(lastStatus(h), '复用"进行中"就等于什么都没说').toBe('awaitingApproval');
  });

  it('⭐⭐ 它与 `running` **同级**：审批还没结论时，**不算** done/error', () => {
    const h = createHarness();

    enterApprovalWait(h);

    const seen = h.messageStore.upsertToolCall.mock.calls.map((c) => (c[2] as { status: string }).status);
    expect(seen).not.toContain('done');
    expect(seen).not.toContain('error');
  });

  it('⭐ 审批**被拒** ⇒ 正常收场（落 `error`，不许停在"等待批准"）', () => {
    const h = createHarness();
    enterApprovalWait(h);

    emitApproval(h, {
      phase: 'resolved',
      kind: 'exec',
      status: 'denied',
      title: 'Command approval resolved',
      toolCallId: 'call_wait',
      command: 'npm view x',
      host: 'gateway',
      reason: 'user-denied',
      message: 'The command was not run.',
    });

    expect(lastStatus(h)).toBe('error');
  });

  it('⭐ 审批**通过后真结果到达** ⇒ 正常收场（落 `done`）', () => {
    const h = createHarness();
    enterApprovalWait(h);

    emitTool(h, {
      phase: 'result',
      toolCallId: 'call_wait',
      result: { content: [{ type: 'text', text: 'diver 1.2.3' }] },
    });

    expect(lastStatus(h), '同级 ⇒ 后来的 done 压得过去').toBe('done');
  });

  it('⭐ 对照：普通工具运行**永远不会**出现这个状态', () => {
    const h = createHarness();

    emitTool(h, { phase: 'start' });
    emitTool(h, { phase: 'result', result: { content: [{ type: 'text', text: 'ok' }] } });

    const seen = h.messageStore.upsertToolCall.mock.calls.map((c) => (c[2] as { status: string }).status);
    expect(seen, `只有审批那条路能产生它：${seen.join(' → ')}`).not.toContain('awaitingApproval');
  });
});

describe('approval 流：被拦下的命令不许显示成"已完成"', () => {
  type EmittedToolCall = { id: string; name: string; status: string; result?: string; completedAt?: string };

  function lastToolCall(h: ReturnType<typeof createHarness>): EmittedToolCall {
    const calls = h.messageStore.upsertToolCall.mock.calls;
    expect(calls.length, '应该有工具调用被写进 store').toBeGreaterThan(0);
    return calls[calls.length - 1]![2] as EmittedToolCall;
  }

  /** 真实的 exec 完成帧：审批不可用 ⇒ 网关把 `isError` 压成 `false`。 */
  function emitBlockedExecResult(h: ReturnType<typeof createHarness>, toolCallId: string): void {
    h.emit('agent', {
      sessionKey: TASK.sessionKey,
      stream: 'tool',
      data: {
        phase: 'result',
        name: 'exec',
        toolCallId,
        meta: 'ls 工作区',
        isError: false,
        result: {
          content: [{ type: 'text', text: 'Command requires approval.' }],
          details: { status: 'approval-unavailable', reason: 'no-approval-channel' },
        },
      },
    });
  }

  function emitApproval(h: ReturnType<typeof createHarness>, data: Record<string, unknown>): void {
    h.emit('agent', { sessionKey: TASK.sessionKey, stream: 'approval', data });
  }

  it('⭐ tool 流说"没出错"、随后 approval 说"不可用" ⇒ 卡片不许停在"已完成"', () => {
    const h = createHarness();
    emitBlockedExecResult(h, 'call_appr');
    // ⚠️ 这条**前置** 2026-09-19 改过：从前断言的是 `'done'`。
    //    网关的**行为**没变（它照旧在 tool 流上报 `isError: false`），
    //    变的是**我们**：不再把这个 `isError:false` 落成"已完成"（拍板"不让它先闪"）。
    //    ⇒ 断言的方向没放松，是**更早一步**就拦住了。
    // 【V2 白名单】held（approval-unavailable）直接落 awaitingApproval；旧口径先落 running。
    expect(lastToolCall(h).status, '前置：tool 流那一帧上命令还没结论，不许说"完成"').toBe('awaitingApproval');

    emitApproval(h, {
      phase: 'requested',
      kind: 'exec',
      status: 'unavailable',
      title: 'Command approval unavailable',
      itemId: 'command:call_appr',
      toolCallId: 'call_appr',
      command: 'rm -rf /tmp/x',
      host: 'local',
      reason: 'no-approval-channel',
      message: 'Approval is unavailable; the command was not run.',
    });

    const tc = lastToolCall(h);
    expect(tc.status, '命令根本没跑 ⇒ 不许显示成已完成').toBe('error');
    expect(tc.result, '要把网关给的原因带上，否则用户不知道为什么').toContain('not run');

    // ⭐⭐ **"不闪"就是这条**：把两帧合起来看，`done` **一次都不许出现**。
    //    光看最终态是查不出"闪一下"的 —— 那正是这条断言存在的理由。
    const everSeen = h.messageStore.upsertToolCall.mock.calls.map(
      (c) => (c[2] as { status: string; completedAt?: string }).status,
    );
    expect(everSeen, `中间出现过「已完成」：${everSeen.join(' → ')}`).not.toContain('done');
  });

  it('审批被拒（phase:"resolved" + status:"denied"）同样不许是"已完成"', () => {
    const h = createHarness();
    emitBlockedExecResult(h, 'call_denied');

    emitApproval(h, {
      phase: 'resolved',
      kind: 'exec',
      status: 'denied',
      title: 'Command approval resolved',
      itemId: 'command:call_denied',
      toolCallId: 'call_denied',
      message: 'The command was denied and not executed.',
    });

    expect(lastToolCall(h).status).toBe('error');
    expect(lastToolCall(h).result).toContain('denied');
  });

  it('审批**还在等**（status:"pending"）⇒ 标成「等待批准」，**但不报成失败/完成**', () => {
    // ⚠️ 这条**从前断言的是"不动它"**（`callsBefore === callsAfter`），理由是
    //    「报成失败是另一种撒谎，而'退回进行中'又做不到（不许降级）」。
    //    A2（2026-09-19 拍板）改了后半句的前提：**有第三个状态可用了**
    //    （`awaitingApproval`，与 `running` 同级 ⇒ 既不撒谎也不再"降不了级"）。
    // ⇒ 断言方向**没放松**：从"一个字都别写"变成"**必须**写，且只能写成等待批准"。
    const h = createHarness();
    emitBlockedExecResult(h, 'call_pending');

    emitApproval(h, {
      phase: 'requested',
      kind: 'exec',
      status: 'pending',
      title: 'Command approval requested',
      itemId: 'command:call_pending',
      toolCallId: 'call_pending',
      approvalId: 'ap-1',
      command: 'ls',
      host: 'local',
    });

    const after = lastToolCall(h);
    expect(after.status, '命令还有可能跑 ⇒ 不许说"没跑成"').not.toBe('error');
    expect(after.status, '更不许说"完成"').not.toBe('done');
    expect(after.status, '要单独说一句"在等人"').toBe('awaitingApproval');
    expect(after.completedAt, '它没结束').toBeUndefined();
  });

  it('approval 帧要留遥测 —— 这条链出事时得查得到', () => {
    const h = createHarness();
    emitBlockedExecResult(h, 'call_tel');
    emitApproval(h, {
      phase: 'requested',
      kind: 'exec',
      status: 'unavailable',
      title: 'Command approval unavailable',
      toolCallId: 'call_tel',
      command: 'ls',
      host: 'local',
      reason: 'no-approval-channel',
    });

    expect(h.deps.reportDebugEvent).toHaveBeenCalledWith(expect.objectContaining({ event: 'renderer.agent.approval' }));
  });

  it('⭐ approval 帧不带工具名 ⇒ 必须沿用已有的真实工具名（别把卡片标题变成 exec）', () => {
    const h = createHarness();
    // harness 的 store 是 mock，这里按**真实 store 的形状**放一条"已经在飞的"工具调用，
    // 好让 `existingToolName` 有东西可找（真机上这由前面那帧 tool 流写进去）
    (h.messageStore as unknown as { activeTurnBySession: Record<string, unknown> }).activeTurnBySession = {
      [TASK.sessionKey]: { toolCalls: [{ id: 'call_named', name: 'shell', status: 'running' }] },
    };

    emitApproval(h, {
      phase: 'requested',
      kind: 'exec',
      status: 'unavailable',
      title: 'Command approval unavailable',
      toolCallId: 'call_named',
      command: 'ls',
      host: 'local',
      message: 'Command was not run.',
    });

    expect(lastToolCall(h).name, '`kind:"exec"` 只是兜底，不许顶掉真实的 `shell`').toBe('shell');
  });

  it('缺 toolCallId 的 approval 帧直接忽略（不能凭空造一张卡）', () => {
    const h = createHarness();
    emitApproval(h, { phase: 'requested', kind: 'exec', status: 'unavailable', title: 'x' });

    expect(h.messageStore.upsertToolCall).not.toHaveBeenCalled();
  });
});

/**
 * `lifecycle` 的**三个** fallback 相位 —— 实测随包运行时 2026.9.3 会发：
 *
 * | phase              | 含义                                   | 我们此前 |
 * | ------------------ | -------------------------------------- | -------- |
 * | `fallback`         | 切到了别的模型（`reasonSummary` 等）   | ✅ 有处理 |
 * | `fallback_cleared` | **切回**用户选的那个模型               | ❌ 静默吞 |
 * | `fallback_step`    | 逐个候选试的过程（诊断用）             | ❌ 静默吞 |
 *
 * ⚠️ 为什么 `fallback_cleared` 必须说一句：我们会在 `fallback` 时插一条
 * 「已切换至模型: X」进时间线。切回来了却不说，**时间线上最后一句就停在 X** ——
 * 用户以为还在用 X 回答。而每条消息的模型徽章是对的（那是网关逐条给的），
 * 偏偏用户刚被告知的那句话是旧的。
 *
 * ✅ **复用现成的 key**（`agent.modelFallback`）：切回来**本来就**是一次模型切换
 *（切回用户挑的那个），"已切换至模型: Y" 字面为真 ⇒ **不需要新文案、不动 9 语言**。
 *
 * ⚠️ `fallback_step` 只留遥测：它是逐个候选尝试的过程，每一步都插一句会把时间线刷爆。
 */
describe('lifecycle 的 fallback 三相', () => {
  function emitLifecycle(h: ReturnType<typeof createHarness>, data: Record<string, unknown>): void {
    h.emit('agent', { sessionKey: TASK.sessionKey, stream: 'lifecycle', data });
  }

  it('⭐ `fallback_cleared`（切回用户选的模型）也要说 —— 否则最后一句停在"已切换到 X"', () => {
    const h = createHarness();

    emitLifecycle(h, {
      phase: 'fallback_cleared',
      selectedProvider: 'p1',
      selectedModel: 'qwen-plus',
      activeProvider: 'p1',
      activeModel: 'qwen-plus',
      previousActiveModel: 'glm-4.7',
    });

    expect(h.systemMessages, '切回来也是一次模型切换，必须让用户知道').toHaveLength(1);
    expect(h.systemMessages[0]!.content).toContain('modelFallback');
  });

  it('⭐ 模型**没变**时不许说（用户要求：只在真正切回时显示，避免噪音）', () => {
    const h = createHarness();

    // `fallback_cleared` 说的是"降级状态结束了"，但**不一定**意味着模型换了：
    // 清掉标记时用的还是同一个模型时，插一句「已切换至模型: 同一个」纯属噪音。
    emitLifecycle(h, {
      phase: 'fallback_cleared',
      selectedProvider: 'p1',
      selectedModel: 'qwen-plus',
      activeProvider: 'p1',
      activeModel: 'qwen-plus',
      previousActiveModel: 'qwen-plus',
    });

    expect(h.systemMessages, '前后是同一个模型 ⇒ 别插话').toHaveLength(0);
    // 遥测照旧记录（这条状态转换必须看得见）
    expect(h.deps.reportDebugEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'renderer.agent.lifecycle.fallback_cleared' }),
    );
  });

  it('证不了"确实变了"时也不说（`previousActiveModel` 缺失）', () => {
    const h = createHarness();

    // 没有"之前是哪个模型"就没法判断变没变。用户的要求是**避免噪音** ⇒ 宁可不吵。
    // （`activeModel` 本身还是照往常一样进遥测。）
    emitLifecycle(h, {
      phase: 'fallback_cleared',
      selectedProvider: 'p1',
      selectedModel: 'qwen-plus',
      activeProvider: 'p1',
      activeModel: 'qwen-plus',
    });

    expect(h.systemMessages, '无法证明变了 ⇒ 按"不吵"处理').toHaveLength(0);
  });

  it('`fallback_step` 只留遥测，不往时间线插话（逐个候选的过程太吵）', () => {
    const h = createHarness();

    emitLifecycle(h, { phase: 'fallback_step', attempt: 1, provider: 'p2', model: 'glm-4.7' });

    expect(h.systemMessages, '诊断步骤不该出现在时间线上').toHaveLength(0);
    expect(h.deps.reportDebugEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'renderer.agent.lifecycle.fallback_step' }),
    );
  });

  it('⭐ 将来新增的未知相位至少要留一条遥测（此前是**连一条日志都没有**）', () => {
    const h = createHarness();

    emitLifecycle(h, { phase: 'something_new_in_a_later_version' });

    expect(
      h.deps.reportDebugEvent,
      '这个 switch 原先**没有 default** ⇒ 未知相位完全静默。将来网关加一个相位，我们连查都查不到',
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'renderer.agent.lifecycle.unknown',
        // ⚠️ `debugEvent(event, data)` 把负载放在 **`data` 里**，不是顶层
        data: expect.objectContaining({ phase: 'something_new_in_a_later_version' }),
      }),
    );
    expect(h.systemMessages, '未知相位不许猜着渲染').toHaveLength(0);
  });
});

/**
 * chat 错误的 `errorKind` → 文案：**端到端接线**。
 *
 * ⚠️ 光有 `error-classify` 的单测证明不了"它被用上了" —— 那正是这类加固最容易掉的地方
 * （能力写好了、忘了接；或者接了却从 payload 里没传过来）。这条补的就是那个缝。
 * 真实文案由 desktop 的 `gateway-copy-coverage.test.ts` 保证（每个语言都得有）。
 */
describe('chat 错误的 errorKind 一路传到文案', () => {
  it('⭐ 网关给的 errorKind 要真的决定用户看到哪句话', () => {
    const h = createHarness();
    // 把类别 key 换成可辨认的标记（真实文案在 locale 里，core 不读 desktop 的 locale）
    h.deps.translate = (key: string, opts?: Record<string, unknown>) =>
      key.startsWith('errors.kind.') ? `«${key}»` : ((opts?.defaultValue as string) ?? key);

    h.emit('chat', {
      sessionKey: TASK.sessionKey,
      state: 'error',
      errorMessage: 'RateLimitExceededError: upstream said no',
      errorKind: 'rate_limit',
    });

    expect(h.systemMessages, '错误要显示出来').toHaveLength(1);
    expect(h.systemMessages[0]!.content, 'errorKind 必须真的被用上').toContain('errors.kind.rate_limit');
    expect(h.systemMessages[0]!.content, '不该把厂商英文原文摆给用户').not.toContain('upstream said no');
  });

  it('没有 errorKind 时照旧透出网关原文（不许瞎猜）', () => {
    const h = createHarness();
    h.deps.translate = (key: string, opts?: Record<string, unknown>) =>
      key.startsWith('errors.kind.') ? `«${key}»` : ((opts?.defaultValue as string) ?? key);

    h.emit('chat', {
      sessionKey: TASK.sessionKey,
      state: 'error',
      errorMessage: 'SomeBrandNewProviderError: whatever',
    });

    expect(h.systemMessages[0]!.content).toContain('SomeBrandNewProviderError');
    expect(h.systemMessages[0]!.content).not.toContain('errors.kind.');
  });
});

/**
 * 压缩：**两条来源统一出口**（B8）。
 *
 * ## 背景
 *
 * 压缩有两条来源，而它们**不共用网关事件**（读随包运行时 2026.9.3 确认）：
 * - **自动**（上下文满了）：agent `stream:"compaction"`；
 * - **手动**（斜杠命令 / 右键菜单）：**不发 agent 流**，发 `sessions.changed {reason:"compact", compacted}`。
 *
 * ⇒ 从前客户端只能凭 `sessions.compact` 那条 RPC 的 `ok` 就宣布"会话已压缩"，
 * 而 `ok` 只代表**请求被接受**。现在两条路都只认"**真的压了**"，且都走同一个出口。
 */
describe('压缩：两条来源统一出口', () => {
  function emitCompaction(h: ReturnType<typeof createHarness>, data: Record<string, unknown>): void {
    h.emit('agent', { sessionKey: TASK.sessionKey, stream: 'compaction', data });
  }
  function emitCompacted(h: ReturnType<typeof createHarness>, compacted: boolean): void {
    h.emit('sessions.changed', { sessionKey: TASK.sessionKey, reason: 'compact', compacted });
  }

  it('⭐ 自动压缩跑完 ⇒ 一条「会话已压缩」（带 sessionKey）', () => {
    const h = createHarness();

    emitCompaction(h, { phase: 'start' });
    emitCompaction(h, { phase: 'end', completed: true, willRetry: false, outcome: 'completed' });

    expect(h.systemMessages, '压完了就要说一句').toHaveLength(1);
    expect(h.systemMessages[0]!.content).toBe('session.contextCompacted');
    expect(h.systemMessages[0]!.sessionKey, 'system 消息要带 sessionKey（本文件既有纪律）').toBe(TASK.sessionKey);
  });

  it('⭐ 压缩还要重试（willRetry）⇒ 不说 —— 否则"压缩→重试→再压缩"会报两条', () => {
    const h = createHarness();

    emitCompaction(h, { phase: 'start' });
    emitCompaction(h, { phase: 'end', completed: true, willRetry: true });

    expect(h.systemMessages, '还要重试就不算真的压完').toHaveLength(0);
  });

  it('没压成（completed=false）⇒ 不说（别把失败的压缩说成成功）', () => {
    const h = createHarness();

    emitCompaction(h, { phase: 'start' });
    emitCompaction(h, { phase: 'end', completed: false });

    expect(h.systemMessages).toHaveLength(0);
  });

  it('只有 start ⇒ 不说（那句话留给活动条，不是时间线）', () => {
    const h = createHarness();

    emitCompaction(h, { phase: 'start' });

    expect(h.systemMessages).toHaveLength(0);
  });

  it('⭐ 手动压缩完成（网关 sessions.changed）⇒ 一条 —— 而它**必须**能穿过"只看子代理"那道过滤', () => {
    const h = createHarness();

    // ⚠️ TASK.sessionKey 是**普通任务会话**（不是子代理）：把 compact 分支写到过滤之后的话，
    //    这条永远收不到 —— 这个用例就是钉那个顺序的。
    emitCompacted(h, true);

    expect(h.systemMessages, '普通会话的压缩也要说').toHaveLength(1);
    expect(h.systemMessages[0]!.content).toBe('session.contextCompacted');
    expect(h.systemMessages[0]!.sessionKey).toBe(TASK.sessionKey);
  });

  it('⭐ 网关说"没真压成"（compacted=false）⇒ 不说', () => {
    const h = createHarness();

    // 网关那处守卫只写了 `if (result.ok)`（比"真的压了"宽）⇒ 这个字段必须真的被判。
    emitCompacted(h, false);

    expect(h.systemMessages).toHaveLength(0);
  });

  it('⭐ 两条来源都说同一件事 ⇒ 仍然只有一条', () => {
    const h = createHarness();

    emitCompaction(h, { phase: 'start' }); // 同一轮：开始时刻记在这儿
    emitCompacted(h, true); // 手动那条先到
    emitCompaction(h, { phase: 'end', completed: true, willRetry: false }); // 自动那条（同一轮）后到

    expect(h.systemMessages, '同一轮压缩只许出现一条').toHaveLength(1);
  });

  it('第二轮压缩要能再说一次（去重按"轮"而不是"会话"）', () => {
    const h = createHarness();

    emitCompaction(h, { phase: 'start' });
    emitCompaction(h, { phase: 'end', completed: true, willRetry: false });
    // 隔一轮再来（start 会刷新本轮开始时刻）
    emitCompaction(h, { phase: 'start' });
    emitCompaction(h, { phase: 'end', completed: true, willRetry: false });

    expect(h.systemMessages, '长会话会压缩多次，不能只报第一次').toHaveLength(2);
  });

  it('⭐ Phase 2：start 时活动条显示"正在压缩"，end（含失败）收掉', () => {
    const h = createHarness();

    emitCompaction(h, { phase: 'start' });
    expect(h.messageStore.setSessionCompacting, '压缩期间必须让用户看得见').toHaveBeenCalledWith(TASK.sessionKey, true);

    emitCompaction(h, { phase: 'end', completed: true, willRetry: false });
    expect(h.messageStore.setSessionCompacting).toHaveBeenLastCalledWith(TASK.sessionKey, false);
  });

  it('Phase 2：压缩**失败/取消**（completed=false）也要把提示收掉', () => {
    const h = createHarness();

    emitCompaction(h, { phase: 'start' });
    emitCompaction(h, { phase: 'end', completed: false });

    expect(h.messageStore.setSessionCompacting).toHaveBeenLastCalledWith(TASK.sessionKey, false);
  });

  it('遥测照旧记（别为了新行为把老的丢了）', () => {
    const h = createHarness();

    emitCompaction(h, { phase: 'end', completed: true, willRetry: false });

    expect(h.deps.reportDebugEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'renderer.agent.compaction' }),
    );
  });
});

/**
 * ⚠️ 补一条**变异验证抓出来的**缺口：`reason:"compact"` 但**不带** `compacted` 字段。
 *
 * 网关确实会在两处带这个字段（一处恒 `true`、一处是 `result.compacted`），
 * 所以"缺字段"在今天的实现里大概不会出现 —— 但**判据必须写严**：
 * 只要不是**严格** `true` 就不报，否则哪天网关那处守卫（`if (result.ok)`，比"真的压了"宽）
 * 把 `compacted` 漏了，我们就会跟着把"没压成"报成压了。
 */
describe('压缩：判据要严（变异验证抓出来的缺口）', () => {
  it('⭐ `reason:"compact"` 但不带 `compacted` ⇒ **不报**（不能把"没提"当成"压了"）', () => {
    const h = createHarness();

    h.emit('sessions.changed', { sessionKey: TASK.sessionKey, reason: 'compact' });

    expect(h.systemMessages, '缺字段 ⇒ 证不出"压了" ⇒ 不报').toHaveLength(0);
  });
});

/**
 * 本机运行时（18789 那个网关）起不来时，主进程会把**公开原因**发过来。
 *
 * 这条通道必须与网关状态**分开**：它说的是"我们自己的网关压根没起来"，
 * 而那条路上往往连 WS 都没建起来 —— 从连接层一个字都读不到。
 * 落进 store 之后，推导层（`deriveStartupReadiness`）才说得出是哪一类失败。
 *
 * ⚠️ 它**只**写那一个字段：不是网关状态、不是重连信息，别污染那两条链。
 */
describe('本机运行时起不来：只把公开原因落进 store', () => {
  it('失败 ⇒ 写 store 的是闭集里的那个值', () => {
    const h = createHarness();
    h.dispatcher.startGatewayStatus();

    h.emitRuntimeStatus({ ok: false, reason: 'port-occupied' });

    expect(h.deps.setRuntimeBootstrapFailure).toHaveBeenCalledWith('port-occupied');
  });

  it('起来了 ⇒ 清掉（不能留着上一轮的失败）', () => {
    const h = createHarness();
    h.dispatcher.startGatewayStatus();

    h.emitRuntimeStatus({ ok: true });

    expect(h.deps.setRuntimeBootstrapFailure).toHaveBeenCalledWith(null);
  });

  it('不碰网关状态与重连信息（那是另一个维度的事）', () => {
    const h = createHarness();
    h.dispatcher.startGatewayStatus();

    h.emitRuntimeStatus({ ok: false, reason: 'ready-timeout' });

    expect(h.deps.setGatewayStatusByGateway).not.toHaveBeenCalled();
    expect(h.deps.setGatewayReconnectInfo).not.toHaveBeenCalled();
    expect(h.deps.setGatewayVersion).not.toHaveBeenCalled();
  });

  it('⭐ 挂上来时补读一次：这条结论往往在窗口就绪之前就产生了，那次推送没人收', async () => {
    const h = createHarness();
    h.deps.gateway.runtimeStatus = vi.fn(async () => ({ ok: false, reason: 'port-occupied' }) as const);

    h.dispatcher.startGatewayStatus();

    await vi.waitFor(() => expect(h.deps.setRuntimeBootstrapFailure).toHaveBeenCalledWith('port-occupied'));
  });

  it('补读拿到"还没有结论"⇒ 一个字都不写（没结论 ≠ 出错了）', async () => {
    const h = createHarness();
    h.deps.gateway.runtimeStatus = vi.fn(async () => null);

    h.dispatcher.startGatewayStatus();
    await Promise.resolve();

    expect(h.deps.setRuntimeBootstrapFailure).not.toHaveBeenCalled();
  });

  it('补读这条路自己坏了（IPC 抛）⇒ 只当没有结论 + 留一条遥测，不写 store', async () => {
    const h = createHarness();
    h.deps.gateway.runtimeStatus = vi.fn(async () => {
      throw new Error('ipc exploded');
    });

    expect(() => h.dispatcher.startGatewayStatus()).not.toThrow();
    // ⭐ 判据落在**遥测**上，不落在"没抛"上：抛是异步发生的，`not.toThrow` 证明不了
    //    catch 在不在（变异电池实测：删掉 catch 那条断言照样绿）。
    await vi.waitFor(() =>
      expect(h.deps.reportDebugEvent).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'renderer.runtime_status.read_failed' }),
      ),
    );
    expect(h.deps.setRuntimeBootstrapFailure).not.toHaveBeenCalled();
    // 遥测里不带原始 message（IPC 层来的东西内容不受控）
    expect(JSON.stringify(vi.mocked(h.deps.reportDebugEvent).mock.calls)).not.toContain('ipc exploded');
  });

  it('⭐ 网关协商的单帧上限（hello-ok.policy.maxPayload）原值落 store —— 发送字节预算按它折算', () => {
    const h = createHarness();
    h.dispatcher.startGatewayStatus();

    h.emitStatus({ gatewayId: 'gw-1', connected: true, maxPayloadBytes: 8 * 1024 * 1024 });

    expect(h.deps.setGatewayMaxPayloadByGateway).toHaveBeenCalledWith('gw-1', 8 * 1024 * 1024);
  });

  it('⭐ 事件不带协商值（断线 / 旧网关）⇒ 以 undefined 清条目，不留上一代的数字', () => {
    const h = createHarness();
    h.dispatcher.startGatewayStatus();

    h.emitStatus({ gatewayId: 'gw-1', connected: false });

    expect(h.deps.setGatewayMaxPayloadByGateway).toHaveBeenCalledWith('gw-1', undefined);
  });

  it('⭐ 没有这条通道的形态（pwa / 出厂）也不炸：它比渲染层可选', () => {
    const h = createHarness();
    h.deps.gateway.onRuntimeStatus = undefined;

    expect(() => h.dispatcher.startGatewayStatus()).not.toThrow();
    // 网关状态那条链照常：不能因为少一条通道就整组不订阅
    h.emitStatus({ gatewayId: 'gw-1', connected: true });
    expect(h.deps.setGatewayStatusByGateway).toHaveBeenCalledWith('gw-1', 'connected');
  });
});

/**
 * 网关**明确拒绝**时（回了 `res.error` ⇒ 客户端以 1008 关闭），界面上要说得出
 * 是哪一类拒绝 —— 光有 `gaveUp` 只能说"连不上"。
 *
 * ⚠️ 这条原因跟的是**重连信息**（它本来就描述"这个网关连得怎么样"），
 *    而不是 `runtimeBootstrapFailure`（那是"我们自己的网关压根没起来"）。
 */
describe('网关明确拒绝：把"哪一类"一起存下来', () => {
  it('状态里给了原因 ⇒ 存进重连信息（不是只存 attempt/max）', () => {
    const h = createHarness();
    h.dispatcher.startGatewayStatus();

    h.emitStatus({
      gatewayId: 'gw-1',
      connected: false,
      error: 'auth denied',
      reconnectAttempt: 10,
      maxAttempts: 10,
      gaveUp: true,
      reason: 'auth-rejected',
    });

    expect(h.deps.setGatewayReconnectInfo).toHaveBeenCalledWith('gw-1', {
      attempt: 10,
      max: 10,
      gaveUp: true,
      reason: 'auth-rejected',
    });
  });

  it('对照：没给原因时存的那份也没有原因（不替它编一个）', () => {
    const h = createHarness();
    h.dispatcher.startGatewayStatus();

    h.emitStatus({ gatewayId: 'gw-1', connected: false, reconnectAttempt: 3, maxAttempts: 10, gaveUp: false });

    expect(h.deps.setGatewayReconnectInfo).toHaveBeenCalledWith('gw-1', {
      attempt: 3,
      max: 10,
      gaveUp: false,
    });
  });

  it('连上了 ⇒ 照旧整条清掉（原因跟着重连信息一起消失）', () => {
    const h = createHarness();
    h.dispatcher.startGatewayStatus();

    h.emitStatus({
      gatewayId: 'gw-1',
      connected: false,
      reconnectAttempt: 10,
      maxAttempts: 10,
      gaveUp: true,
      reason: 'auth-rejected',
    });
    h.emitStatus({ gatewayId: 'gw-1', connected: true });

    expect(h.deps.setGatewayReconnectInfo).toHaveBeenLastCalledWith('gw-1', null);
  });
});

describe('fetchEffectiveTools', () => {
  it('stores only the session-scoped effective inventory', async () => {
    const h = createHarness();
    const inventory = {
      agentId: 'main',
      profile: 'coding',
      groups: [{ id: 'core', label: 'Core', source: 'core', tools: [] }],
    };
    const getEffectiveTools = vi.fn(async () => ({ ok: true as const, result: inventory }));
    const setEffectiveToolsState = vi.fn();
    Object.assign(h.deps.gateway, { getEffectiveTools });
    Object.assign(h.deps, { setEffectiveToolsState });
    const dispatcher = h.dispatcher as unknown as {
      fetchEffectiveTools: (gatewayId: string, sessionKey: string) => Promise<void>;
    };

    expect(typeof dispatcher.fetchEffectiveTools).toBe('function');
    await dispatcher.fetchEffectiveTools('gw-1', TASK.sessionKey);

    expect(getEffectiveTools).toHaveBeenCalledWith('gw-1', TASK.sessionKey);
    expect(setEffectiveToolsState).toHaveBeenNthCalledWith(1, 'gw-1', TASK.sessionKey, { status: 'loading' });
    expect(setEffectiveToolsState).toHaveBeenNthCalledWith(2, 'gw-1', TASK.sessionKey, {
      status: 'ready',
      inventory,
    });
  });

  it('replaces any prior inventory with an explicit error and never falls back to tools.catalog', async () => {
    const h = createHarness();
    const getEffectiveTools = vi.fn(async () => ({ ok: false as const, error: 'unknown session key' }));
    const getToolsCatalog = vi.fn(async () => ({ ok: true as const, result: { groups: [{ id: 'core' }] } }));
    const setEffectiveToolsState = vi.fn();
    Object.assign(h.deps.gateway, { getEffectiveTools, getToolsCatalog });
    Object.assign(h.deps, { setEffectiveToolsState });
    const dispatcher = h.dispatcher as unknown as {
      fetchEffectiveTools: (gatewayId: string, sessionKey: string) => Promise<void>;
    };

    expect(typeof dispatcher.fetchEffectiveTools).toBe('function');
    await dispatcher.fetchEffectiveTools('gw-1', TASK.sessionKey);

    // 2026-10-06（10-01 用户实测 #1 同族）：unknown session key 的上屏文案已产品化——
    // 状态仍 fail-closed 的 error、仍不回退 tools.catalog；只换用户可见文案（不再裸露英文）。
    expect(setEffectiveToolsState).toHaveBeenLastCalledWith('gw-1', TASK.sessionKey, {
      status: 'error',
      error: '会话尚未就绪，发送第一条消息后会自动恢复',
    });
    expect(getToolsCatalog).not.toHaveBeenCalled();
  });

  it('其他 tools.effective 失败照旧透传原文（产品化只针对会话未就绪）', async () => {
    const h = createHarness();
    const getEffectiveTools = vi.fn(async () => ({ ok: false as const, error: 'boom upstream 500' }));
    const setEffectiveToolsState = vi.fn();
    Object.assign(h.deps.gateway, { getEffectiveTools });
    Object.assign(h.deps, { setEffectiveToolsState });
    const dispatcher = h.dispatcher as unknown as {
      fetchEffectiveTools: (gatewayId: string, sessionKey: string) => Promise<void>;
    };

    await dispatcher.fetchEffectiveTools('gw-1', TASK.sessionKey);

    expect(setEffectiveToolsState).toHaveBeenLastCalledWith('gw-1', TASK.sessionKey, {
      status: 'error',
      error: 'boom upstream 500',
    });
  });

  it.each([
    ['missing agent identity', { profile: 'coding', groups: [] }],
    [
      'missing group tools',
      { agentId: 'main', profile: 'coding', groups: [{ id: 'core', label: 'Core', source: 'core' }] },
    ],
    [
      'malformed tool entry',
      {
        agentId: 'main',
        profile: 'coding',
        groups: [{ id: 'core', label: 'Core', source: 'core', tools: [{ id: 'exec', source: 'core' }] }],
      },
    ],
    ['malformed notices', { agentId: 'main', profile: 'coding', groups: [], notices: {} }],
  ])('fails closed for a structurally invalid tools.effective result: %s', async (_name, result) => {
    const h = createHarness();
    const getEffectiveTools = vi.fn(async () => ({ ok: true as const, result }));
    const setEffectiveToolsState = vi.fn();
    Object.assign(h.deps.gateway, { getEffectiveTools });
    Object.assign(h.deps, { setEffectiveToolsState });

    await h.dispatcher.fetchEffectiveTools('gw-1', TASK.sessionKey);

    expect(setEffectiveToolsState).toHaveBeenLastCalledWith('gw-1', TASK.sessionKey, {
      status: 'error',
      error: 'tools.effective returned an invalid response',
    });
    expect(setEffectiveToolsState).not.toHaveBeenCalledWith(
      'gw-1',
      TASK.sessionKey,
      expect.objectContaining({ status: 'ready' }),
    );
  });

  it('refreshes after the gateway materializes or patches the task session', async () => {
    const h = createHarness();
    const getEffectiveTools = vi.fn(async () => ({
      ok: true as const,
      result: { agentId: 'main', profile: 'coding', groups: [] },
    }));
    Object.assign(h.deps.gateway, { getEffectiveTools });

    h.emit('sessions.changed', { sessionKey: TASK.sessionKey, reason: 'created' });
    await vi.waitFor(() => expect(getEffectiveTools).toHaveBeenCalledWith('gw-1', TASK.sessionKey));
  });

  it('does not let an older failed lookup overwrite a newer ready inventory', async () => {
    const h = createHarness();
    let releaseOld!: (value: { ok: false; error: string }) => void;
    const oldResponse = new Promise<{ ok: false; error: string }>((resolve) => {
      releaseOld = resolve;
    });
    const inventory = { agentId: 'main', profile: 'coding', groups: [] };
    const getEffectiveTools = vi
      .fn()
      .mockImplementationOnce(() => oldResponse)
      .mockResolvedValueOnce({ ok: true, result: inventory });
    const setEffectiveToolsState = vi.fn();
    Object.assign(h.deps.gateway, { getEffectiveTools });
    Object.assign(h.deps, { setEffectiveToolsState });

    const older = h.dispatcher.fetchEffectiveTools('gw-1', TASK.sessionKey);
    const newer = h.dispatcher.fetchEffectiveTools('gw-1', TASK.sessionKey);
    await newer;
    releaseOld({ ok: false, error: 'unknown session key' });
    await older;

    expect(setEffectiveToolsState).toHaveBeenLastCalledWith('gw-1', TASK.sessionKey, {
      status: 'ready',
      inventory,
    });
  });
});

describe('actual slide producer page records', () => {
  const packet = {
    schemaVersion: 1,
    status: 'slidegen-progress',
    sourceSha256: 'a'.repeat(64),
    completed: 1,
    total: 3,
  };
  const command = 'node "managed/deck-layout/scripts/generate.cjs" "report.slidegen"';
  function live(activeCommand = command) {
    const h = createHarness();
    h.messageStore.activeTurnBySession[TASK.sessionKey] = {
      runId: 'page-run',
      toolCalls: [
        {
          id: 'page-call',
          name: 'exec',
          status: 'running',
          args: { command: activeCommand },
          startedAt: '2026-10-02T00:00:00.000Z',
        },
      ],
    };
    return h;
  }
  function emit(h: ReturnType<typeof createHarness>, data: Record<string, unknown>, runId = 'page-run') {
    h.emit('agent', {
      sessionKey: TASK.sessionKey,
      runId,
      stream: 'tool',
      data: { name: 'exec', toolCallId: 'page-call', ...data },
    });
  }
  it.each([command, 'node "C:\\skills\\deck-layout\\scripts\\generate.cjs" "report.slidegen"'])(
    'carries actual native partialResult pages for %s without completion',
    (activeCommand) => {
      const h = live(activeCommand);
      emit(h, { phase: 'update', partialResult: { content: [{ type: 'text', text: JSON.stringify(packet) }] } });
      expect(h.messageStore.upsertToolCall).toHaveBeenCalledWith(
        TASK.sessionKey,
        TASK.id,
        expect.objectContaining({
          slideProgress: packet,
          // 【V2 白名单】update 相位落 dispatched（旧口径 running）
          status: 'dispatched',
          startedAt: '2026-10-02T00:00:00.000Z',
          result: undefined,
          completedAt: undefined,
        }),
      );
      h.dispatcher.reset();
    },
  );
  it('reads the latest confirmed page from an incremental still-running process poll', () => {
    const h = live();
    const text = JSON.stringify({ ...packet, completed: 2 }) + '\n\nProcess still running.';
    emit(h, {
      name: 'process',
      toolCallId: 'poll-call',
      phase: 'result',
      args: { action: 'poll', sessionId: 'native-session' },
      result: { content: [{ type: 'text', text }] },
    });
    expect(h.messageStore.upsertToolCall).toHaveBeenCalledWith(
      TASK.sessionKey,
      TASK.id,
      expect.objectContaining({ slideProgress: { ...packet, completed: 2 }, result: text, status: 'done' }),
    );
    h.dispatcher.reset();
  });
  it.each([
    ['foreign text', 'secret-token\n' + JSON.stringify(packet)],
    ['invalid counts', JSON.stringify({ ...packet, completed: 4 })],
  ])('does not project a page from %s', (_label, text) => {
    const h = live();
    emit(h, { phase: 'update', partialResult: { content: [{ type: 'text', text }] } });
    expect(h.messageStore.upsertToolCall.mock.calls.at(-1)?.[2]).not.toHaveProperty('slideProgress', packet);
    h.dispatcher.reset();
  });
  it('does not project product pages from an unrelated exec command', () => {
    const h = live();
    h.messageStore.activeTurnBySession[TASK.sessionKey] = {
      runId: 'page-run',
      toolCalls: [
        { id: 'page-call', name: 'exec', status: 'running', args: { command: 'node unrelated.cjs' }, startedAt: '' },
      ],
    };
    emit(h, { phase: 'update', partialResult: { content: [{ type: 'text', text: JSON.stringify(packet) }] } });
    expect(h.messageStore.upsertToolCall.mock.calls.at(-1)?.[2]).not.toHaveProperty('slideProgress', packet);
    h.dispatcher.reset();
  });
});

/**
 * P1-1 验收（2026-10-08 对话可视化改造）：**旧 run 的迟到事件不得更新新 run**。
 *
 * 「最新活动」元数据是在 store 写入方法里同步留下的（`message-store-activity.test.ts`
 * 钉住顺序语义），它能不能被旧帧污染，取决于 dispatcher 的 stale-run 闸门 ——
 * 就是这里验证的东西：新 run 开始后，旧 run 的迟到 thinking 帧必须被丢弃，
 * 连 `appendThinkingDelta` 都不许进（元数据与内容同守卫、同规则）。
 */
describe('最新活动元数据 —— 旧 run 迟到帧闸门', () => {
  it('run2 开始后，run1 的迟到 thinking 帧被丢弃（不写 store、不碰活动）', () => {
    const h = createHarness();
    h.emit('agent', {
      sessionKey: TASK.sessionKey,
      stream: 'lifecycle',
      data: { phase: 'start' },
      runId: 'run-1',
    });
    h.emit('agent', {
      sessionKey: TASK.sessionKey,
      stream: 'thinking',
      data: { text: 'A', delta: 'A' },
      runId: 'run-1',
    });
    expect(h.messageStore.appendThinkingDelta).toHaveBeenCalledTimes(1);

    h.emit('agent', {
      sessionKey: TASK.sessionKey,
      stream: 'lifecycle',
      data: { phase: 'start' },
      runId: 'run-2',
    });
    const before = h.messageStore.appendThinkingDelta.mock.calls.length;
    h.emit('agent', {
      sessionKey: TASK.sessionKey,
      stream: 'thinking',
      data: { text: 'A+迟到', delta: '迟到' },
      runId: 'run-1',
    });
    expect(h.messageStore.appendThinkingDelta.mock.calls.length, '旧 run 的迟到帧不得写入新 run').toBe(before);
  });
});
