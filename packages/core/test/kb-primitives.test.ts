import { describe, expect, it } from 'vitest';
import { hashBytes, hashText } from '../src/services/kb/hashing.js';
import {
  KbVectorError,
  cosineSimilarity,
  decodeVector,
  encodeVector,
  isKbVectorError,
  toVectorArray,
} from '../src/services/kb/vectors.js';

/**
 * 两个"底层约定"的锁：
 * - 指纹算法**冻结**（它会随 kb_sources 落进用户的 U 盘库；换算法 = 全量重嵌入 = 花积分）；
 * - 向量 BLOB 是 float32 小端、能原样往返（写进去读出来不是一个数 = 检索全是噪声）。
 */

describe('hashText / hashBytes', () => {
  it('固定向量：算法变了这条就红（提醒你它会让所有老资料重新嵌入）', () => {
    expect(hashText('')).toBe('811c9dc59e37e78e85eaf605c2b37490');
    expect(hashText('abc')).toBe('57bf9b12993bea5d7003e36e531b2313');
    expect(hashText('预算第三章')).toBe('ba93c1ab5a55c0b43c05b847887aedee');
    expect(hashText('这是一段用来做指纹固定值的中文文本。'.repeat(10))).toBe('8cabe3d50ccc809ee06da8bd0bf77db8');
  });

  it('同样内容恒定、不同内容不同（含只差一个字符/一个字的情况）', () => {
    expect(hashText('预算表')).toBe(hashText('预算表'));
    expect(hashText('预算表')).not.toBe(hashText('预算'));
    expect(hashText('预算表')).not.toBe(hashText('预算 表'));
    expect(hashText('a'.repeat(1000))).not.toBe(hashText(`${'a'.repeat(1000)} `));
  });

  it('长度参与混合：前缀相同/尾部多一个字节的输入不撞', () => {
    expect(hashText('ab')).not.toBe(hashText('abab'));
    expect(hashBytes(new Uint8Array([1, 2, 3]))).not.toBe(hashBytes(new Uint8Array([1, 2, 3, 0])));
  });

  it('输出恒为 32 位十六进制（128 bit）', () => {
    for (const value of ['', 'x', hashText('中文'), 'a'.repeat(5000)]) {
      const digest = hashText(value);
      expect(digest).toMatch(/^[0-9a-f]{32}$/);
    }
  });
});

describe('向量 <-> BLOB', () => {
  it('float32 小端往返，逐位相等', () => {
    const source = [1.5, -2.25, 0, 0.1, 1234.5];

    const bytes = encodeVector(source);
    const decoded = decodeVector(bytes);

    expect(bytes.byteLength).toBe(source.length * 4);
    // 小端：1.5 = 0x3FC00000 ⇒ 字节序 00 00 C0 3F
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x00, 0x00, 0xc0, 0x3f]);
    expect(Array.from(decoded)).toEqual(Array.from(new Float32Array(source)));
    expect(toVectorArray(decoded)).toEqual(Array.from(decoded));
  });

  it('byteOffset 不为 4 的倍数也能读（Node 的 Buffer 池化就是这个形状）', () => {
    const bytes = encodeVector([3.5, 6.5]);
    const shifted = new Uint8Array(bytes.byteLength + 3);
    shifted.set(bytes, 3);

    expect(Array.from(decodeVector(shifted.subarray(3)))).toEqual([3.5, 6.5]);
    expect(() => decodeVector(shifted)).toThrow(KbVectorError);
  });

  it('半截 float32 明确报错，而不是静默读出垃圾', () => {
    let caught: unknown;
    try {
      decodeVector(new Uint8Array([1, 2, 3]));
    } catch (error) {
      caught = error;
    }
    expect(isKbVectorError(caught)).toBe(true);
    expect((caught as Error).message).toContain('不是 4 的倍数');
  });

  it('余弦相似度：同向 1、正交 0、反向 -1、零向量 0（不产生 NaN）', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 10);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 10);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity([1, 2, 3], [1, 2])).toBe(0); // 维度不一致 ⇒ 当成没关系
    expect(Number.isNaN(cosineSimilarity([0, 0], [0, 0]))).toBe(false);
  });
});
