import { describe, expect, it, vi } from 'vitest';
import type { ModelCatalogEntry } from '@clawwork/shared';
import { createUiStore } from '../src/stores/ui-store.js';

/**
 * 背景（2026-09-20，用户报障「用着用着一直卡在加载模型」）：
 * `modelCatalogByGateway[gw]` **缺席**（`undefined`）原来是二义的 ——
 * 「还在取」与「取不到」长得一模一样，界面于是**永远**显示「正在准备模型…」。
 * 这里给「取不到」一个**独立标记**：缺席 = 没失败，`true` = 退避用尽仍取不到。
 */
function setup() {
  const store = createUiStore({
    updateSettings: vi.fn(),
    changeLanguage: vi.fn(),
    storage: { get: () => null, set: vi.fn() },
    getViewportWidth: () => 1266,
  });

  return store;
}

const models = [{ id: 'deepseek-v4-flash', provider: 'clawrouter' }] as ModelCatalogEntry[];

describe('ui store —— 模型目录「取不到」的标记', () => {
  it('没标记过 = 没失败（缺席即未失败，不是"未知"）', () => {
    const store = setup();

    expect(store.getState().modelCatalogFailureByGateway['gw-1']).toBeUndefined();
  });

  it('能标记失败，也能取消标记', () => {
    const store = setup();

    store.getState().setModelCatalogFailureForGateway('gw-1', true);
    expect(store.getState().modelCatalogFailureByGateway['gw-1']).toBe(true);

    store.getState().setModelCatalogFailureForGateway('gw-1', false);
    expect(store.getState().modelCatalogFailureByGateway['gw-1']).toBeUndefined();
  });

  it('⭐ 落目录会把失败标记作废（空目录是**已解决**的结论，不是失败）', () => {
    const store = setup();
    store.getState().setModelCatalogFailureForGateway('gw-1', true);
    expect(store.getState().modelCatalogFailureByGateway['gw-1'], '先得真的标记上').toBe(true);

    store.getState().setModelCatalogForGateway('gw-1', []);

    expect(store.getState().modelCatalogFailureByGateway['gw-1']).toBeUndefined();
    expect(store.getState().modelCatalogByGateway['gw-1']).toEqual([]);
  });

  it('标记没变化时**不换对象**（否则每次重连都会整屏重渲染一次）', () => {
    const store = setup();
    store.getState().setModelCatalogFailureForGateway('gw-1', true);
    const before = store.getState().modelCatalogFailureByGateway;
    expect(before['gw-1'], '先得真的标记上').toBe(true);

    store.getState().setModelCatalogFailureForGateway('gw-1', true);

    expect(store.getState().modelCatalogFailureByGateway).toBe(before);
  });

  it('只动被标记的那个网关（别的网关的目录与标记都不受牵连）', () => {
    const store = setup();
    store.getState().setModelCatalogForGateway('gw-1', models);

    store.getState().setModelCatalogFailureForGateway('gw-2', true);

    expect(store.getState().modelCatalogFailureByGateway['gw-1']).toBeUndefined();
    expect(store.getState().modelCatalogByGateway['gw-1']).toEqual(models);
    expect(store.getState().modelCatalogFailureByGateway['gw-2']).toBe(true);
  });
});

describe('ui store session-scoped effective tools', () => {
  it('keeps inventories isolated by gateway and session', () => {
    const store = setup();
    const setState = store.getState() as unknown as {
      setEffectiveToolsState: (
        gatewayId: string,
        sessionKey: string,
        state: { status: 'loading' } | { status: 'error'; error: string },
      ) => void;
      effectiveToolsByGateway: Record<string, Record<string, unknown>>;
    };

    expect(typeof setState.setEffectiveToolsState).toBe('function');
    setState.setEffectiveToolsState('gw-1', 'session-a', { status: 'loading' });
    setState.setEffectiveToolsState('gw-1', 'session-b', { status: 'error', error: 'denied' });
    setState.setEffectiveToolsState('gw-2', 'session-a', { status: 'error', error: 'offline' });

    const actual = (
      store.getState() as unknown as {
        effectiveToolsByGateway: Record<string, Record<string, unknown>>;
      }
    ).effectiveToolsByGateway;
    expect(actual).toEqual({
      'gw-1': {
        'session-a': { status: 'loading' },
        'session-b': { status: 'error', error: 'denied' },
      },
      'gw-2': {
        'session-a': { status: 'error', error: 'offline' },
      },
    });
  });
});
