import { describe, expect, it } from 'vitest';
import { cosineSimilarity, l2Normalize, meanPool } from '../src/main/kb/embedding/vector-math';

/**
 * 本地嵌入的向量数学 —— **这块的错最隐蔽**：算错了不报错，
 * 只是检索结果"看起来有点不对"，没人会怀疑到池化/归一化头上。
 * 所以每条都用**能手算**的小例子钉住。
 */

describe('meanPool —— BGE 的池化必须按 attention mask 加权', () => {
  it('⭐ 两 token、dim=2：逐维求平均', () => {
    // token0 = [1, 3], token1 = [3, 5] ⇒ 均值 [2, 4]
    const flat = new Float32Array([1, 3, 3, 5]);
    expect(Array.from(meanPool(flat, [1, 1], 2))).toEqual([2, 4]);
  });

  it('⭐ padding 不参与平均（不按 mask 加权的话，短句会被一堆零拉偏）', () => {
    // token0 = [4, 8]，token1 是 padding（全 0，mask=0）⇒ 结果必须还是 [4, 8]
    const flat = new Float32Array([4, 8, 0, 0]);
    expect(Array.from(meanPool(flat, [1, 0], 2))).toEqual([4, 8]);
  });

  it('mask 全 0 时返回全 0（不能除零变成 NaN）', () => {
    const out = meanPool(new Float32Array([1, 2]), [0], 2);
    expect(Array.from(out)).toEqual([0, 0]);
    expect(Array.from(out).every(Number.isFinite)).toBe(true);
  });

  it('空输入返回空向量（不抛）', () => {
    expect(meanPool(new Float32Array([]), [], 2)).toHaveLength(2);
  });
});

describe('l2Normalize —— 归一化后余弦相似度就是点积', () => {
  it('⭐ 3-4-5 直角三角形：长度变 1，方向不变', () => {
    const out = l2Normalize(new Float32Array([3, 4]));
    expect(out[0]).toBeCloseTo(0.6, 6);
    expect(out[1]).toBeCloseTo(0.8, 6);
  });

  it('零向量返回零向量（不产生 NaN —— 后面余弦会用到除法）', () => {
    const out = l2Normalize(new Float32Array([0, 0, 0]));
    expect(Array.from(out)).toEqual([0, 0, 0]);
    expect(Array.from(out).every(Number.isFinite)).toBe(true);
  });

  it('幂等：归一化过的再归一化不变', () => {
    const once = l2Normalize(new Float32Array([3, 4]));
    const twice = l2Normalize(once);
    expect(Array.from(twice)).toEqual(Array.from(once));
  });

  it('不改入参（调用方可能还要用原始向量）', () => {
    const input = new Float32Array([3, 4]);
    l2Normalize(input);
    expect(Array.from(input)).toEqual([3, 4]);
  });
});

describe('cosineSimilarity', () => {
  it('同向 = 1，正交 = 0，反向 = -1', () => {
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([2, 0]))).toBeCloseTo(1, 6);
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0, 5]))).toBeCloseTo(0, 6);
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([-3, 0]))).toBeCloseTo(-1, 6);
  });

  it('⭐ 长度不同直接判 0（不能读到越界/拿短的那个凑合）', () => {
    expect(cosineSimilarity(new Float32Array([1, 2, 3]), new Float32Array([1, 2]))).toBe(0);
  });

  it('任一为零向量 ⇒ 0（不产生 NaN）', () => {
    expect(cosineSimilarity(new Float32Array([0, 0]), new Float32Array([1, 1]))).toBe(0);
    expect(cosineSimilarity(new Float32Array([0, 0]), new Float32Array([0, 0]))).toBe(0);
  });
});
