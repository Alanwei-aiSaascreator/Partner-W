/**
 * 本地嵌入用到的向量数学（纯函数）。
 *
 * ⚠️ 这块的错**最隐蔽**：算错了不报错、不崩，只是检索结果"看起来有点不对"，
 * 没人会怀疑到池化/归一化头上。所以每条都按"能手算"的小例子写，别用随机数测。
 *
 * 形状约定（BGE 这类句向量模型）：
 *   - 模型输出 `last_hidden_state`：扁平 `[tokenCount * dim]`，行优先
 *   - 池化：**按 attention mask 加权平均**（不是简单平均 —— 见 `meanPool`）
 *   - 归一化：L2 到单位长度，之后余弦相似度就退化成点积
 */

/**
 * 按 attention mask 加权平均成句向量。
 *
 * ⚠️ **必须按 mask 加权**：padding 位在模型输出里不是精确的 0（是"看起来像噪声"的小值），
 * 简单平均会把短句的向量往噪声方向拉 —— 短句越多、偏得越厉害，而且不报错。
 *
 * @param flat 模型输出，长度 `mask.length * dim`
 * @param mask 1 = 真 token，0 = padding
 * @param dim  每个 token 的向量维度
 */
export function meanPool(flat: Float32Array, mask: readonly number[], dim: number): Float32Array {
  const out = new Float32Array(dim);
  if (dim <= 0) return out;

  let total = 0;
  for (let t = 0; t < mask.length; t++) {
    if (!mask[t]) continue;
    total += 1;
    const base = t * dim;
    // 输出比输入短（模型给了更少的 token）时不要越界读
    if (base + dim > flat.length) break;
    for (let d = 0; d < dim; d++) out[d] += flat[base + d];
  }

  // mask 全 0（或压根没有真 token）⇒ 返回全 0，**不能除零** ——
  // NaN 会一路污染到检索排序里，而且只在极少数输入上出现，极难复现。
  if (total === 0) return out;

  for (let d = 0; d < dim; d++) out[d] /= total;
  return out;
}

/** L2 归一化到单位长度。零向量原样返回（不能产生 NaN）。 */
export function l2Normalize(vector: Float32Array): Float32Array {
  let sumSquares = 0;
  for (const value of vector) sumSquares += value * value;

  const norm = Math.sqrt(sumSquares);
  if (!Number.isFinite(norm) || norm === 0) return new Float32Array(vector.length);

  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i++) out[i] = vector[i] / norm;
  return out;
}

/**
 * 余弦相似度。
 *
 * ⚠️ **长度不同判 0**：那说明拿两个不同模型的向量在比（或写库那侧维度对不上）。
 * 这时候最坏的做法是"按短的那个凑合算" —— 会给出一个看起来合理的分数。
 * 判 0 会让它在排序里沉底，问题更容易被发现。
 *
 * ⚠️ 下面这行守卫是**故意显式**写的，不是多余的：越界读 `Float32Array` 得到
 * `undefined` → NaN → 被末尾的 `isFinite` 兜成 0，**结果虽然一样**，但那是一条
 * "靠副作用才对"的路径 —— 哪天入参换成普通数组就会静默算出别的数。
 * （变异验证时确认了这两条路等价：拿掉守卫测不出差别，所以别指望测试帮你守它。）
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (!Number.isFinite(denom) || denom === 0) return 0;
  return dot / denom;
}
