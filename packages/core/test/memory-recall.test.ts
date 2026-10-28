/**
 * 长期记忆的**本地检索**（T27，2026-10-16）。
 *
 * 要钉住的三件事：
 *   · 少条目（≤ 预算）⇒ **原样返回**（连顺序都不动）—— 绝大多数用户行为不变；
 *   · 超预算 ⇒ **按提问选**，且**换一个提问选出来的集合真的会变**（这是它与"固定截断"
 *     唯一可观测的区别）；
 *   · 确定性：同输入同输出，顺序稳定（不许因为 Map/排序不稳定而抖动）。
 */
import { describe, expect, it } from 'vitest';
import { MEMORY_RECALL_TOP_N, memoryQueryTokens, scoreMemoryEntry, selectMemoriesForQuery } from '../src/memory/recall';

const entry = (text: string) => ({ text });

const ENTRIES = [
  entry('我习惯先看结论再看过程。'),
  entry('报价一律用含税价。'),
  entry('不要在周末给我排任务。'),
  entry('我做的品类是宠物用品，主要走电商。'),
  entry('每周一上午要开选题会。'),
  entry('PPT 的主题色用深蓝。'),
];

describe('memoryQueryTokens', () => {
  it('拉丁词取长度 ≥2；中文取二元组（无空格也能命中）', () => {
    expect(memoryQueryTokens('OK use PPT')).toEqual(['ok', 'use', 'ppt']);
    expect(memoryQueryTokens('结论')).toEqual(['结论']);
    expect(memoryQueryTokens('先看结论')).toEqual(['先看', '看结', '结论']);
  });

  it('标点/空白把中文切成独立段，不跨段造二元组', () => {
    expect(memoryQueryTokens('结论，过程')).toEqual(['结论', '过程']);
  });
});

describe('scoreMemoryEntry', () => {
  it('整句包含最强；其次才是词元重叠', () => {
    const exact = scoreMemoryEntry('报价一律用含税价。', '报价一律用含税价');
    const partial = scoreMemoryEntry('报价一律用含税价。', '报价');
    expect(exact).toBeGreaterThan(partial);
    expect(partial).toBeGreaterThan(0);
  });

  it('完全无关 ⇒ 分数 ≤ 0（短条目惩罚是唯一来源），不会被误当命中', () => {
    expect(scoreMemoryEntry('每周一上午要开选题会。', 'zzzz')).toBeLessThanOrEqual(0);
  });
});

describe('selectMemoriesForQuery', () => {
  it('⭐ 条目 ≤ 预算 ⇒ **原样返回**（含顺序），行为与全量注入逐字一致', () => {
    const out = selectMemoriesForQuery(ENTRIES, '报价');
    expect(out).toEqual(ENTRIES);
    expect(out).not.toBe(ENTRIES); // 新数组，调用方改它不会波及入参
  });

  it('⭐ 超预算 ⇒ 换一个提问，注入的集合**真的不一样**（与固定截断的唯一区别）', () => {
    const many = Array.from({ length: MEMORY_RECALL_TOP_N + 6 }, (_, i) =>
      entry(i === 24 ? '报价一律用含税价，别给我税前价。' : `与报价无关的第 ${i} 条记忆：今天下雨。`),
    );
    many[23] = entry('我的宠物用品品类在电商上主要卖猫砂。');

    const byPrice = selectMemoriesForQuery(many, '报价怎么给？').map((e) => e.text);
    const byCategory = selectMemoriesForQuery(many, '宠物用品品类').map((e) => e.text);

    expect(byPrice).toHaveLength(MEMORY_RECALL_TOP_N);
    expect(byCategory).toHaveLength(MEMORY_RECALL_TOP_N);
    expect(byPrice[0]).toContain('含税价'); // 相关的那条排第一
    expect(byCategory[0]).toContain('猫砂');
    expect(new Set(byPrice)).not.toEqual(new Set(byCategory)); // 集合确实随提问变化
  });

  it('确定性：同输入两次调用结果完全相同（顺序也一致）', () => {
    const many = Array.from({ length: MEMORY_RECALL_TOP_N + 3 }, (_, i) => entry(`第 ${i} 条：无关内容。`));
    const a = selectMemoriesForQuery(many, '没有任何词命中').map((e) => e.text);
    const b = selectMemoriesForQuery(many, '没有任何词命中').map((e) => e.text);
    expect(a).toEqual(b);
  });

  it('提问为空/只有空白 ⇒ 按原顺序取前 limit 条（不假装有相关性）', () => {
    const many = Array.from({ length: MEMORY_RECALL_TOP_N + 2 }, (_, i) => entry(`第 ${i} 条`));
    expect(selectMemoriesForQuery(many, '   ').map((e) => e.text)).toEqual(
      many.slice(0, MEMORY_RECALL_TOP_N).map((e) => e.text),
    );
  });

  it('打分全 0 也不丢覆盖：余下名额按原顺序补满', () => {
    const many = Array.from({ length: MEMORY_RECALL_TOP_N + 4 }, (_, i) => entry(`第 ${i} 条`));
    const out = selectMemoriesForQuery(many, 'zzz');
    expect(out).toHaveLength(MEMORY_RECALL_TOP_N);
    expect(out.map((e) => e.text)).toEqual(many.slice(0, MEMORY_RECALL_TOP_N).map((e) => e.text));
  });
});
