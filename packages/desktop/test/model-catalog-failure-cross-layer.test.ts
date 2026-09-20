import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createGatewayDispatcher,
  createUiStore,
  type GatewayDispatcherDeps,
  type GatewayEvent,
  type GatewayStatusEvent,
} from '@clawwork/core';
import type { ModelCatalogEntry } from '@clawwork/shared';
import { deriveModelAvailability, modelStatusCopy } from '../src/renderer/components/ChatInput/model-availability';
import { deriveStartupReadiness } from '../src/renderer/lib/startup-readiness';

/**
 * 跨层回归钉：**网关取不到目录 → store 落失败态 → 模型那一格的错误态 → 输入区不再永久 loading**。
 *
 * ## 为什么单独有这个文件
 *
 * 2026-09-20 复核（codex）指出：上面每一段各自都有测试，但**接缝**没有 ——
 *   · core 的 `gateway-dispatcher.test.ts` 只到"调了哪个 deps 回调"（桩是 vi.fn()）；
 *   · 桌面的 `startup-readiness-screen.test.tsx` **手搭** `ai: { phase: 'catalog-failed' }`，
 *     根本不经 `deriveStartupReadiness`；
 *   · `chat-send-stability.test.tsx` 的 `useChatSend` 是**整块桩**（曾经写死一个联合里
 *     不存在的 `'available'`），store→可用性那段链在那份测试里跑不到真身。
 * 于是"store 真的落下失败态之后，界面到底显示什么"没有任何一条测试真的走过。
 *
 * 这里全部用**真身**：真 dispatcher + 真 store（`createUiStore`）+ 真派生 + 真文案分档。
 * 只替换最外层（网关 IPC 与系统边界），因为那是进程外的东西。
 */

const GW = 'gw-1';
const RAW_RELAY_MODEL = { id: 'deepseek-v4-flash', provider: 'clawrouter', name: 'DeepSeek V4 Flash' };
const models = [RAW_RELAY_MODEL] as ModelCatalogEntry[];

function createHarness(listModels: () => Promise<{ ok: boolean; result?: unknown }>) {
  const store = createUiStore({
    updateSettings: vi.fn(),
    changeLanguage: vi.fn(),
    storage: { get: () => null, set: vi.fn() },
    getViewportWidth: () => 1266,
  });

  let statusListener: ((status: GatewayStatusEvent) => void) | null = null;

  const deps = {
    gateway: {
      onGatewayEvent: (_cb: (event: GatewayEvent) => void) => () => {},
      onGatewayStatus: (cb: (status: GatewayStatusEvent) => void) => {
        statusListener = cb;
        return () => {
          statusListener = null;
        };
      },
      gatewayStatus: async () => ({}),
      listGateways: async () => [],
      listModels,
      listAgents: async () => ({ ok: true, result: {} }),
      getToolsCatalog: async () => ({ ok: true, result: {} }),
      getSkillsStatus: async () => ({ ok: true, result: {} }),
      listCommands: async () => ({ ok: true, result: {} }),
      chatHistory: async () => ({ ok: true, result: {} }),
    },
    getSettings: async () => null,
    sendNotification: async () => {},
    getTaskStore: () => ({ tasks: [], updateTaskTitle: vi.fn() }),
    getMessageStore: () => ({}),
    getActiveTaskId: () => null,
    markUnread: vi.fn(),
    // ⭐ 下面这几个是**真 store** 的动作 —— 这份测试要看的正是"落进 store 之后"。
    setGatewayStatusByGateway: (gatewayId: string, status: 'connected' | 'connecting' | 'disconnected') =>
      store.getState().setGatewayStatusByGateway(gatewayId, status),
    setModelCatalogForGateway: (gatewayId: string, list: unknown[]) =>
      store.getState().setModelCatalogForGateway(gatewayId, list as ModelCatalogEntry[]),
    setModelCatalogFailureForGateway: (gatewayId: string, failed: boolean) =>
      store.getState().setModelCatalogFailureForGateway(gatewayId, failed),
    setGatewayVersion: vi.fn(),
    setGatewayReconnectInfo: vi.fn(),
    setDefaultGatewayId: (id: string | null) => store.getState().setDefaultGatewayId(id),
    setGatewayInfoMap: vi.fn(),
    setGatewaysLoaded: vi.fn(),
    getGatewayInfoMap: () => ({}),
    setAgentCatalogForGateway: vi.fn(),
    setToolsCatalogForGateway: vi.fn(),
    setSkillsStatusForGateway: vi.fn(),
    setCommandCatalogForGateway: vi.fn(),
    lookupTaskIdBySubagentKey: () => undefined,
    onPerformerCandidate: vi.fn(),
    onSubagentCandidate: vi.fn(),
    onApprovalRequested: vi.fn(),
    onApprovalResolved: vi.fn(),
    onQuestionRequested: vi.fn(),
    onQuestionResolved: vi.fn(),
    syncPendingQuestions: vi.fn(),
    notifyAgentResponse: vi.fn(),
    isEphemeralSession: () => false,
    isSessionAbortedByUser: () => false,
    onToast: vi.fn(),
    translate: (key: string) => key,
    isWindowFocused: () => true,
    reportDebugEvent: vi.fn(),
    hydrateFromLocal: vi.fn(),
    syncFromGateway: vi.fn(),
    syncSessionMessages: vi.fn(async () => {}),
    retrySyncPending: vi.fn(),
  } as unknown as GatewayDispatcherDeps;

  const dispatcher = createGatewayDispatcher(deps);
  dispatcher.startGatewayStatus();

  return {
    store,
    connect: () => statusListener?.({ gatewayId: GW, connected: true }),
    disconnect: () => statusListener?.({ gatewayId: GW, connected: false, error: 'socket closed' }),
  };
}

/** 拿 store 当前状态把两条派生链跑一遍（界面真正消费的就是这两个函数的返回值）。 */
function readUi(store: ReturnType<typeof createUiStore>) {
  const state = store.getState();
  const gatewayStatus = state.gatewayStatusMap[GW];
  const rawModelCatalog = state.modelCatalogByGateway[GW];
  const catalogFailed = state.modelCatalogFailureByGateway[GW] === true;
  const modelAvailability = deriveModelAvailability({
    gatewayId: GW,
    gatewayStatus,
    rawCatalog: rawModelCatalog,
    catalogFailed,
    modelCount: (rawModelCatalog ?? []).filter((m) => m.provider === 'clawrouter').length,
  });
  const readiness = deriveStartupReadiness({
    gatewayId: GW,
    gatewayStatus,
    rawModelCatalog,
    catalogFailed,
    assistantSnapshot: { phase: 'ready', completed: 6, total: 6, missingIds: [] },
  });
  return {
    state,
    modelAvailability,
    readiness,
    copy: modelStatusCopy(modelAvailability, (key) => key),
  };
}

describe('模型目录取不到的跨层链（网关 → store → 派生 → 文案）', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('⭐ 一直取不到：store 落显式失败态，输入区**不再**被永久锁住，文案说的是"取不到"', async () => {
    vi.useFakeTimers();
    const h = createHarness(async () => ({ ok: false, error: 'gateway not ready' }));
    h.connect();
    await vi.advanceTimersByTimeAsync(120_000);

    const ui = readUi(h.store);

    // ① 网关连接是好的（问题不在"断线"），目录却始终没落下来
    expect(ui.state.gatewayStatusMap[GW]).toBe('connected');
    expect(ui.state.modelCatalogByGateway[GW]).toBeUndefined();
    // ② store 落下**显式失败态**（不是缺席、更不是空目录）
    expect(ui.state.modelCatalogFailureByGateway[GW]).toBe(true);

    // ③ 派生链：相位是"取不到"，且**不再拦输入框**
    expect(ui.readiness.ai.phase).toBe('catalog-failed');
    expect(ui.readiness.composerBlocked).toBe(false);
    expect(ui.readiness.hasError).toBe(true);

    // ④ 文案：说"取不到"，且**不许**再转圈（转圈 = 让用户永远等）
    expect(ui.modelAvailability).toBe('catalog-failed');
    expect(ui.copy?.label).toBe('chatInput.modelsUnavailable');
    expect(ui.copy?.preparing).toBe(false);
  });

  it('⭐ 失败几次后成功：目录落地，且失败标记由 **store 自己**作废（dispatcher 不再重复清）', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const h = createHarness(async () => {
      calls += 1;
      return calls === 1 ? { ok: false, error: 'not ready' } : { ok: true, result: { models } };
    });
    h.connect();
    await vi.advanceTimersByTimeAsync(10_000);

    const ui = readUi(h.store);

    expect(calls).toBeGreaterThan(1);
    expect(ui.state.modelCatalogByGateway[GW]).toEqual(models);
    // ⚠️ 诚实口径（变异验证纠正过一次）：本例里失败标记**从没被写成 true**
    //    （第一次失败只是重排一次退避，不是终态）⇒ 这条断言**不**证明"store 的
    //    原子清理是必需的"。那个不变式由 `ui-store-catalog-failure.test.ts` 直接钉住。
    //    这条守的是另一件事：重试成功后 UI 必须回到能干活、且不再转圈。
    expect(ui.state.modelCatalogFailureByGateway[GW]).toBeUndefined();

    // 恢复：能干活就该说能干活（一次失败的重取不该把已经能用的界面说成坏的）
    expect(ui.modelAvailability).toBe('ready');
    expect(ui.readiness.composerBlocked).toBe(false);
    expect(ui.copy).toBeNull();
  });

  it('⭐ 断线重连：上一轮的"取不到"先归位（界面回到"正在准备"，不是留着已经作废的失败）', async () => {
    vi.useFakeTimers();
    const h = createHarness(async () => ({ ok: false, error: 'gateway not ready' }));
    h.connect();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.store.getState().modelCatalogFailureByGateway[GW], '先得真的落过失败态').toBe(true);

    h.disconnect();
    h.connect();

    // 新的一链起来时先把标记归位 —— 否则用户在重连后看到的是**上一轮**的失败结论，
    // 而这一轮其实才刚开始问（那是替网关下结论的另一种形式）。
    expect(h.store.getState().modelCatalogFailureByGateway[GW]).toBeUndefined();
    expect(readUi(h.store).modelAvailability).toBe('models-loading');
    expect(readUi(h.store).readiness.composerBlocked).toBe(true);

    await vi.advanceTimersByTimeAsync(120_000); // 把这一轮的退避链走完，别把计时器留给下一个用例
  });

  it('空目录（网关确实回了 models: []）与"取不到"落的是**两个**不同结论', async () => {
    vi.useFakeTimers();
    const h = createHarness(async () => ({ ok: true, result: { models: [] } }));
    h.connect();
    await vi.advanceTimersByTimeAsync(120_000);

    const ui = readUi(h.store);

    expect(ui.state.modelCatalogByGateway[GW]).toEqual([]);
    // 空目录是**已解决**的结论 ⇒ 不带失败标记，界面说"暂无可用模型"而不是"取不到"
    expect(ui.state.modelCatalogFailureByGateway[GW]).toBeUndefined();
    expect(ui.modelAvailability).toBe('empty');
    expect(ui.copy?.label).toBe('chatInput.noModelsAvailable');
    // 两种结论都不该锁住输入框
    expect(ui.readiness.composerBlocked).toBe(false);
  });
});
