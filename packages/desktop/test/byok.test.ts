import { describe, expect, it, vi } from 'vitest';
import {
  applyByokConfig,
  buildByokPatch,
  byokModelRef,
  removeByokConfig,
  BYOK_PROVIDER_ID,
} from '../src/main/models/byok.js';
import type { ByokEndpointConfig, ModelApiConfig } from '../src/main/workspace/config.js';

/**
 * BYOK 模型服务接入的单元测试（私有化 / 开源版核心）。
 *
 * 只测「构建 patch / 写入 / 移除」的纯逻辑，`deps`（getConfig / patchConfig）
 * 用 mock，不碰真实网关、不碰 electron。
 *
 * 2026-10-28 升级：配置从「单端点」变成「多端点数组」，每个端点一个 provider。
 */

function ep(overrides: Partial<ByokEndpointConfig> = {}): ByokEndpointConfig {
  return {
    id: 'byok',
    name: 'Default',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-test',
    modelIds: ['gpt-4o', 'gpt-4o-mini'],
    ...overrides,
  };
}

function cfg(endpoints: ByokEndpointConfig[]): ModelApiConfig {
  return { endpoints };
}

const validConfig = cfg([ep()]);

/* eslint-disable @typescript-eslint/no-explicit-any -- 测试桩：provider 形状故意宽松，方便按属性断言 */
function providersOf(patch: Record<string, unknown>): Record<string, any> {
  return (patch.models as { providers: Record<string, unknown> }).providers as Record<string, any>;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

describe('buildByokPatch', () => {
  it('有效配置 ⇒ 写 byok provider（baseUrl + apiKey + 静态模型条目）', () => {
    const patch = buildByokPatch(validConfig) as Record<string, unknown>;
    const byok = providersOf(patch)[BYOK_PROVIDER_ID];

    expect(byok.baseUrl).toBe('https://api.openai.com/v1');
    expect(byok.apiKey).toBe('sk-test');
    // 每个模型声明单一推理档（缺省 high）：reasoning + compat.supportedReasoningEfforts + 全词表 thinkingLevelMap。
    const highEntry = {
      reasoning: true,
      input: ['text'],
      compat: { supportsReasoningEffort: true, supportedReasoningEfforts: ['high'] },
      thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: 'high', xhigh: null, max: null },
    };
    expect(byok.models).toEqual([
      { id: 'gpt-4o', name: 'gpt-4o', ...highEntry },
      { id: 'gpt-4o-mini', name: 'gpt-4o-mini', ...highEntry },
    ]);
  });

  it('每个模型按 modelLevels 声明对应功率档，非法值回落 high', () => {
    const patch = buildByokPatch(cfg([ep({ modelLevels: { 'gpt-4o': 'low', 'gpt-4o-mini': 'bogus' } })])) as Record<
      string,
      unknown
    >;
    const models = providersOf(patch)[BYOK_PROVIDER_ID].models as Array<Record<string, unknown>>;

    expect((models[0].compat as { supportedReasoningEfforts: string[] }).supportedReasoningEfforts).toEqual(['low']);
    expect((models[0].thinkingLevelMap as Record<string, string | null>).low).toBe('low');
    expect((models[0].thinkingLevelMap as Record<string, string | null>).high).toBeNull();
    // 非法档位 → 回落默认 high。
    expect((models[1].compat as { supportedReasoningEfforts: string[] }).supportedReasoningEfforts).toEqual(['high']);
  });

  it('多端点：每个端点一个 provider（byok / byok-<id>）', () => {
    const patch = buildByokPatch(
      cfg([
        ep({ id: 'byok' }),
        ep({ id: 'byok-company', name: 'Company', baseUrl: 'https://relay.example.com/v1', modelIds: ['claude-x'] }),
      ]),
    ) as Record<string, unknown>;
    const providers = providersOf(patch);

    expect(Object.keys(providers).sort()).toEqual(['byok', 'byok-company']);
    expect(providers['byok'].baseUrl).toBe('https://api.openai.com/v1');
    expect(providers['byok-company'].baseUrl).toBe('https://relay.example.com/v1');
    expect((providers['byok-company'].models as Array<Record<string, unknown>>).map((m) => m.id)).toEqual(['claude-x']);
  });

  it('端点 id 非字母数字 ⇒ 清洗成安全 provider id', () => {
    const patch = buildByokPatch(cfg([ep({ id: 'byok 中 文!@#' })])) as Record<string, unknown>;
    expect(providersOf(patch)['byok'].baseUrl).toBe('https://api.openai.com/v1');
  });

  it('默认模型未设置时，指向 byok/<第一个模型>', () => {
    const patch = buildByokPatch(validConfig) as Record<string, unknown>;
    expect((patch.agents as { defaults: { model: { primary: string } } }).defaults.model.primary).toBe(
      byokModelRef(BYOK_PROVIDER_ID, 'gpt-4o'),
    );
  });

  it('默认模型已设置时，不覆盖', () => {
    const existing = { config: { agents: { defaults: { model: { primary: 'clawrouter/glm-5.3' } } } } };
    const patch = buildByokPatch(validConfig, existing) as Record<string, unknown>;
    expect(patch.agents).toBeUndefined();
  });

  it('baseUrl 去尾斜杠', () => {
    const patch = buildByokPatch(cfg([ep({ baseUrl: 'https://api.openai.com/v1///' })])) as Record<string, unknown>;
    expect(providersOf(patch)[BYOK_PROVIDER_ID].baseUrl).toBe('https://api.openai.com/v1');
  });

  it('无效输入（缺 key / 缺 url / 无模型）⇒ null', () => {
    expect(buildByokPatch(cfg([ep({ apiKey: '' })]))).toBeNull();
    expect(buildByokPatch(cfg([ep({ baseUrl: '   ' })]))).toBeNull();
    expect(buildByokPatch(cfg([ep({ modelIds: [] })]))).toBeNull();
  });
});

describe('applyByokConfig', () => {
  it('成功：写一次 + 回读验证通过', async () => {
    const patchConfig = vi.fn().mockResolvedValue({ ok: true });
    const getConfig = vi
      .fn()
      .mockResolvedValueOnce({ hash: 'h1', config: {} })
      .mockResolvedValueOnce({ hash: 'h2', config: { models: { providers: { [BYOK_PROVIDER_ID]: {} } } } });

    const result = await applyByokConfig({ getConfig, patchConfig }, validConfig);

    expect(result.ok).toBe(true);
    expect(patchConfig).toHaveBeenCalledTimes(1);
    expect(getConfig).toHaveBeenCalledTimes(2);
  });

  it('hash 冲突 ⇒ 重试后成功', async () => {
    const patchConfig = vi
      .fn()
      .mockRejectedValueOnce(new Error('config changed since last load, re-run config.get and retry'))
      .mockResolvedValueOnce({ ok: true });
    const getConfig = vi
      .fn()
      .mockResolvedValueOnce({ hash: 'h1', config: {} })
      .mockResolvedValueOnce({ hash: 'h2', config: {} })
      .mockResolvedValueOnce({ hash: 'h3', config: { models: { providers: { [BYOK_PROVIDER_ID]: {} } } } });

    const result = await applyByokConfig({ getConfig, patchConfig }, validConfig);

    expect(result.ok).toBe(true);
    expect(patchConfig).toHaveBeenCalledTimes(2);
  });

  it('回读里没有 byok provider ⇒ verify-failed', async () => {
    const patchConfig = vi.fn().mockResolvedValue({ ok: true });
    const getConfig = vi
      .fn()
      .mockResolvedValueOnce({ hash: 'h1', config: {} })
      .mockResolvedValueOnce({ hash: 'h2', config: { models: { providers: {} } } });

    const result = await applyByokConfig({ getConfig, patchConfig }, validConfig);

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('verify-failed');
  });
});

describe('removeByokConfig', () => {
  it('没有 byok provider ⇒ 直接成功、不写', async () => {
    const getConfig = vi.fn().mockResolvedValue({ hash: 'h1', config: { models: { providers: {} } } });
    const patchConfig = vi.fn();

    const result = await removeByokConfig({ getConfig, patchConfig });

    expect(result.ok).toBe(true);
    expect(patchConfig).not.toHaveBeenCalled();
  });

  it('有 byok ⇒ 移除 provider + 清掉指向 byok 的默认模型', async () => {
    const getConfig = vi.fn().mockResolvedValue({
      hash: 'h1',
      config: {
        models: { providers: { [BYOK_PROVIDER_ID]: { models: [{ id: 'gpt-4o' }] } } },
        agents: { defaults: { model: { primary: 'byok/gpt-4o' } } },
      },
    });
    const patchConfig = vi.fn().mockResolvedValue({ ok: true });

    const result = await removeByokConfig({ getConfig, patchConfig });

    expect(result.ok).toBe(true);
    const call = patchConfig.mock.calls[0][0] as { raw: string; replacePaths?: string[] };
    expect(call.replacePaths).toContain(`models.providers.${BYOK_PROVIDER_ID}.models`);
    expect(JSON.parse(call.raw).agents.defaults.model.primary).toBeNull();
    expect(JSON.parse(call.raw).models.providers[BYOK_PROVIDER_ID]).toBeNull();
  });

  it('移除所有 byok-<id> 端点 provider', async () => {
    const getConfig = vi.fn().mockResolvedValue({
      hash: 'h1',
      config: {
        models: {
          providers: { byok: { models: [{ id: 'm1' }] }, 'byok-company': { models: [{ id: 'm2' }] }, clawrouter: {} },
        },
      },
    });
    const patchConfig = vi.fn().mockResolvedValue({ ok: true });

    const result = await removeByokConfig({ getConfig, patchConfig });

    expect(result.ok).toBe(true);
    const call = patchConfig.mock.calls[0][0] as { raw: string };
    const providers = JSON.parse(call.raw).models.providers;
    expect(providers.byok).toBeNull();
    expect(providers['byok-company']).toBeNull();
    expect(providers.clawrouter).toBeUndefined();
  });
});
