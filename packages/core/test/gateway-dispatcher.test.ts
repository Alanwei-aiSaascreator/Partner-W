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
    setSessionProgressText: vi.fn(),
    /** 临时会话（多模型对比的一列）的失败走这条旁路，不进时间线。 */
    setSessionError: vi.fn(),
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

    expect(h.messageStore.appendStreamDelta).toHaveBeenCalledWith(KEY_0, '第 1 列的字');
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
describe('approval 流：被拦下的命令不许显示成"已完成"', () => {
  type EmittedToolCall = { id: string; name: string; status: string; result?: string };

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
    expect(lastToolCall(h).status, '前置：只看 tool 流，网关确实报的是"没出错"').toBe('done');

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

  it('审批**还在等**（status:"pending"）不动它 —— 命令还有可能跑', () => {
    const h = createHarness();
    emitBlockedExecResult(h, 'call_pending');
    const callsBefore = h.messageStore.upsertToolCall.mock.calls.length;

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

    expect(
      h.messageStore.upsertToolCall.mock.calls.length,
      'pending 不该写 store：报成失败是另一种撒谎，而"退回进行中"又做不到（不许降级）',
    ).toBe(callsBefore);
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
