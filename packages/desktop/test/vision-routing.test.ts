import { describe, expect, it } from 'vitest';
import type { ModelCatalogEntry } from '@clawwork/shared';
import {
  VISION_FALLBACK_PREFERRED_ORDER,
  WEB_ROUTING_FACTS,
  planVisionRouting,
  selectVisionFallbackModel,
  visionCatalogWithConfiguredInputs,
} from '../src/renderer/lib/vision-routing';
import { buildRelayPatch } from '../src/main/commercial/relay-config.js';

/**
 * Auto Capability Routing v1：带图发送时换到"能看图的模型"的**候选选择**（纯函数）。
 *
 * 这里钉判据本身；接线（先切后发 + 切了才提示）由 use-chat-send.test.tsx 的用例守。
 * ⚠️ 判错方向的代价不对称：选错模型 = 图片继续被静默丢弃（用户白发一轮）；
 *    无候选时"随便选一个" = 换个大概率也读不到图的模型，同样是假动作 —— 所以找不到必须返回 null。
 */
const entry = (id: string, provider: string | undefined, input: unknown): ModelCatalogEntry =>
  ({ id, provider, input }) as unknown as ModelCatalogEntry;

const RELAY = 'clawrouter';

describe('visionCatalogWithConfiguredInputs', () => {
  it('带provider前缀的静态模型也必须覆盖动态视觉声明，缺input按text', () => {
    const catalog = [entry('glm-5.3-flash', RELAY, ['text', 'image'])];
    expect(
      visionCatalogWithConfiguredInputs(catalog, {
        config: { models: { providers: { clawrouter: { models: [{ id: 'clawrouter/glm-5.3-flash' }] } } } },
      })?.[0]?.input,
    ).toEqual(['text']);
  });
  it('配置provider缺失或列表形状无效时能力不可确认', () => {
    expect(visionCatalogWithConfiguredInputs([], { config: {} })).toBeNull();
    expect(
      visionCatalogWithConfiguredInputs([], {
        config: { models: { providers: { clawrouter: { models: 'invalid' } } } },
      }),
    ).toBeNull();
  });
});

describe('selectVisionFallbackModel', () => {
  it('默认偏好顺序 = [qwen3.7-flash, qwen3.5-27b]（官方页核证过的两个，顺序即优先级）', () => {
    expect(VISION_FALLBACK_PREFERRED_ORDER).toEqual(['qwen3.7-flash', 'qwen3.5-27b']);
  });

  it('两个候选都在时选偏好序第一（与目录顺序无关）', () => {
    const catalog = [
      entry('qwen3.5-27b', RELAY, ['text', 'image']),
      entry('deepseek-v4-flash', RELAY, ['text']),
      entry('qwen3.7-flash', RELAY, ['text', 'image']),
    ];
    expect(selectVisionFallbackModel(catalog)?.id).toBe('qwen3.7-flash');
  });

  it('传了自定义 preferredOrder 就按它排（可把 27b 排前）', () => {
    const catalog = [entry('qwen3.7-flash', RELAY, ['text', 'image']), entry('qwen3.5-27b', RELAY, ['text', 'image'])];
    expect(selectVisionFallbackModel(catalog, ['qwen3.5-27b'])?.id).toBe('qwen3.5-27b');
  });

  it('非 clawrouter 的条目一律不选（哪怕声明了 image）—— 选了也发不出去', () => {
    const catalog = [
      entry('gpt-5-vision', 'openai', ['text', 'image']),
      entry('claude-opus-5', 'claude-cli', ['text', 'image']),
      entry('mystery', undefined, ['text', 'image']),
    ];
    expect(selectVisionFallbackModel(catalog)).toBeNull();
  });

  it('只要 input 没声明 image 就不算候选（含形状不对的）', () => {
    const catalog = [
      entry('a', RELAY, ['text']),
      entry('b', RELAY, 'text'),
      entry('c', RELAY, undefined),
      entry('d', RELAY, []),
      entry('e', RELAY, [1, 2]),
      entry('qwen3.7-flash', RELAY, ['text']),
    ];
    expect(selectVisionFallbackModel(catalog)).toBeNull();
  });

  it('偏好命中的模型没声明 image 时跳过它，继续找下一个能看的', () => {
    const catalog = [
      entry('qwen3.7-flash', RELAY, ['text']), // 名字在偏好序里，但自己没报名看图
      entry('qwen3.5-27b', RELAY, ['text', 'image']),
    ];
    expect(selectVisionFallbackModel(catalog)?.id).toBe('qwen3.5-27b');
  });

  it('偏好序都没命中时，退而取任意声明了 image 的中转条目（目录顺序即取舍顺序）', () => {
    const catalog = [
      entry('kimi-k3', RELAY, ['text']),
      entry('glm-4.7', RELAY, ['text', 'image']),
      entry('doubao-x', RELAY, ['text', 'image']),
    ];
    expect(selectVisionFallbackModel(catalog)?.id).toBe('glm-4.7');
  });

  it('没有候选返回 null（空目录 / 全都不看图）', () => {
    expect(selectVisionFallbackModel([])).toBeNull();
    expect(
      selectVisionFallbackModel([entry('deepseek-v4-flash', RELAY, ['text']), entry('glm-4.7', RELAY, ['text'])]),
    ).toBeNull();
  });

  it('返回整条 entry（接线要用 name 拼提示文案，缺 name 才回落 id）', () => {
    const vision: ModelCatalogEntry = {
      id: 'qwen3.7-flash',
      name: 'Qwen 3.7 Flash',
      provider: RELAY,
      input: ['text', 'image'],
    };
    expect(selectVisionFallbackModel([vision])).toBe(vision);
  });
});

/**
 * v1.1 加固：发送这一刻的**路由计划**（纯函数）。
 *
 * 与 `selectVisionFallbackModel` 的分工：那个只回答"谁是候选"，这个回答
 * "这一轮到底做哪件事" —— 切模型 / 什么都不做 / 还是没有候选（**不许静默**）。
 * 判错方向的代价不对称：
 *   · 该切不切 ⇒ 图片被静默丢弃（v1 已修）；
 *   · 没候选还装没事 ⇒ 用户发完对着模型的困惑自查（v1.1 修的就是这条）。
 */
describe('planVisionRouting（发送路径的路由计划）', () => {
  const visionEntry = entry('qwen3.7-flash', RELAY, ['text', 'image']);
  const textEntry = entry('deepseek-v4-flash', RELAY, ['text']);
  const catalog = [textEntry, visionEntry];

  it('没带图 ⇒ skip（不切模型、不提示）', () => {
    expect(
      planVisionRouting({
        hasImageAttachment: false,
        imageInputSupport: 'unsupported',
        currentModelId: 'deepseek-v4-flash',
        catalog,
      }),
    ).toEqual({ kind: 'skip' });
  });

  it('当前模型自述能看图 ⇒ skip（原样发，别动用户选的模型）', () => {
    expect(
      planVisionRouting({
        hasImageAttachment: true,
        imageInputSupport: 'supported',
        currentModelId: 'qwen3.7-flash',
        catalog,
      }),
    ).toEqual({ kind: 'skip' });
  });

  it('带图 × 不自述看图 × 有候选 ⇒ switch（目标是候选条目本身）', () => {
    expect(
      planVisionRouting({
        hasImageAttachment: true,
        imageInputSupport: 'unsupported',
        currentModelId: 'deepseek-v4-flash',
        catalog,
      }),
    ).toEqual({ kind: 'switch', model: visionEntry });
  });

  it('用户显式选择的非视觉模型不可自动切换', () => {
    expect(
      planVisionRouting({
        hasImageAttachment: true,
        imageInputSupport: 'unsupported',
        currentModelId: textEntry.id,
        catalog,
        allowFallback: false,
      }),
    ).toEqual({ kind: 'unavailable' });
  });

  it('unknown（目录没声明）与 unsupported 同一条路 —— 没声明 ≠ 不支持', () => {
    expect(
      planVisionRouting({
        hasImageAttachment: true,
        imageInputSupport: 'unknown',
        currentModelId: 'deepseek-v4-flash',
        catalog,
      }),
    ).toEqual({ kind: 'switch', model: visionEntry });
  });

  it('同id目录声明冲突时不可跳过视觉门禁', () => {
    expect(
      planVisionRouting({
        hasImageAttachment: true,
        imageInputSupport: 'unsupported',
        currentModelId: 'qwen3.7-flash',
        catalog: [entry('qwen3.7-flash', RELAY, ['text']), visionEntry],
      }),
    ).toEqual({ kind: 'unavailable' });
  });

  it('一个能看图的候选都没有 ⇒ unavailable（调用方必须给诚实文案，不许静默照发）', () => {
    expect(
      planVisionRouting({
        hasImageAttachment: true,
        imageInputSupport: 'unsupported',
        currentModelId: 'deepseek-v4-flash',
        catalog: [textEntry, entry('glm-4.7', RELAY, ['text'])],
      }),
    ).toEqual({ kind: 'unavailable' });
    // 空目录（目录还没拉回来）同样归 unavailable —— 用户至少知道这一轮图片识别不了
    expect(
      planVisionRouting({
        hasImageAttachment: true,
        imageInputSupport: 'unknown',
        currentModelId: 'deepseek-v4-flash',
        catalog: [],
      }),
    ).toEqual({ kind: 'unavailable' });
  });
});

/**
 * 搜索 / 打开网址的**路由事实**（注释化常量，供 Registry 与提示词引用；本身不改行为）。
 *
 * 这两条事实各有唯一真源，测试把它们**钉在一起**：常量被改歪（或真源变了没跟）
 * 就红，防止"文档写着 A、产品做着 B"。
 */
describe('WEB_ROUTING_FACTS（搜索 / 打开网址的事实）', () => {
  it('搜索 = 百炼内置 enable_search，只有这三个模型能开（与主进程注入表同源）', () => {
    expect(WEB_ROUTING_FACTS.search.modelIds).toEqual(['qwen-turbo', 'qwen-plus', 'qwen3.7-flash']);

    // 同源核验：主进程真正写进网关的那张表逐条对得上（`relay-config.ts` 是唯一真源）。
    const patch = buildRelayPatch({ relayKey: 'rly_probe', deviceFingerprint: 'fp' });
    const models = (patch as never as { agents: { defaults: { models: Record<string, unknown> } } }).agents.defaults
      .models;
    expect(Object.keys(models).sort()).toEqual(
      WEB_ROUTING_FACTS.search.modelIds.map((id) => `clawrouter/${id}`).sort(),
    );
  });

  it('打开网址读内容 = 运行时工具 browser（与 web_search / web_fetch 不是一回事）', () => {
    expect(WEB_ROUTING_FACTS.urlRead.toolId).toBe('browser');
  });
});
