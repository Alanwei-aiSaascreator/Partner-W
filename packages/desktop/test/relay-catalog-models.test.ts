import { describe, expect, it } from 'vitest';
import { buildRelayPatch, relayCatalogModelEntries } from '../src/main/commercial/relay-config.js';

/**
 * 2026-10-12：目录模型 → 内核静态模型条目（思考档位接线）。
 *
 * 背景（真机缺陷）：deep 档 = `thinkingLevel:"max"` 被内核 `sessions.patch` 每发必拒
 * （「不支持「最高」档思考」），因为 clawrouter 的思考档位只认模型条目的
 * `compat.supportedReasoningEfforts`，而 relay 目录的声明从未传导进内核。
 * 修法 = 把目录声明静态写进网关配置的 `models.providers.clawrouter.models[]`。
 */

const INPUT = { relayKey: 'fixture-relay-key', deviceFingerprint: 'fixture-device' };

/** 仿真实 `/v1/catalog`：带声明的 glm-5.3-flash + 无声明的模型 + 未知词 + 重复 id。 */
const CATALOG_FIXTURE = {
  providers: [
    {
      id: 'bailian',
      models: [
        {
          id: 'glm-5.2',
          displayName: 'GLM 5.2',
          supportedReasoningEfforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
          pricing: { maxInputTokens: 204800, defaultMaxOutputTokens: 131072 },
        },
        { id: 'plain-chat', supportedReasoningEfforts: ['turbo-unknown'] },
        { id: 'no-pricing', displayName: '  ' },
      ],
    },
    {
      id: 'cephalon',
      models: [
        {
          id: 'glm-5.3-flash',
          capabilities: ['llm', 'llm.vision'],
          supportedReasoningEfforts: ['low', 'high', 'max'],
          pricing: { maxInputTokens: 1000000, defaultMaxOutputTokens: 131072 },
        },
        // 重复 id（另一 provider 同模型）：只取第一条。
        { id: 'glm-5.3-flash', displayName: 'Dup' },
      ],
    },
  ],
};

describe('relayCatalogModelEntries', () => {
  it('把目录的能力声明映射成内核静态条目（compat + thinkingLevelMap + 窗口）', () => {
    const entries = relayCatalogModelEntries(CATALOG_FIXTURE);
    const flash = entries.find((entry) => entry.id === 'glm-5.3-flash');

    expect(flash).toEqual({
      id: 'glm-5.3-flash',
      name: 'glm-5.3-flash', // displayName 缺省 ⇒ 回 id
      input: ['text', 'image'],
      reasoning: true,
      compat: { supportsReasoningEffort: true, supportedReasoningEfforts: ['low', 'high', 'max'] },
      // 内核 buildThinkingLevelMap 同构：**每个** level 都写键，不支持 = null。
      thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' },
      contextWindow: 1000000,
      maxTokens: 131072,
    });
  });

  it('纯文本和未知声明不能冒充视觉模型（不按名字猜）', () => {
    const entries = relayCatalogModelEntries({
      providers: [
        {
          models: [
            { id: 'looks-like-vision-vl', capabilities: ['llm'] },
            { id: 'unknown', capabilities: ['llm.future'] },
            { id: 'malformed', capabilities: 'llm.vision' },
          ],
        },
      ],
    });
    expect(entries.map((entry) => entry.input)).toEqual([['text'], ['text'], ['text']]);
  });

  it('relay 的 none 词映射为内核的 off 词（词表逐字对齐）', () => {
    const entries = relayCatalogModelEntries(CATALOG_FIXTURE);
    const glm52 = entries.find((entry) => entry.id === 'glm-5.2');

    expect(glm52?.compat?.supportedReasoningEfforts).toEqual([
      'none',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(glm52?.thinkingLevelMap).toEqual({
      off: 'none',
      minimal: 'minimal',
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      max: 'max',
    });
  });

  it('无声明（或全是未知词）⇒ reasoning=false 且不写 compat / thinkingLevelMap', () => {
    const entries = relayCatalogModelEntries(CATALOG_FIXTURE);
    const plain = entries.find((entry) => entry.id === 'plain-chat');

    expect(plain).toEqual({ id: 'plain-chat', name: 'plain-chat', input: ['text'], reasoning: false });
  });

  it('空白 displayName 回 id；无 pricing 不写窗口字段；重复 id 只保留第一条', () => {
    const entries = relayCatalogModelEntries(CATALOG_FIXTURE);

    expect(entries.find((entry) => entry.id === 'no-pricing')).toEqual({
      id: 'no-pricing',
      name: 'no-pricing',
      input: ['text'],
      reasoning: false,
    });
    expect(entries.filter((entry) => entry.id === 'glm-5.3-flash')).toHaveLength(1);
    expect(entries.find((entry) => entry.id === 'glm-5.3-flash')?.name).toBe('glm-5.3-flash');
  });

  it('垃圾输入一律空数组（调用方据此不写 models 键）', () => {
    expect(relayCatalogModelEntries(null)).toEqual([]);
    expect(relayCatalogModelEntries({})).toEqual([]);
    expect(relayCatalogModelEntries({ providers: 'nope' })).toEqual([]);
    expect(relayCatalogModelEntries({ providers: [{ models: [{}] }] })).toEqual([]);
  });
});

describe('buildRelayPatch × catalogModels', () => {
  it('带目录条目 ⇒ provider.models 原样写入（思考档位自此进内核 catalog）', () => {
    const entries = relayCatalogModelEntries(CATALOG_FIXTURE);
    const patch = buildRelayPatch({ ...INPUT, catalogModels: entries });

    expect(patch).toHaveProperty('models.providers.clawrouter.models', entries);
  });

  it('目录失败仅补旧缺input条目为text，保留明确视觉和思考窗口', () => {
    const legacy = {
      id: 'old',
      reasoning: true,
      compat: { supportedReasoningEfforts: ['max'] },
      contextWindow: 100000,
    };
    const vision = { id: 'known', input: ['text', 'image'], reasoning: false };
    const patch = buildRelayPatch({
      ...INPUT,
      catalogModels: null,
      existingConfig: { config: { models: { providers: { clawrouter: { models: [legacy, vision] } } } } },
    });
    expect(patch).toHaveProperty('models.providers.clawrouter.models', [{ ...legacy, input: ['text'] }, vision]);
  });

  it('缺省或失败保留旧快照；可信空目录清除旧静态能力', () => {
    expect(buildRelayPatch(INPUT)).not.toHaveProperty('models.providers.clawrouter.models');
    expect(buildRelayPatch({ ...INPUT, catalogModels: [] })).toHaveProperty('models.providers.clawrouter.models', []);
    expect(buildRelayPatch({ ...INPUT, catalogModels: null })).not.toHaveProperty('models.providers.clawrouter.models');
  });

  it('既有 provider 字段不受新增 models 影响（baseUrl/apiKey/headers 原样）', () => {
    const patch = buildRelayPatch({ ...INPUT, catalogModels: relayCatalogModelEntries(CATALOG_FIXTURE) });
    const provider = (patch as { models: { providers: Record<string, Record<string, unknown>> } }).models.providers
      .clawrouter;

    expect(provider.baseUrl).toEqual(expect.any(String));
    expect(provider.apiKey).toBe('fixture-relay-key');
    expect(provider.headers).toEqual({ 'X-ClawRouter-Project-Id': 'fixture-device' });
  });
});
