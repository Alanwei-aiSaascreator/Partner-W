import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGatewayDispatcher, type GatewayDispatcherDeps } from '../src/services/gateway-dispatcher.js';
import type { GatewayEvent, GatewayStatusEvent } from '../src/ports/gateway-transport.js';

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
      gatewayStatus: async () => ({}),
      listGateways: async () => [],
      listModels: async () => ({ ok: true, result: {} }),
      listAgents: async () => ({ ok: true, result: {} }),
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
    setGatewayReconnectInfo: vi.fn(),
    setDefaultGatewayId: vi.fn(),
    setGatewayInfoMap: vi.fn(),
    setGatewaysLoaded: vi.fn(),
    getGatewayInfoMap: () => ({}),
    setModelCatalogForGateway: vi.fn(),
    setAgentCatalogForGateway: vi.fn(),
    setToolsCatalogForGateway: vi.fn(),
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

  return { emit, emitStatus, dispatcher, deps, systemMessages, toasts, messageStore };
}

function emitChatError(
  h: ReturnType<typeof createHarness>,
  opts: { errorMessage: string; errorCode?: string; runId?: string },
) {
  h.emit('chat', {
    sessionKey: TASK.sessionKey,
    state: 'error',
    errorMessage: opts.errorMessage,
    errorCode: opts.errorCode,
    runId: opts.runId,
  });
}

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
