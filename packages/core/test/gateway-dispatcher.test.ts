import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createGatewayDispatcher,
  DELIBERATELY_IGNORED_STREAMS,
  RETRY_RUN_PHASE,
  RUN_PHASE_IDS,
  TOOL_IGNORED_PHASES,
  TOOL_PHASE_IDS,
  type GatewayDispatcherDeps,
} from '../src/services/gateway-dispatcher.js';
import type { GatewayEvent, GatewayStatusEvent } from '../src/ports/gateway-transport.js';
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

  it('⭐ `pending` 同样算"知道但不接"（那时命令**还有可能跑**，报成失败是另一种撒谎）', () => {
    const h = createHarness();

    emitApproval(h, 'pending');

    expect(h.deps.reportDebugEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'renderer.agent.approval.ignored_status',
        data: expect.objectContaining({ status: 'pending' }),
      }),
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
