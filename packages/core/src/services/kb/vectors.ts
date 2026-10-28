/**
 * 向量与 BLOB 的互转、余弦相似度。
 *
 * 落库形状固定为 **float32 小端** 的裸字节（`kb_chunks.vector`）—— 与主流嵌入引擎
 * 的输出精度一致；换成 float64 只会让 U 盘上的索引白白大一倍。
 */

/** 向量维度不是 4 的倍数（或读到了半截 float32）时抛这个。 */
export class KbVectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KbVectorError';
  }
}

export function isKbVectorError(error: unknown): error is KbVectorError {
  return error instanceof KbVectorError;
}

/** float32 向量 → BLOB 字节（小端）。 */
export function encodeVector(vector: ArrayLike<number>): Uint8Array {
  const bytes = new Uint8Array(vector.length * 4);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < vector.length; index += 1) {
    view.setFloat32(index * 4, Number(vector[index]), true);
  }
  return bytes;
}

/** BLOB 字节 → float32 向量。**逐字节读**，不做零拷贝视图（Node 的 Buffer 池化会让
 *  `byteOffset` 不是 4 的倍数，直接 `new Float32Array(buffer, offset)` 会当场抛）。 */
export function decodeVector(bytes: Uint8Array): Float32Array {
  if (bytes.byteLength % 4 !== 0) {
    throw new KbVectorError(`向量字节数 ${bytes.byteLength} 不是 4 的倍数`);
  }
  const vector = new Float32Array(bytes.byteLength / 4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < vector.length; index += 1) {
    vector[index] = view.getFloat32(index * 4, true);
  }
  return vector;
}

/** 向量转普通数组（便于断言与序列化）。 */
export function toVectorArray(vector: ArrayLike<number>): number[] {
  return Array.from({ length: vector.length }, (_, index) => Number(vector[index]));
}

/**
 * 余弦相似度，范围 [-1, 1]。
 * 任一向量为空/零向量时返回 0 —— 宁可在排序里当"没关系"，也不要 NaN 把整次检索毁掉。
 */
export function cosineSimilarity(left: ArrayLike<number>, right: ArrayLike<number>): number {
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = Number(left[index]);
    const b = Number(right[index]);
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}
