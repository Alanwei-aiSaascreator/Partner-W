import { describe, expect, it } from 'vitest';
import type { EmbeddingEngine } from '../src/services/kb/embedding.js';
import { isEmbeddingEngineReady } from '../src/services/kb/embedding.js';
import {
  buildChunkDrafts,
  chunkNeedsEmbedding,
  embedPendingChunks,
  markStaleChunks,
} from '../src/services/kb/pipeline.js';
import { hashText } from '../src/services/kb/hashing.js';
import type { KbEmbeddableChunk } from '../src/services/kb/types.js';

/**
 * 状态机与断点续做的行为断言。
 *
 * 这四条是设计要求里最容易被写成"假通过"的地方，所以都断言**真实数据流**：
 * ① 没有引擎时块留在 pending（不产生假向量）；② 换模型 ⇒ 旧块 stale、向量仍在；
 * ③ 一批失败后，已完成批次保住、下次只补没做的（引擎收到的文本逐条核对）；
 * ④ 引擎返回条数/维度不对 ⇒ 当失败处理，不写脏向量。
 */

const MODEL = 'fake-embed-v1';

/** 确定性假引擎：向量 = 每个字符的码点累加后摊到 dim 位。 */
function createFakeEngine(model = MODEL, dim = 4): EmbeddingEngine & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    model,
    dim,
    calls,
    async embed(texts: readonly string[]): Promise<number[][]> {
      calls.push([...texts]);
      return texts.map((text) => {
        const seed = hashText(text);
        return Array.from(
          { length: dim },
          (_, index) => (Number.parseInt(seed.slice(index * 4, index * 4 + 4), 16) % 1000) / 1000,
        );
      });
    },
  };
}

function createFailingEngine(model = MODEL, dim = 4, failOnCall = 2): EmbeddingEngine & { calls: string[][] } {
  const inner = createFakeEngine(model, dim);
  let call = 0;
  return {
    model,
    dim,
    calls: inner.calls,
    async embed(texts: readonly string[]): Promise<number[][]> {
      call += 1;
      if (call >= failOnCall) throw new Error('网络不可达：嵌入通道失败');
      return inner.embed(texts);
    },
  };
}

function chunk(id: string, text: string, overrides: Partial<KbEmbeddableChunk> = {}): KbEmbeddableChunk {
  return {
    id,
    ordinal: Number(id.split('#')[1] ?? 0),
    text,
    vector: null,
    embeddingModel: null,
    state: 'pending_embedding',
    ...overrides,
  };
}

const PENDING = Array.from({ length: 5 }, (_, index) => chunk(`src#${index}`, `第 ${index} 块的正文`));

describe('buildChunkDrafts', () => {
  it('产出连续序号 + token 估算 + 带标题前缀的文本', () => {
    const drafts = buildChunkDrafts('# 预算\n\n第一段。\n\n## 收入\n\n第二段。');

    expect(drafts.map((draft) => draft.ordinal)).toEqual([0, 1]);
    expect(drafts[0].text).toBe('【所属：预算】\n第一段。');
    expect(drafts[1].text).toBe('【所属：预算 › 收入】\n第二段。');
    expect(drafts.every((draft) => draft.tokenEstimate > 0)).toBe(true);
  });

  it('同样的正文切两次结果逐字相同（重建一致性的 core 半边）', () => {
    const text = '# 报告\n\n' + '这是一段用来验证重建确定性的正文。'.repeat(60);

    expect(buildChunkDrafts(text)).toEqual(buildChunkDrafts(text));
  });
});

describe('chunkNeedsEmbedding / isEmbeddingEngineReady：没有引擎的默认路径', () => {
  it('引擎为 null ⇒ 任何块都不需要嵌入（全走 FTS，不是错误）', () => {
    expect(chunkNeedsEmbedding(chunk('a#0', 'x'), null)).toBe(false);
    expect(isEmbeddingEngineReady(null)).toBe(false);
    expect(isEmbeddingEngineReady(undefined)).toBe(false);
  });

  it('pending / stale / 换了模型 ⇒ 需要；embedded 且模型一致 ⇒ 不需要', () => {
    expect(chunkNeedsEmbedding(chunk('a#0', 'x'), MODEL)).toBe(true);
    expect(chunkNeedsEmbedding(chunk('a#0', 'x', { state: 'stale', vector: new Float32Array([1]) }), MODEL)).toBe(true);
    expect(chunkNeedsEmbedding(chunk('a#0', 'x', { state: 'embedded', embeddingModel: MODEL }), MODEL)).toBe(false);
    expect(chunkNeedsEmbedding(chunk('a#0', 'x', { state: 'embedded', embeddingModel: 'old-model' }), MODEL)).toBe(
      true,
    );
  });
});

describe('markStaleChunks：换嵌入模型', () => {
  it('旧模型的块变 stale，向量保留（切回原模型不用重花积分）', () => {
    const vector = new Float32Array([0.1, 0.2]);
    const old = chunk('a#0', 'x', { state: 'embedded', embeddingModel: 'old-model', vector });
    const current = chunk('a#1', 'y', { state: 'embedded', embeddingModel: MODEL, vector });
    const pending = chunk('a#2', 'z');

    const staled = markStaleChunks([old, current, pending], MODEL);

    expect(staled).toHaveLength(1);
    expect(staled[0]).toMatchObject({ id: 'a#0', state: 'stale', embeddingModel: 'old-model' });
    expect(staled[0].vector).toBe(vector);
    // 原对象不被就地改写
    expect(old.state).toBe('embedded');
  });

  it('模型为 null（引擎被摘掉 / 离线）不算"换模型"，一个都不标', () => {
    const old = chunk('a#0', 'x', { state: 'embedded', embeddingModel: 'old-model', vector: new Float32Array([1]) });

    expect(markStaleChunks([old], null)).toEqual([]);
    expect(markStaleChunks([old], 'old-model')).toEqual([]);
  });
});

describe('embedPendingChunks', () => {
  it('全部 pending ⇒ 全部 embedded，向量与模型都写上', async () => {
    const engine = createFakeEngine();

    const result = await embedPendingChunks(PENDING, engine, { batchSize: 2 });

    expect(result.attempted).toBe(5);
    expect(result.embedded).toBe(5);
    expect(result.failed).toBe(0);
    expect(result.error).toBeNull();
    expect(result.chunks.every((item) => item.state === 'embedded' && item.embeddingModel === MODEL)).toBe(true);
    expect(result.chunks.every((item) => item.vector?.length === 4)).toBe(true);
    expect(engine.calls).toHaveLength(3); // 2 + 2 + 1
  });

  it('已嵌好的块不会再发给引擎（不会重复花积分）', async () => {
    const engine = createFakeEngine();
    const embedded: KbEmbeddableChunk = {
      ...chunk('src#9', '早就嵌好了'),
      state: 'embedded',
      embeddingModel: MODEL,
      vector: new Float32Array([1, 2, 3, 4]),
    };

    const result = await embedPendingChunks([...PENDING, embedded], engine, { batchSize: 16 });

    expect(engine.calls.flat()).toEqual(PENDING.map((item) => item.text));
    expect(engine.calls.flat()).not.toContain('早就嵌好了');
    expect(result.chunks[5].vector).toBe(embedded.vector); // 原样带回来，没被重写
    expect(Array.from(result.chunks[5].vector as Float32Array)).toEqual([1, 2, 3, 4]);
  });

  it('断点续做：第 2 批失败 ⇒ 第 1 批保住，下一轮只补没做的', async () => {
    const flaky = createFailingEngine(MODEL, 4, 2);

    const first = await embedPendingChunks(PENDING, flaky, { batchSize: 2 });

    expect(first.attempted).toBe(4); // 两批发了出去
    expect(first.embedded).toBe(2); // 只有第一批成功
    expect(first.failed).toBe(2);
    expect(first.error?.message).toContain('网络不可达');
    expect(first.chunks.map((item) => item.state)).toEqual([
      'embedded',
      'embedded',
      'pending_embedding',
      'pending_embedding',
      'pending_embedding',
    ]);

    const healthy = createFakeEngine();
    const second = await embedPendingChunks(first.chunks, healthy, { batchSize: 2 });

    expect(healthy.calls.flat()).toEqual([PENDING[2].text, PENDING[3].text, PENDING[4].text]);
    expect(second.embedded).toBe(3);
    expect(second.error).toBeNull();
    expect(second.chunks.every((item) => item.state === 'embedded')).toBe(true);
    // 第一批的向量在第二轮里没有被改写
    expect(second.chunks.slice(0, 2).map((item) => Array.from(item.vector as Float32Array))).toEqual(
      first.chunks.slice(0, 2).map((item) => Array.from(item.vector as Float32Array)),
    );
  });

  it('引擎返回条数/维度不对 ⇒ 当失败处理，一个脏向量都不写', async () => {
    const wrongCount: EmbeddingEngine = {
      model: MODEL,
      dim: 4,
      async embed() {
        return [[1, 2, 3, 4]];
      },
    };
    const wrongDim: EmbeddingEngine = {
      model: MODEL,
      dim: 4,
      async embed(texts) {
        return texts.map(() => [1, 2]);
      },
    };

    const first = await embedPendingChunks(PENDING, wrongCount, { batchSize: 2 });
    const second = await embedPendingChunks(PENDING, wrongDim, { batchSize: 2 });

    for (const result of [first, second]) {
      expect(result.embedded).toBe(0);
      expect(result.failed).toBe(2);
      expect(result.error?.message).toContain('不对');
      expect(result.chunks.every((item) => item.vector === null && item.state === 'pending_embedding')).toBe(true);
    }
  });

  it('换模型后重嵌：stale 的块用新模型重新嵌上，旧向量被替换', async () => {
    const stale = chunk('a#0', '内容', {
      state: 'stale',
      embeddingModel: 'old-model',
      vector: new Float32Array([9, 9, 9, 9]),
    });
    const engine = createFakeEngine('new-model');

    const result = await embedPendingChunks([stale], engine);

    expect(result.embedded).toBe(1);
    expect(result.chunks[0].state).toBe('embedded');
    expect(result.chunks[0].embeddingModel).toBe('new-model');
    expect(result.chunks[0].vector).not.toEqual(new Float32Array([9, 9, 9, 9]));
  });
});
