/**
 * 长期记忆的**本地检索**（T27，2026-10-16）。
 *
 * ## 它解决的是什么
 *
 * 记忆的召回通道是每个助手工作区的 `MEMORY.md` 受管区块，运行时**每轮全文注入**。
 * 条目少的时候"全量注入"就是最好的策略 —— 简单、可预测、不会因为某次措辞不同而漏掉。
 * 但条目多起来以后，**固定的前 N 条**（或"按写入顺序截断"）会让排在后面的记忆
 * 永远进不了提示词：用户明明"记住了"，实际却从没被读到 —— 那是表面成功，本项目
 * 完成语义红线明确禁止。
 *
 * 所以这里的策略是：**条目超出注入预算时，按当前这句提问选相关的那批**。
 * 换一个问法 ⇒ 选中的集合随之变化（这是它与"固定截断"唯一可观测的区别）。
 *
 * ## 边界（如实说明，别当成比它更多的东西）
 *
 * - **纯本地、纯字符串**：没有向量、没有嵌入、没有外部服务、没有新存储。
 *   中英混排的**分词 + 重叠打分**，确定性（同输入同输出，顺序稳定）。
 * - **它只在"超出注入预算"时才改变行为**：条目数 ≤ `MEMORY_RECALL_TOP_N` 时
 *   `selectMemoriesForQuery` **原样返回入参**（连顺序都不动）⇒ 少条目的用户
 *   行为一字不变，也不会多付一次网关往返。
 * - 打分不中（分数全 0）时**不是丢弃**：余下的名额仍按原顺序补满 —— 检索改变的是
 *   "谁排在前面/谁进得来"，不是"把不相关的记忆删掉"。
 */

/** 每轮注入的记忆条数上限。条目 ≤ 它时全量注入（行为与从前完全一致）。 */
export const MEMORY_RECALL_TOP_N = 20;

/** 一段文本 → 检索用的词元（拉丁词 + 中日韩二元组）。 */
export function memoryQueryTokens(text: string): string[] {
  const value = String(text ?? '').toLowerCase();
  const tokens: string[] = [];
  for (const match of value.matchAll(/[a-z0-9]+/g)) {
    if (match[0].length >= 2) tokens.push(match[0]);
  }
  // CJK：只靠"整句包含"太粗（中文没有空格），二元组足够稳且线性。
  const cjk = value.replace(/[^㐀-䶿一-鿿぀-ヿ가-힯]/g, '\u0000');
  for (const run of cjk.split('\u0000')) {
    for (let i = 0; i + 1 < run.length; i += 1) tokens.push(run.slice(i, i + 2));
    if (run.length === 1) tokens.push(run);
  }
  return tokens;
}

/**
 * 一条记忆对一句提问的相关度。**确定性**：只依赖两个字符串本身。
 *
 * 组成：① 整句互相包含（最强信号）② 词元重叠计数 ③ 命中率（命中的词元 / 提问词元数）
 * ④ 短条目优先（同样命中时，短的那条更"专指"）。
 */
export function scoreMemoryEntry(text: string, query: string): number {
  const entry = String(text ?? '').toLowerCase();
  const ask = String(query ?? '')
    .toLowerCase()
    .trim();
  if (!entry) return 0;
  if (!ask) return 0;
  let score = 0;
  if (entry.includes(ask)) score += 1000;
  else if (ask.includes(entry) && entry.length >= 2) score += 600;
  const queryTokens = memoryQueryTokens(ask);
  if (queryTokens.length > 0) {
    const unique = [...new Set(queryTokens)];
    let hits = 0;
    for (const token of unique) {
      if (entry.includes(token)) hits += 1;
    }
    score += hits * 10;
    score += (hits / unique.length) * 20;
  }
  // 短条目更专指：同等命中下排前（用长度做很轻的惩罚，不喧宾夺主）。
  score -= Math.min(entry.length, 200) / 1000;
  return score;
}

/**
 * 选出本轮要注入的条目。
 *
 * - `entries.length <= limit` ⇒ **原样返回**（含顺序）—— 少条目的用户行为不变。
 * - 否则：按 相关度 ↓、原顺序 ↑ 排序后取前 `limit` 条；
 *   相关度全为 0 时退化成"按原顺序取前 limit 条"（不丢覆盖，只是不再全量）。
 * - 提问为空 ⇒ 同样按原顺序取前 `limit` 条（没有提问时"顺序"是唯一公平的判据）。
 */
export function selectMemoriesForQuery<T extends { text: string }>(
  entries: readonly T[],
  query: string,
  limit: number = MEMORY_RECALL_TOP_N,
): T[] {
  if (entries.length <= limit) return [...entries];
  if (!String(query ?? '').trim()) return entries.slice(0, limit);
  return entries
    .map((entry, index) => ({ entry, index, score: scoreMemoryEntry(entry.text, query) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((row) => row.entry);
}
