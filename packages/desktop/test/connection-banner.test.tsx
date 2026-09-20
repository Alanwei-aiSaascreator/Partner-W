// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 横幅：**首次启动那 50 秒里说的话**必须是真的（2026-09-20 实机截图 + 复核点名）。
 *
 * 现场三句话互相打架：横幅「网关"X"已断开，正在尝试重连… (0/10)」+ 输入框
 * 「离线模式 — 只读」+ 准备面板「准备时间比平时更久」。用户结论只有一个：坏了。
 *
 * 这份测试用**真 store**（`createUiStore`）驱动横幅，钉三件事：
 *   ① 从没连上过的预热期**不许**说"已断开"，也不许出现那个像失败计数的 `(0/10)`；
 *   ② 连上过又掉了才是"断开/重连"，且计数器只在**真重试过**（attempt > 0）之后才出现；
 *   ③ 每个失败态都必须有**出口**（立即重试）；"正在启动"说太久（超预算）也要改口成失败。
 *
 * ⚠️ 只桩 `react-i18next`（拿 key 当文案，参数拼在后面）与 store 模块（换成真 core
 *    store 的实例，避开 electron 那串依赖）—— 被测组件本身跑真身。
 */

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${Object.values(params).join(':')}` : key),
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

vi.mock('../src/renderer/stores/uiStore', async () => {
  const { createUiStore } = await import('@clawwork/core');
  const { useStore } = await import('zustand');
  const api = createUiStore({
    updateSettings: async () => {},
    changeLanguage: async () => {},
    storage: { get: () => null as string | null, set: () => {} },
    getViewportWidth: () => 1266,
  });
  const useUiStore = (selector?: (state: unknown) => unknown) => useStore(api, selector as never);
  // 与 `platform/index.ts` 同形：测试里要用 `getState / setState` 直接摆状态。
  (useUiStore as unknown as { getState: unknown }).getState = api.getState;
  (useUiStore as unknown as { setState: unknown }).setState = api.setState;
  return { useUiStore };
});

const { useUiStore } = (await import('../src/renderer/stores/uiStore')) as unknown as {
  useUiStore: {
    (selector?: (state: unknown) => unknown): unknown;
    getState: () => {
      setGatewayStatusByGateway: (id: string, status: 'connected' | 'connecting' | 'disconnected') => void;
      setGatewayReconnectInfo: (id: string, info: { attempt: number; max: number; gaveUp: boolean } | null) => void;
    };
    setState: (partial: Record<string, unknown>) => void;
  };
};
import ConnectionBanner from '../src/renderer/components/ConnectionBanner';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const GW = 'gw-local';
const STARTUP_GRACE_MS = 360_000;

let reconnectGateway: ReturnType<typeof vi.fn>;

function mount(): { container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => root.render((<ConnectionBanner />) as ReactElement));
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

/** 摆一个"这台机器配了本机网关"的世界，状态由各条测试自己往下推。 */
function arrangeGateway(): void {
  useUiStore.setState({
    gatewaysLoaded: true,
    defaultGatewayId: GW,
    gatewayInfoMap: { [GW]: { id: GW, name: '本机网关' } },
    gatewayStatusMap: {},
    gatewayReconnectInfo: {},
    gatewayEverConnected: {},
  });
}

describe('ConnectionBanner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    reconnectGateway = vi.fn();
    Object.assign(window, { clawwork: { reconnectGateway } });
    arrangeGateway();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('⭐ 从没连上过 + 预热期那次连接失败 ⇒ 说"正在启动"，不说"已断开"，更不出现 (0/10)', () => {
    // 这就是实机那一刻的形状：真有过错误（首次 connect 15 秒超时），但这次运行从没连上过。
    useUiStore.getState().setGatewayStatusByGateway(GW, 'disconnected');
    useUiStore.getState().setGatewayReconnectInfo(GW, { attempt: 0, max: 10, gaveUp: false });

    const { container, unmount } = mount();
    expect(container.textContent).toContain('connection.startingBanner');
    expect(container.textContent, '预热期说"已断开"就是那句假话').not.toContain('connection.reconnectingBanner');
    expect(container.textContent, '`(0/10)` 看着像"已经失败 0 次"').not.toContain('connection.attemptProgress');
    unmount();
  });

  it('还没拿到任何状态、但本机网关是配过的 ⇒ 同样说"正在启动"（不是什么都不说）', () => {
    const { container, unmount } = mount();
    expect(container.textContent).toContain('connection.startingBanner');
    unmount();
  });

  it('连上过又掉了、真在重试 ⇒ 断开/重连 + 计数器（第 n/m 次）', () => {
    useUiStore.getState().setGatewayStatusByGateway(GW, 'connected');
    useUiStore.getState().setGatewayStatusByGateway(GW, 'disconnected');
    useUiStore.getState().setGatewayReconnectInfo(GW, { attempt: 2, max: 10, gaveUp: false });

    const { container, unmount } = mount();
    expect(container.textContent).toContain('connection.reconnectingBanner');
    expect(container.textContent).toContain('connection.attemptProgress:2:10');
    expect(container.textContent).not.toContain('connection.startingBanner');
    unmount();
  });

  it('连上过又掉了、但一次都还没重试 ⇒ 不显示计数器（免得读成"零次失败"）', () => {
    useUiStore.getState().setGatewayStatusByGateway(GW, 'connected');
    useUiStore.getState().setGatewayStatusByGateway(GW, 'disconnected');
    useUiStore.getState().setGatewayReconnectInfo(GW, { attempt: 0, max: 10, gaveUp: false });

    const { container, unmount } = mount();
    expect(container.textContent).toContain('connection.reconnectingBanner');
    expect(container.textContent).not.toContain('connection.attemptProgress');
    unmount();
  });

  it('网关明确拒绝（gaveUp，从没连上过）⇒ 收尾态 + "立即重试"真的能重连', () => {
    useUiStore.getState().setGatewayStatusByGateway(GW, 'disconnected');
    useUiStore.getState().setGatewayReconnectInfo(GW, { attempt: 0, max: 10, gaveUp: true });

    const { container, unmount } = mount();
    expect(container.textContent).toContain('connection.unreachableBanner');
    expect(container.textContent).not.toContain('connection.startingBanner');
    const retry = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('connection.retryNow'));
    expect(retry, '失败态必须有出口').toBeTruthy();
    act(() => retry?.click());
    expect(reconnectGateway).toHaveBeenCalledWith(GW);
    unmount();
  });

  it('⭐ 真断开（连上过、掉线后没有任何重连信息）⇒ 也必须有"立即重试"', () => {
    useUiStore.getState().setGatewayStatusByGateway(GW, 'connected');
    useUiStore.getState().setGatewayStatusByGateway(GW, 'disconnected');

    const { container, unmount } = mount();
    expect(container.textContent).toContain('connection.disconnectedBanner');
    const retry = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('connection.retryNow'));
    expect(retry, '只有"打开设置"= 用户没有别的出路').toBeTruthy();
    unmount();
  });

  it('"正在启动"说超了预算（6 分钟）⇒ 改口成失败 + 给出口（不许永远转下去）', () => {
    useUiStore.getState().setGatewayStatusByGateway(GW, 'connecting');

    const { container, unmount } = mount();
    expect(container.textContent).toContain('connection.startingBanner');

    act(() => {
      vi.advanceTimersByTime(STARTUP_GRACE_MS + 1_000);
    });

    expect(container.textContent).toContain('connection.startupFailedBanner');
    expect(container.textContent).not.toContain('connection.startingBanner');
    const retry = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('connection.retryNow'));
    expect(retry).toBeTruthy();
    unmount();
  });

  it('连上了 ⇒ 什么都不显示（不许常驻一块假横幅）', () => {
    useUiStore.getState().setGatewayStatusByGateway(GW, 'connected');

    const { container, unmount } = mount();
    expect(container.textContent).toBe('');
    unmount();
  });
});
