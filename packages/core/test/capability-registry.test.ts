import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_VERIFICATION_LEDGER,
  PLANNER_UNAVAILABLE_TOOL_IDS,
  buildCapabilityRegistry,
  findCapabilityEntry,
  plannerDeniedToolIds,
} from '../src/capability/capability-registry.js';

/**
 * Production Capability Registry（BUG-043）—— 可用性三态 + 验证账本。
 *
 * 硬规则（本文件就是它的执行者）：
 *   · `available` **只能**来自 `CAPABILITY_VERIFICATION_LEDGER` 里的实测记录；
 *   · 目录声明了但没实测 ⇒ `unverified`（不许填空头支票，也不许说成"可用"）；
 *   · 目录没声明 ⇒ `unavailable`；
 *   · `unavailable` 的工具必须进 deny（不暴露给模型）—— 判据 = `plannerDeniedToolIds()`。
 */
const MODELS = [
  { id: 'qwen3.7-flash', provider: 'clawrouter', input: ['text', 'image'] },
  { id: 'qwen3.5-27b', provider: 'clawrouter', input: ['text', 'image'] },
  { id: 'deepseek-v4-flash', provider: 'clawrouter', input: ['text'] },
  { id: 'qwen-turbo', provider: 'clawrouter', input: ['text'] },
];

describe('验证账本（种子）', () => {
  it('qwen3.7-flash 的视觉与联网搜索都是带证据的 available（2026-10-08 探针实测）', () => {
    const vision = findCapabilityEntry(buildCapabilityRegistry({ models: MODELS }), {
      kind: 'model',
      id: 'qwen3.7-flash',
      capability: 'vision',
    });
    expect(vision?.availability).toBe('available');
    expect(vision?.evidence?.verifiedAt).toBe('2026-10-08');
    expect(vision?.evidence?.verifiedCase).toContain('探针 B');

    const search = findCapabilityEntry(buildCapabilityRegistry({ models: MODELS }), {
      kind: 'model',
      id: 'qwen3.7-flash',
      capability: 'search',
    });
    expect(search?.availability).toBe('available');
    expect(search?.evidence?.verifiedCase).toContain('5974');
  });

  it('browser（读网页）是 available 且带证据；没有证据的条目进不了 available', () => {
    const registry = buildCapabilityRegistry();
    const browser = findCapabilityEntry(registry, { kind: 'tool', id: 'browser', capability: 'web-read' });
    expect(browser?.availability).toBe('available');
    expect(browser?.evidence?.verifiedCase.length).toBeGreaterThan(0);
    // 账本里每一条 available 都必须带证据 —— 不许有空头支票。
    const unbacked = CAPABILITY_VERIFICATION_LEDGER.filter(
      (record) => record.availability === 'available' && !record.evidence,
    );
    expect(unbacked).toEqual([]);
  });
});

describe('可用性三态', () => {
  it('声明了视觉、但没有实测记录的模型 = unverified（不是 available）', () => {
    const entry = findCapabilityEntry(buildCapabilityRegistry({ models: MODELS }), {
      kind: 'model',
      id: 'qwen3.5-27b',
      capability: 'vision',
    });
    expect(entry?.availability).toBe('unverified');
    expect(entry?.evidence).toBeUndefined();
  });

  it('目录没有视觉声明的模型 = unavailable（其余模型视觉不可用）', () => {
    const entry = findCapabilityEntry(buildCapabilityRegistry({ models: MODELS }), {
      kind: 'model',
      id: 'deepseek-v4-flash',
      capability: 'vision',
    });
    expect(entry?.availability).toBe('unavailable');
    expect(entry?.reason).toBeTruthy();
  });

  it('目录里存在、但没有实测记录的模型，对话能力也只能是 unverified', () => {
    const registry = buildCapabilityRegistry({ models: MODELS });
    expect(
      findCapabilityEntry(registry, { kind: 'model', id: 'qwen3.7-flash', capability: 'chat' })?.availability,
    ).toBe('available');
    expect(
      findCapabilityEntry(registry, { kind: 'model', id: 'deepseek-v4-flash', capability: 'chat' })?.availability,
    ).toBe('available');
    expect(findCapabilityEntry(registry, { kind: 'model', id: 'qwen-turbo', capability: 'chat' })?.availability).toBe(
      'unverified',
    );
  });

  it('联网搜索按 relay 白名单三态：白名单外 = unavailable，白名单内无实测 = unverified', () => {
    const registry = buildCapabilityRegistry({ models: MODELS });
    expect(findCapabilityEntry(registry, { kind: 'model', id: 'qwen-turbo', capability: 'search' })?.availability).toBe(
      'unverified',
    );
    expect(
      findCapabilityEntry(registry, { kind: 'model', id: 'deepseek-v4-flash', capability: 'search' })?.availability,
    ).toBe('unavailable');
  });
});

describe('工具清单输入（tools.catalog / tools.effective 的形状）', () => {
  it('清单里的工具：账本有记录按账本，没有记录的只能 unverified（不许凭"在清单里"说可用）', () => {
    const registry = buildCapabilityRegistry({ toolIds: ['browser', 'read_file', 'image_generate'] });
    // 账本记录优先（browser = 实测可用；image_generate = 明确不可用）
    expect(findCapabilityEntry(registry, { kind: 'tool', id: 'browser', capability: 'web-read' })?.availability).toBe(
      'available',
    );
    const image = registry.find((entry) => entry.kind === 'tool' && entry.id === 'image_generate');
    expect(image?.availability).toBe('unavailable');
    // 在清单里、但没实测记录 ⇒ unverified（"存在"不等于"验证过"）
    const readFile = registry.find((entry) => entry.kind === 'tool' && entry.id === 'read_file');
    expect(readFile?.availability).toBe('unverified');
    expect(readFile?.reason).toBeTruthy();
  });

  it('清单外的账本工具照旧出现（image/video 生成不因清单缺它而"消失"）', () => {
    const registry = buildCapabilityRegistry({ toolIds: ['read_file'] });
    expect(registry.some((entry) => entry.kind === 'tool' && entry.id === 'image_generate')).toBe(true);
    expect(registry.some((entry) => entry.kind === 'tool' && entry.id === 'video_generate')).toBe(true);
  });

  it('账本记录过的工具不重复出条目（同一能力只许一条记录）', () => {
    const registry = buildCapabilityRegistry({ toolIds: ['browser', 'image_generate', 'read_file'] });
    const browserEntries = registry.filter((entry) => entry.kind === 'tool' && entry.id === 'browser');
    expect(browserEntries).toHaveLength(1);
    const imageEntries = registry.filter((entry) => entry.kind === 'tool' && entry.id === 'image_generate');
    expect(imageEntries).toHaveLength(1);
  });
});

describe('Planner 边界：unavailable 的能力不暴露', () => {
  it('图片 / 视频生成都在 deny 名单里（本轮不接入）', () => {
    const denied = plannerDeniedToolIds();
    expect(denied).toContain('image_generate');
    expect(denied).toContain('video_generate');
    // 2026-10-08 deny v2（BUG-061）：music_generate 是 media 三件套的漏网者，一并摘除
    expect(denied).toContain('music_generate');
    // 2026-10-08：file_fetch（配对节点文件传输，单机必败）同名单 —— 见下方专门用例
    expect(PLANNER_UNAVAILABLE_TOOL_IDS).toEqual(['image_generate', 'video_generate', 'music_generate', 'file_fetch']);
  });

  it('账本里标记 unavailable 的工具 = deny 名单（一个不多、一个不少）', () => {
    const ledgerUnavailableTools = CAPABILITY_VERIFICATION_LEDGER.filter(
      (record) => record.kind === 'tool' && record.availability === 'unavailable' && record.id !== 'voice',
    ).map((record) => record.id);
    expect(new Set(plannerDeniedToolIds())).toEqual(new Set(ledgerUnavailableTools));
  });

  it('voice（语音）在 Windows 桌面版 = unavailable，但不在工具 deny 名单（它不是运行时工具）', () => {
    const voice = findCapabilityEntry(buildCapabilityRegistry(), { kind: 'tool', id: 'voice', capability: 'voice' });
    expect(voice?.availability).toBe('unavailable');
    expect(plannerDeniedToolIds()).not.toContain('voice');
  });

  /**
   * BUG-043 注册表本应覆盖的类（pre19 验收实跑抓到）：内核 `file_fetch` 是**配对节点**的
   * 文件传输工具；单机产品没有配对节点 ⇒ 调用必然失败，且失败原文是英文样板
   * （`no paired nodes available; file-transfer tools require a paired node…`）直接上屏。
   * 证据：`T:\荣盈魔方-运行数据\logs\debug-2026-10-08.7.ndjson`（task 81e5053a，
   * `"name":"file_fetch"`, `status:"failed"`）。
   */
  it('⭐ file_fetch（配对节点文件传输）单机必然失败 ⇒ 账本 unavailable 且进 deny', () => {
    const fetch = findCapabilityEntry(buildCapabilityRegistry(), {
      kind: 'tool',
      id: 'file_fetch',
      capability: 'file-transfer',
    });
    expect(fetch?.availability).toBe('unavailable');
    expect(fetch?.reason ?? '').toMatch(/配对|节点/);
    expect(plannerDeniedToolIds()).toContain('file_fetch');
    expect(PLANNER_UNAVAILABLE_TOOL_IDS).toEqual(['image_generate', 'video_generate', 'music_generate', 'file_fetch']);
  });

  it('music_generate（media 三件套漏网者）同批进 deny（deny v2，BUG-061）', () => {
    const music = findCapabilityEntry(buildCapabilityRegistry(), {
      kind: 'tool',
      id: 'music_generate',
      capability: 'music-generation',
    });
    expect(music?.availability).toBe('unavailable');
    expect(music?.reason ?? '').toMatch(/media-loop|不接入/);
    expect(plannerDeniedToolIds()).toContain('music_generate');
  });

  it('清单里有 file_fetch 时仍按账本判 unavailable（"在清单里"不等于可用）', () => {
    const registry = buildCapabilityRegistry({ toolIds: ['read_file', 'file_fetch'] });
    const entry = registry.find((candidate) => candidate.kind === 'tool' && candidate.id === 'file_fetch');
    expect(entry?.availability).toBe('unavailable');
  });
});
