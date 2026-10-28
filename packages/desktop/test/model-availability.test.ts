import { describe, expect, it, vi } from 'vitest';
import { deriveModelAvailability, modelStatusCopy } from '../src/renderer/components/ChatInput/model-availability.js';

describe('deriveModelAvailability', () => {
  it('reports service startup before the gateway connects', () => {
    expect(
      deriveModelAvailability({
        gatewayId: 'gw-1',
        gatewayStatus: 'connecting',
        rawCatalog: undefined,
        catalogFailed: false,
        modelCount: 0,
      }),
    ).toBe('service-starting');
  });

  it('reports model preparation while a connected gateway is still fetching its catalog', () => {
    expect(
      deriveModelAvailability({
        gatewayId: 'gw-1',
        gatewayStatus: 'connected',
        rawCatalog: undefined,
        catalogFailed: false,
        modelCount: 0,
      }),
    ).toBe('models-loading');
  });

  it('reports empty only after the catalog has resolved without commercial models', () => {
    expect(
      deriveModelAvailability({
        gatewayId: 'gw-1',
        gatewayStatus: 'connected',
        rawCatalog: [],
        catalogFailed: false,
        modelCount: 0,
      }),
    ).toBe('empty');
  });

  it('reports ready when a commercial model is available', () => {
    expect(
      deriveModelAvailability({
        gatewayId: 'gw-1',
        gatewayStatus: 'connected',
        rawCatalog: [{} as never],
        catalogFailed: false,
        modelCount: 1,
      }),
    ).toBe('ready');
  });

  // ⭐ 2026-09-20（用户报障「一直卡在加载模型」）：`undefined` 原是**二义**的 ——
  //    「还在取」与「取不到」都长这样，而取失败那条路以前根本不进重试，
  //    于是界面**永远**停在「正在准备模型…」。取不到必须有自己的名字。
  it('⭐ 取不到 ⇒ 报显式失败态，不再冒充"正在加载"', () => {
    expect(
      deriveModelAvailability({
        gatewayId: 'gw-1',
        gatewayStatus: 'connected',
        rawCatalog: undefined,
        catalogFailed: true,
        modelCount: 0,
      }),
    ).toBe('catalog-failed');
  });

  it('取不到、但手上还有一份能用的目录 ⇒ 按目录判（能干活就不说失败）', () => {
    expect(
      deriveModelAvailability({
        gatewayId: 'gw-1',
        gatewayStatus: 'connected',
        rawCatalog: [{} as never],
        catalogFailed: true,
        modelCount: 1,
      }),
    ).toBe('ready');
  });

  it('目录是空的**且**取不到 ⇒ 报失败，别把"没问出来"说成"确实没有"', () => {
    expect(
      deriveModelAvailability({
        gatewayId: 'gw-1',
        gatewayStatus: 'connected',
        rawCatalog: [],
        catalogFailed: true,
        modelCount: 0,
      }),
    ).toBe('catalog-failed');
  });
});

describe('modelStatusCopy —— 输入框上那句话（文案分档）', () => {
  // 用户的报障原文是「一直卡在加载模型」。所以「无需重复操作」这句**只在真加载时**允许出现：
  // 取不到却还在说"无需重复操作"，等于让用户**永远**等下去。
  const t = (key: string) => key;

  it('正在加载：给"准备完成后会自动显示，无需重复操作"', () => {
    const copy = modelStatusCopy('models-loading', t);

    expect(copy?.label).toBe('chatInput.modelsLoading');
    expect(copy?.detail).toBe('chatInput.modelsLoadingDetail');
    expect(copy?.preparing).toBe(true);
  });

  it('⭐ 取不到：文案说的是"没能取到" + 会自己再取，**不是**"无需重复操作"', () => {
    const copy = modelStatusCopy('catalog-failed', t);

    expect(copy?.label).toBe('chatInput.modelsUnavailable');
    expect(copy?.detail).toBe('chatInput.modelsUnavailableDetail');
    expect(copy?.detail).not.toBe('chatInput.modelsLoadingDetail');
    // 取不到不是"正在准备"：不能转圈（转圈就是在暗示"再等等"）。
    expect(copy?.preparing).toBe(false);
  });

  it('服务还没起来 / 确实没有模型：各有各的话，都不转圈陪着等', () => {
    expect(modelStatusCopy('service-starting', t)?.detail).toBe('chatInput.aiServiceStartingDetail');
    expect(modelStatusCopy('service-starting', t)?.preparing).toBe(true);
    expect(modelStatusCopy('empty', t)?.label).toBe('chatInput.noModelsAvailable');
    expect(modelStatusCopy('empty', t)?.detail).toBe('chatInput.noModelsAvailableDetail');
    expect(modelStatusCopy('empty', t)?.preparing).toBe(false);
  });

  it('ready 不给状态文案（模型名归下拉自己显示）', () => {
    expect(modelStatusCopy('ready', t)).toBeNull();
  });

  it('只有"正在准备"那两档允许出现转圈', () => {
    const spinning = (['service-starting', 'models-loading', 'catalog-failed', 'empty', 'ready'] as const).filter(
      (availability) => modelStatusCopy(availability, t)?.preparing,
    );

    expect(spinning).toEqual(['service-starting', 'models-loading']);
  });

  it('问的都是 chatInput 命名空间里的字面 key（不许拼 key）', () => {
    const spy = vi.fn((key: string) => key);

    modelStatusCopy('catalog-failed', spy);

    expect(spy.mock.calls.length).toBeGreaterThan(0);
    for (const [key] of spy.mock.calls) expect(key).toMatch(/^chatInput\.[a-zA-Z]+$/);
  });
});
