// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 网关从本机消失时给一条说明（2026-09-25）。
 *
 * 现状（`useGatewaySelector` 的回落 effect）：**静默**把 `selectedGwId` 换成另一个网关。
 * 用户上一秒还在跟 A 盘的助手说话，下一秒界面已经在 B 盘上了，**没有任何提示**。
 * 代码里那条注释自己也指到了这件事（"那是'网关没了'这个更上层的事件的通知缺口"）。
 *
 * 已拍的边界：**维持既有行为**（照旧自动切），只**加一条说明**；
 * 判据按 `gatewayInfoMap` 的**成员变化**，**不挂 `requestDeferred`**
 * —— 否则正常换网关也会弹，而且可能闪。
 */

const mocks = vi.hoisted(() => ({ warning: vi.fn(), error: vi.fn(), success: vi.fn(), plain: vi.fn() }));

vi.mock('@/lib/toast', () => ({
  toast: Object.assign(mocks.plain, { warning: mocks.warning, error: mocks.error, success: mocks.success }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${Object.values(options).join('|')}` : key,
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

import { disappearedGateways, useGatewayDisappearanceNotice } from '../src/renderer/lib/gateway-disappearance';
import { useUiStore } from '../src/renderer/stores/uiStore';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Probe(): ReactElement | null {
  useGatewayDisappearanceNotice();
  return null;
}

function render(ui: ReactElement): { unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => root.render(ui));
  return {
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

/** store 里只放网关信息（别的一律按缺省）。 */
function setGateways(map: Record<string, { id: string; name?: string }>): void {
  useUiStore.setState({ gatewayInfoMap: map as never });
}

describe('disappearedGateways —— 判据（纯函数）', () => {
  it('⭐ 第一次观测（还没有上一份）⇒ 什么都不算消失 —— 启动时不报', () => {
    expect(disappearedGateways(null, { a: { name: '甲盘' } })).toEqual([]);
  });

  it('⭐ 少了一个 ⇒ 报出来，名字取**消失前**那一份（消失后就读不到了）', () => {
    const gone = disappearedGateways({ a: { name: '甲盘' }, b: { name: '乙盘' } }, { b: { name: '乙盘' } });
    expect(gone).toEqual([{ id: 'a', name: '甲盘' }]);
  });

  it('名字缺失 ⇒ 用 id 兜底（不许显示空白）', () => {
    expect(disappearedGateways({ a: {} }, { b: { name: '乙盘' } })).toEqual([{ id: 'a', name: 'a' }]);
  });

  it('只增不减 ⇒ 空（新插一块盘不是"消失"）', () => {
    expect(disappearedGateways({ a: { name: '甲盘' } }, { a: { name: '甲盘' }, b: { name: '乙盘' } })).toEqual([]);
  });

  it('同一次少了两个 ⇒ 两个都报（不吞）', () => {
    const gone = disappearedGateways(
      { a: { name: '甲' }, b: { name: '乙' }, c: { name: '丙' } },
      { c: { name: '丙' } },
    );
    expect(gone.map((g) => g.id)).toEqual(['a', 'b']);
  });

  it('⭐ 全没了 ⇒ **不报**（那是另一条路：`ConnectionBanner` 的「一个网关都没有」横条）', () => {
    expect(disappearedGateways({ a: { name: '甲盘' } }, {})).toEqual([]);
  });

  it('一直空着 ⇒ 空（不会因为"上一次也是空"就报）', () => {
    expect(disappearedGateways({}, {})).toEqual([]);
  });

  it('⭐ 空地图 → 有网关（**启动的真实顺序**）⇒ 空：新出现不是"消失"', () => {
    expect(disappearedGateways({}, { a: { name: '甲盘' } })).toEqual([]);
  });
});

describe('useGatewayDisappearanceNotice —— 说给用户', () => {
  beforeEach(() => {
    mocks.warning.mockReset();
    setGateways({ a: { id: 'a', name: '甲盘' } });
  });

  it('⭐ 首次挂载不报（那只是"刚看到地图"）', () => {
    const { unmount } = render(<Probe />);
    expect(mocks.warning).not.toHaveBeenCalled();
    unmount();
  });

  it('⭐ 某一刻网关消失 ⇒ 弹一条警告，文案里带它的名字', () => {
    const { unmount } = render(<Probe />);
    act(() => setGateways({ b: { id: 'b', name: '乙盘' } }));

    expect(mocks.warning).toHaveBeenCalledTimes(1);
    expect(String(mocks.warning.mock.calls[0]?.[0])).toContain('connection.gatewayDisappeared');
    expect(String(mocks.warning.mock.calls[0]?.[0])).toContain('甲盘');
    unmount();
  });

  it('⭐ 同一个网关只报一次（别的 store 更新不该反复弹）', () => {
    const { unmount } = render(<Probe />);
    act(() => setGateways({ b: { id: 'b', name: '乙盘' } }));
    act(() => useUiStore.setState({ defaultGatewayId: 'b' }));
    act(() => useUiStore.setState({ defaultGatewayId: 'b' }));

    expect(mocks.warning).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('新增网关不报（正常插盘不该被打扰）', () => {
    const { unmount } = render(<Probe />);
    act(() => setGateways({ a: { id: 'a', name: '甲盘' }, b: { id: 'b', name: '乙盘' } }));
    expect(mocks.warning).not.toHaveBeenCalled();
    unmount();
  });
});
