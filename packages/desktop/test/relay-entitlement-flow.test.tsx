// @vitest-environment jsdom

/**
 * 中转 bootstrap 的**公开状态** → 启动就绪 / 重试 → 这一条接线（Task 4）。
 *
 * 为什么单开一个文件：这条链路横跨三层（主进程的公开状态 → `useStartupReadiness` →
 * 网关/目录/助手的刷新），而它最容易坏的地方**不在断言里能看见的语义**，在两件时序的事：
 *
 *   1. **订阅必须先于初始读**。反过来的话，"订阅之前那一瞬"发生的事件没人收，
 *      而初始读又把更旧的结论盖回去 —— 界面于是把已经确定的失败重新显示成"正在准备"。
 *   2. **晚到的初始读不许覆盖更新的事件**。主进程那条 `updatedAt` 严格单调
 *      （见 `@clawwork/shared` 的事件契约），所以取舍永远判得出来。
 *
 * ⚠️ 判据一律是 **`errorCode` 与相位的配对**，不是"有没有出错"：可重试的才排队重跑，
 *    确定性的（卡绑在别的组织、卡过期…）连重试都不发 —— 那只是让用户做无用功。
 */

import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcResult, RelayBootstrapPublicState } from '@clawwork/shared';

const gatewayMocks = vi.hoisted(() => ({
  fetchAgentsForGateway: vi.fn(async () => undefined),
  reinitializeGatewayBootstrap: vi.fn(async () => undefined),
}));

const coordinatorMocks = vi.hoisted(() => ({
  subscribe: vi.fn(() => () => {}),
  run: vi.fn(async () => undefined),
  reset: vi.fn(),
}));

// 走真实的网关接线会去碰 electron 侧的东西；这里只关心**有没有被调到**。
vi.mock('../src/renderer/hooks/useGatewayDispatcherSetup', () => gatewayMocks);
// 助手这几轮由另一个文件的用例守着（`startup-preset-agent-lifecycle.test.ts`）：
// 这里把它换成哑的，免得 6 个预设助手的安装过程把这几条时序用例淹掉。
vi.mock('../src/renderer/lib/preset-agent-bootstrap', () => ({
  presetAgentBootstrapCoordinator: coordinatorMocks,
}));

import { useStartupReadiness } from '../src/renderer/hooks/useStartupReadiness';
import { useUiStore } from '../src/renderer/stores/uiStore';
import { relayModelStatusCopy, type StartupRelayFailure } from '../src/renderer/lib/startup-readiness';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type HookState = ReturnType<typeof useStartupReadiness>;

function mountHarness() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  let latest: HookState | null = null;

  function Harness() {
    const state = useStartupReadiness(true);
    useEffect(() => {
      latest = state;
    }, [state]);
    return null;
  }

  return {
    get state(): HookState {
      if (!latest) throw new Error('harness 还没渲染出第一帧');
      return latest;
    },
    render: () => act(() => root.render(<Harness />)),
    /** 让挂起的 promise / effect 全部落地（`act` 里等一轮微任务）。 */
    flush: async () => {
      await act(async () => undefined);
    },
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

let listeners: Array<(state: RelayBootstrapPublicState) => void> = [];
let order: string[] = [];
let resolveRead: ((value: IpcResult<RelayBootstrapPublicState>) => void) | null = null;
let rejectRead: ((reason: unknown) => void) | null = null;

const relayApi = {
  onCommercialRelayBootstrapState: vi.fn((callback: (state: RelayBootstrapPublicState) => void) => {
    order.push('subscribe');
    listeners.push(callback);
    return () => {
      listeners = listeners.filter((item) => item !== callback);
    };
  }),
  commercialRelayBootstrapState: vi.fn(
    () =>
      new Promise<IpcResult<RelayBootstrapPublicState>>((resolve, reject) => {
        order.push('read');
        resolveRead = resolve;
        rejectRead = reject;
      }),
  ),
  commercialRelayBootstrapRetry: vi.fn(async () => ({ ok: true })),
};

function emit(state: RelayBootstrapPublicState): void {
  for (const listener of [...listeners]) listener(state);
}

beforeEach(() => {
  listeners = [];
  order = [];
  resolveRead = null;
  rejectRead = null;
  relayApi.onCommercialRelayBootstrapState.mockClear();
  relayApi.commercialRelayBootstrapState.mockClear();
  relayApi.commercialRelayBootstrapRetry.mockClear();
  gatewayMocks.reinitializeGatewayBootstrap.mockClear();
  coordinatorMocks.run.mockClear();
  coordinatorMocks.reset.mockClear();

  Object.defineProperty(window, 'clawwork', { configurable: true, value: relayApi });

  // 网关连上了、目录**还没到** —— 这就是"正在准备模型"那个形状的现场。
  useUiStore.setState({
    defaultGatewayId: 'gw-1',
    gatewayStatusMap: { 'gw-1': 'connected' },
    modelCatalogByGateway: {},
  } as never);
});

describe('useStartupReadiness × 中转公开状态', () => {
  it('⭐⭐ 先订阅再读初始快照：晚到的初始读不许把更新的结论盖回去', async () => {
    const harness = mountHarness();
    harness.render();

    // 顺序本身就是断言：读在前、订阅在后的话，"订阅前的最后一次转变"永远收不到。
    expect(order, '订阅必须先于初始读').toEqual(['subscribe', 'read']);
    expect(harness.state.relayFailure, '还没有结论时不许凭空报错').toBeNull();

    // 挂上之后主进程发来一条**确定性的**失败（第二台机器实机的形状）。
    act(() => emit({ phase: 'blocked', errorCode: 'license_bound_elsewhere', updatedAt: 9 }));
    expect(harness.state.relayFailure?.kind).toBe('organization-mismatch');
    expect(harness.state.ai.phase).toBe('error');
    expect(harness.state.composerBlocked, '有结论了就不该再锁着用户').toBe(false);

    // 初始读这时才回来，带着**更旧**的一条（窗口建好之前跑的那一轮）。
    await act(async () => {
      resolveRead?.({ ok: true, result: { phase: 'ready', updatedAt: 1 } });
    });
    expect(harness.state.relayFailure?.kind, '晚到的初始读不许覆盖更新的那条事件').toBe('organization-mismatch');
    expect(harness.state.ai.phase).not.toBe('ready');

    harness.unmount();
  });

  it('⭐ 取舍看 `updatedAt` 而不是"谁先到"：初始读更新时照常生效', async () => {
    const harness = mountHarness();
    harness.render();

    act(() => emit({ phase: 'blocked', errorCode: 'license_expired', updatedAt: 9 }));
    expect(harness.state.relayFailure?.kind).toBe('entitlement-rejected');

    await act(async () => {
      resolveRead?.({ ok: true, result: { phase: 'ready', updatedAt: 12 } });
    });
    expect(harness.state.relayFailure, '更新的那条说了算').toBeNull();
    expect(harness.state.hasError).toBe(false);

    harness.unmount();
  });

  it('⭐⭐ 可重试失败：先排队重跑商业 bootstrap，状态回到 ready 之后才刷网关与助手', async () => {
    const harness = mountHarness();
    harness.render();
    await act(async () => {
      resolveRead?.({ ok: true, result: { phase: 'retryable-error', errorCode: 'transport', updatedAt: 4 } });
    });

    expect(harness.state.relayFailure).toEqual({ kind: 'retryable', errorCode: 'transport' });
    expect(harness.state.composerBlocked).toBe(false);
    gatewayMocks.reinitializeGatewayBootstrap.mockClear();
    coordinatorMocks.run.mockClear();

    await act(async () => {
      await harness.state.retry();
    });
    expect(relayApi.commercialRelayBootstrapRetry, '重试要先让主进程重跑一轮').toHaveBeenCalledOnce();
    expect(
      gatewayMocks.reinitializeGatewayBootstrap,
      '现在就刷是白刷：中转配置还没落上去，目录照样取不到',
    ).not.toHaveBeenCalled();

    // 主进程那一轮跑完了（公开状态翻成 ready）。
    await act(async () => emit({ phase: 'ready', updatedAt: 6 }));
    await harness.flush();
    expect(gatewayMocks.reinitializeGatewayBootstrap).toHaveBeenCalledOnce();
    expect(coordinatorMocks.run, '助手也等 ready 之后再刷').toHaveBeenCalled();
    expect(harness.state.relayFailure).toBeNull();

    harness.unmount();
  });

  it('⭐⭐ 确定性失败不给重试：既不排队重跑，也不刷目录（`license_required` 同样）', async () => {
    const harness = mountHarness();
    harness.render();
    await act(async () => {
      resolveRead?.({ ok: true, result: { phase: 'blocked', errorCode: 'license_bound_elsewhere', updatedAt: 4 } });
    });

    await act(async () => {
      await harness.state.retry();
    });
    expect(relayApi.commercialRelayBootstrapRetry, '再试一万次也是一样的结论').not.toHaveBeenCalled();
    expect(gatewayMocks.reinitializeGatewayBootstrap).not.toHaveBeenCalled();
    expect(coordinatorMocks.reset).not.toHaveBeenCalled();
    expect(harness.state.relayFailure?.kind, '结论不该被重试改掉').toBe('organization-mismatch');

    harness.unmount();
  });

  it('⭐⭐ "读不到"不是"不行了"：初始读失败按"还不知道"走，不许凭空报错', async () => {
    const harness = mountHarness();
    harness.render();

    await act(async () => {
      rejectRead?.(new Error('ipc down'));
    });
    expect(harness.state.relayFailure).toBeNull();
    expect(harness.state.hasError).toBe(false);
    expect(harness.state.ai.phase, '仍然是那条有界的目录推断').toBe('loading-models');
    expect(harness.state.composerBlocked).toBe(true);

    harness.unmount();
  });
});

/**
 * 输入框那一格（模型状态）—— `ChatInput` 把它交给 `relayModelStatusCopy`，
 * 这里钉的是那条覆盖**本身**：已知失败时不许再说"正在准备…"。
 *
 * ⚠️ 为什么要单独钉：`preparing: true` 那一档在界面上的表现是**转圈 + 一句承诺**
 *    （「准备完成后会自动显示，无需重复操作」）。失败已经确定时那句承诺永远不会兑现，
 *    用户照着它等下去就是"卡住"。
 */
describe('relayModelStatusCopy —— 输入框那一格不许再"准备"', () => {
  const t = (key: string): string => key;
  const cases: StartupRelayFailure[] = [
    { kind: 'activation-required', errorCode: 'license_required' },
    { kind: 'organization-mismatch', errorCode: 'license_bound_elsewhere' },
    { kind: 'entitlement-rejected', errorCode: 'license_expired' },
    { kind: 'retryable', errorCode: 'transport' },
  ];

  it('⭐⭐ 四档失败都是非准备态，而且换掉了"正在准备"那两句', () => {
    for (const failure of cases) {
      const copy = relayModelStatusCopy(failure, t);
      expect(copy.preparing, `${failure.errorCode} 不许转圈`).toBe(false);
      expect(copy.label).toBe('chatInput.relayUnavailable');
      expect(copy.detail).not.toBe('chatInput.modelsLoadingDetail');
      expect(copy.detail).not.toBe('chatInput.aiServiceStartingDetail');
    }
  });

  it('⭐ 每一档说自己的出口（激活 / 组织不一致 / 卡不可用 / 再试一次）', () => {
    const detailFor = (failure: StartupRelayFailure): string => relayModelStatusCopy(failure, t).detail;

    expect(detailFor(cases[0])).toBe('chatInput.relayActivationRequiredDetail');
    expect(detailFor(cases[1])).toBe('chatInput.relayOrganizationMismatchDetail');
    expect(detailFor(cases[2])).toBe('chatInput.relayEntitlementRejectedDetail');
    expect(detailFor(cases[3])).toBe('chatInput.relayRetryableDetail');
  });
});
