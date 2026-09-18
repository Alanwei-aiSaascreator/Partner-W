import { cosineSimilarity } from './vectors.js';
import type { KbChunkState, KbSourceKind } from './types.js';

/**
 * 混合排序：关键词（FTS5 bm25）× 向量余弦。
 *
 * ⚠️ 这里**只做排序**，不做召回：候选集是 store 用 FTS5 捞出来的。所以"没网/没引擎"
 *    时候选集照样有（关键词命中），排序退化成纯关键词序 —— 这就是设计 §五那条
 *    "断网自动降级为纯 FTS 关键词检索，仍可用"。纯向量召回（语义相近但关键词不沾边）
 *    要等 T6c，届时这里的入参多一路候选即可，本函数不用改。
 *
 * ⚠️ 设计 §二说"`embedding_model` 与当前模型不一致的切片，检索时跳过"——这里跳过的是
 *    它的**向量**（`vectorUsed=false`），不是这一块本身：正文与关键词命中都不依赖嵌入
 *    模型，把整块丢掉只会让"换了模型但还没重建"直接检索不到东西，与 §五的降级原则相悖。
 *
 * ⚠️ "一致"是**模型名 + 维度**两条：同名换维（`{model:'x',dim:4}` → `{model:'x',dim:8}`）
 *    的旧向量不能算可用（详见 `isVectorUsable`）。
 */

export interface KbSearchCandidate {
  chunkId: string;
  sourceId: string;
  ordinal: number;
  /** 切片全文（含标题前缀）。 */
  text: string;
  /** FTS5 高亮片段（`<<`/`>>` 包裹）。 */
  snippet: string;
  /** 关键词得分，**越大越相关**（store 侧已把 bm25 取负）。 */
  keywordScore: number;
  vector: Float32Array | null;
  embeddingModel: string | null;
  state: KbChunkState;
  // 引用可回溯（设计 §六之一）要用的来源信息：没有它，命中结果没法显示"来自哪份资料"，
  // 也没法点回原文。放在这里是因为"一条不带出处的命中"本身就没用。
  sourceKind: KbSourceKind;
  sourceTitle: string;
  sourcePath: string;
}

export interface KbSearchHit {
  chunkId: string;
  sourceId: string;
  ordinal: number;
  text: string;
  snippet: string;
  sourceKind: KbSourceKind;
  sourceTitle: string;
  sourcePath: string;
  /** 混合后的得分，[0,1]。 */
  score: number;
  keywordScore: number;
  /** 余弦（负值被夹到 0）；没用上向量时为 0。 */
  vectorScore: number;
  /** 这个块的向量到底参与排序了吗（模型不一致/没有向量/没查询向量 ⇒ false）。 */
  vectorUsed: boolean;
  state: KbChunkState;
}

export interface KbRankOptions {
  /** 查询向量；`null`/缺省 ⇒ 纯关键词。 */
  queryVector?: Float32Array | null;
  /** 当前生效的嵌入模型：只有用它嵌出来的向量才参与排序。 */
  activeModel?: string | null;
  limit?: number;
  keywordWeight?: number;
  vectorWeight?: number;
}

export interface KbRankResult {
  hits: KbSearchHit[];
  /** `hybrid` = 至少有一个块的向量真的参与了排序；否则是 `keyword`（降级）。 */
  mode: 'keyword' | 'hybrid';
}

export const DEFAULT_KB_LIMIT = 10;
export const DEFAULT_KEYWORD_WEIGHT = 0.4;
export const DEFAULT_VECTOR_WEIGHT = 0.6;

function isVectorUsable(
  candidate: KbSearchCandidate,
  queryVector: Float32Array | null,
  activeModel: string | null,
): boolean {
  if (!queryVector || !candidate.vector) return false;
  if (candidate.state !== 'embedded') return false;
  // **维度也要一致**：模型名相同、维度却变了（同名换维）时，旧向量与新查询向量根本不是
  // 同一个空间里的东西。不判这一条的话，余弦那边只会算出 0（`vectors.ts` 对维度不符返 0），
  // 排序上"用了个寂寞"，而 `vectorUsed` 仍是 true ⇒ `mode='hybrid'`、`degraded=false` ——
  // 界面看到的是"一切正常"，既不会提示需要重建，也永远发现不了旧向量是错的。
  // 判掉它就自动退成 keyword 降级，调用方据此提示"切了维度，需要重建索引"。
  if (candidate.vector.length !== queryVector.length) return false;
  return candidate.embeddingModel !== null && candidate.embeddingModel === activeModel;
}

export function rankKbCandidates(candidates: readonly KbSearchCandidate[], options: KbRankOptions = {}): KbRankResult {
  const limit = Math.max(0, Math.floor(options.limit ?? DEFAULT_KB_LIMIT));
  const keywordWeight = Math.max(0, options.keywordWeight ?? DEFAULT_KEYWORD_WEIGHT);
  const vectorWeight = Math.max(0, options.vectorWeight ?? DEFAULT_VECTOR_WEIGHT);
  const weightSum = keywordWeight + vectorWeight || 1;
  const queryVector = options.queryVector ?? null;
  const activeModel = options.activeModel ?? null;

  const maxKeyword = candidates.reduce((max, candidate) => Math.max(max, candidate.keywordScore), 0);

  let vectorHits = 0;
  const scored = candidates.map((candidate) => {
    const keywordPart = maxKeyword > 0 ? Math.max(0, candidate.keywordScore) / maxKeyword : 0;
    const usable = isVectorUsable(candidate, queryVector, activeModel);
    const vectorPart = usable
      ? Math.max(0, cosineSimilarity(queryVector as Float32Array, candidate.vector as Float32Array))
      : 0;
    if (usable) vectorHits += 1;
    return {
      hit: {
        chunkId: candidate.chunkId,
        sourceId: candidate.sourceId,
        ordinal: candidate.ordinal,
        text: candidate.text,
        snippet: candidate.snippet,
        sourceKind: candidate.sourceKind,
        sourceTitle: candidate.sourceTitle,
        sourcePath: candidate.sourcePath,
        keywordScore: candidate.keywordScore,
        vectorScore: vectorPart,
        vectorUsed: usable,
        state: candidate.state,
        score: (keywordWeight * keywordPart + vectorWeight * vectorPart) / weightSum,
      } satisfies KbSearchHit,
      keywordScore: candidate.keywordScore,
    };
  });

  scored.sort((left, right) => {
    if (right.hit.score !== left.hit.score) return right.hit.score - left.hit.score;
    if (right.keywordScore !== left.keywordScore) return right.keywordScore - left.keywordScore;
    // ⚠️ 先比 `ordinal`、**再**比 `chunkId`：切片 id 里的序号是 `padStart(4)`，
    //    ≥ 10000 的块字典序会排到 9999 前面（同一份资料内就乱了）。id 只做最后兜底。
    if (left.hit.ordinal !== right.hit.ordinal) return left.hit.ordinal - right.hit.ordinal;
    return left.hit.chunkId < right.hit.chunkId ? -1 : left.hit.chunkId > right.hit.chunkId ? 1 : 0;
  });

  return {
    hits: scored.slice(0, limit).map((entry) => entry.hit),
    mode: vectorHits > 0 ? 'hybrid' : 'keyword',
  };
}
