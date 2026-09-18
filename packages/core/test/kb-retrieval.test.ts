import { describe, expect, it } from 'vitest';
import { rankKbCandidates } from '../src/services/kb/retrieval.js';
import type { KbSearchCandidate } from '../src/services/kb/retrieval.js';
import type { KbChunkState } from '../src/services/kb/types.js';

/**
 * 检索排序的**降级**断言（设计 §五：U 盘场景常常没网）。
 *
 * 这一层的硬度在于：候选集永远由 FTS5 捞出来（没有向量也有结果），而"有没有网"
 * 只影响**排序**。所以几条用例刻意做成同一批候选、只换 queryVector：
 * 无网 ⇒ 关键词序；有网 ⇒ 语义相近的能翻上来；模型换过/块 stale ⇒ 旧向量被无视。
 */

const MODEL = 'fake-embed-v1';

function candidate(
  id: string,
  keywordScore: number,
  vector: number[] | null,
  overrides: Partial<KbSearchCandidate> = {},
): KbSearchCandidate {
  return {
    chunkId: id,
    sourceId: `src-${id}`,
    ordinal: 0,
    text: `${id} 的正文`,
    snippet: `<<${id}>> 的正文`,
    keywordScore,
    vector: vector ? new Float32Array(vector) : null,
    embeddingModel: vector ? MODEL : null,
    state: vector ? 'embedded' : 'pending_embedding',
    sourceKind: 'note',
    sourceTitle: `${id} 那份资料`,
    sourcePath: '',
    ...overrides,
  };
}

describe('rankKbCandidates：纯关键词（没有查询向量 = 断网降级）', () => {
  it('完全不给向量时按关键词得分排，并如实报告 mode=keyword', () => {
    const result = rankKbCandidates([
      candidate('weak', 0.1, null),
      candidate('strong', 0.9, null),
      candidate('mid', 0.5, null),
    ]);

    expect(result.mode).toBe('keyword');
    expect(result.hits.map((hit) => hit.chunkId)).toEqual(['strong', 'mid', 'weak']);
    expect(result.hits.every((hit) => hit.vectorUsed === false && hit.vectorScore === 0)).toBe(true);
  });

  it('候选里带着向量、但没给查询向量 ⇒ 仍然纯关键词（离线时向量不参与）', () => {
    const result = rankKbCandidates([candidate('weak', 0.1, [0, 1]), candidate('strong', 0.9, [1, 0])]);

    expect(result.mode).toBe('keyword');
    expect(result.hits.map((hit) => hit.chunkId)).toEqual(['strong', 'weak']);
    expect(result.hits.every((hit) => hit.vectorUsed === false)).toBe(true);
  });
});

describe('rankKbCandidates：关键词 + 向量（有网）', () => {
  const candidates = [candidate('keyword-heavy', 1, [1, 0]), candidate('semantic', 0.2, [0, 1])];

  it('语义相近但关键词弱的块能排到前面（向量真的参与了）', () => {
    const result = rankKbCandidates(candidates, { queryVector: new Float32Array([0, 1]), activeModel: MODEL });

    expect(result.mode).toBe('hybrid');
    expect(result.hits.map((hit) => hit.chunkId)).toEqual(['semantic', 'keyword-heavy']);
    expect(result.hits[0].vectorUsed).toBe(true);
    expect(result.hits[0].vectorScore).toBeCloseTo(1, 6);
    // 关键词的重排效果：不给向量时顺序是反的（同一条用例内对照，避免"其实一直都对"）
    expect(rankKbCandidates(candidates).hits.map((hit) => hit.chunkId)).toEqual(['keyword-heavy', 'semantic']);
  });

  it('忘了带查询向量 / 候选全没有向量 ⇒ 明确回落到 keyword', () => {
    expect(rankKbCandidates([candidate('a', 1, null)], { activeModel: MODEL }).mode).toBe('keyword');
    expect(rankKbCandidates([candidate('a', 1, [1, 0])], { queryVector: new Float32Array([1, 0]) }).mode).toBe(
      'keyword',
    );
  });
});

describe('rankKbCandidates：换过模型的向量不参与排序', () => {
  it.each<[string, Partial<KbSearchCandidate>, KbChunkState]>([
    ['块是 stale（换过模型、等重建）', { state: 'stale' as KbChunkState }, 'stale'],
    ['块的模型与当前模型不一致', { embeddingModel: 'old-model' }, 'embedded'],
    [
      '块还没有向量',
      { vector: null, state: 'pending_embedding' as KbChunkState, embeddingModel: null },
      'pending_embedding',
    ],
  ])('%s ⇒ vectorUsed=false，退回关键词序', (_label, overrides, expectedState) => {
    const staleSemantic = candidate('stale-but-similar', 0.2, [0, 1], overrides);
    const result = rankKbCandidates([candidate('keyword-heavy', 1, [1, 0]), staleSemantic], {
      queryVector: new Float32Array([0, 1]),
      activeModel: MODEL,
    });

    expect(result.hits.map((hit) => hit.chunkId)).toEqual(['keyword-heavy', 'stale-but-similar']);
    const stale = result.hits.find((hit) => hit.chunkId === 'stale-but-similar');
    expect(stale?.vectorUsed).toBe(false);
    expect(stale?.vectorScore).toBe(0);
    expect(stale?.state).toBe(expectedState);
    // 关键：向量被无视 ≠ 这个块被丢出结果 —— 文本还在，关键词照样能召回它
    expect(result.hits).toHaveLength(2);
  });

  it('负余弦夹到 0（不会把"反相关"当成负分往下踩）', () => {
    const result = rankKbCandidates([candidate('opposite', 0.5, [-1, 0])], {
      queryVector: new Float32Array([1, 0]),
      activeModel: MODEL,
    });

    expect(result.hits[0].vectorUsed).toBe(true);
    expect(result.hits[0].vectorScore).toBe(0);
    expect(result.hits[0].score).toBeCloseTo(0.4, 6); // 唯一候选 ⇒ 关键词归一化成 1，向量 0
    expect(result.mode).toBe('hybrid'); // 向量"用上了"但相似度是 0，mode 只表示向量参与了排序
  });
});

describe('rankKbCandidates：截断与确定性', () => {
  it('limit 生效，同分时按 chunkId 稳定排序', () => {
    const ties = [candidate('c', 0.5, null), candidate('a', 0.5, null), candidate('b', 0.5, null)];

    expect(rankKbCandidates(ties, { limit: 2 }).hits.map((hit) => hit.chunkId)).toEqual(['a', 'b']);
    expect(rankKbCandidates(ties).hits.map((hit) => hit.chunkId)).toEqual(['a', 'b', 'c']);
    expect(rankKbCandidates(ties, { limit: 0 }).hits).toEqual([]);
  });

  it('命中片段与出处原样带出（引用角标要用它显示高亮、点回原文）', () => {
    const result = rankKbCandidates([candidate('a', 1, null)]);

    expect(result.hits[0].snippet).toBe('<<a>> 的正文');
    expect(result.hits[0]).toMatchObject({ sourceTitle: 'a 那份资料', sourceKind: 'note', ordinal: 0 });
  });
});
