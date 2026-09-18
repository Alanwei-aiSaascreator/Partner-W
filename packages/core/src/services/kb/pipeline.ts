import { estimateTokens, splitText } from './chunking.js';
import type { EmbeddingEngine } from './embedding.js';
import type { KbChunkDraft, KbChunkingOptions, KbEmbeddableChunk } from './types.js';

/**
 * 索引流水线的**纯逻辑**部分：切片 → 状态机 → 分批嵌入（断点续做）。
 *
 * 落库、事务、FTS 在 desktop 侧；这里不碰 IO，所以"哪些块该重嵌""换模型后旧向量
 * 还能不能用"这些判定可以脱离 Electron/SQLite 直接测。
 */

export const DEFAULT_EMBED_BATCH_SIZE = 16;

/** 一份资料的正文 → 切片草案（全部处于"还没有向量"的状态）。 */
export function buildChunkDrafts(text: string, options: KbChunkingOptions = {}): KbChunkDraft[] {
  return splitText(text, options).map((chunk) => ({
    ordinal: chunk.ordinal,
    text: chunk.text,
    tokenEstimate: estimateTokens(chunk.text),
  }));
}

/**
 * 这个块现在需不需要（重新）嵌入？
 *
 * - `model` 为 `null`（未配置引擎 / 离线）⇒ **永远 false**：没有引擎时全走 FTS，
 *   块老老实实待在 `pending_embedding`，联网后再做（不产生任何"假装成功"的向量）。
 * - `pending_embedding` / `stale` ⇒ true。
 * - `embedded` 但 `embeddingModel` 与当前模型不一致 ⇒ true（换模型的兜底判定；
 *   正常路径下 store 已经把这类块标成 `stale` 了）。
 */
export function chunkNeedsEmbedding(chunk: KbEmbeddableChunk, model: string | null): boolean {
  if (!model) return false;
  if (chunk.state !== 'embedded') return true;
  return chunk.embeddingModel !== model;
}

/**
 * 换嵌入模型：把"用别的模型嵌过"的块标成 `stale`。
 *
 * **向量保留**（不删）—— 设计 §二：模型不一致的切片检索时跳过并在界面提示"需要重建"。
 * 保留的好处是用户切回原模型时不用重花积分。
 * `model` 为 `null`（引擎被摘掉）时**什么都不做**：那不是"换了模型"，只是暂时没引擎。
 */
export function markStaleChunks(chunks: readonly KbEmbeddableChunk[], model: string | null): KbEmbeddableChunk[] {
  if (!model) return [];
  return chunks
    .filter((chunk) => chunk.state === 'embedded' && chunk.embeddingModel !== null && chunk.embeddingModel !== model)
    .map((chunk) => ({ ...chunk, state: 'stale' as const }));
}

export interface EmbedPendingOptions {
  /** 每次调用引擎的块数（U 盘上写库是批量事务，网络上是单次请求体量）。 */
  batchSize?: number;
}

export interface EmbedPendingResult {
  /** 输入的全部块（顺序不变）：嵌成功的已带向量，失败/未轮到的保持原样。 */
  chunks: KbEmbeddableChunk[];
  /** 实际发给引擎的块数（含失败那一批）。 */
  attempted: number;
  /** 成功写入向量的块数。 */
  embedded: number;
  /** 失败的块数（`attempted - embedded`）。 */
  failed: number;
  /** 首个错误；没有失败时为 `null`。 */
  error: { message: string } | null;
}

function toFloat32(values: readonly number[]): Float32Array {
  const vector = new Float32Array(values.length);
  for (let index = 0; index < values.length; index += 1) vector[index] = Number(values[index]);
  return vector;
}

function validateBatch(vectors: number[][] | undefined, expected: number, dim: number): number[][] {
  if (!Array.isArray(vectors) || vectors.length !== expected) {
    throw new Error(
      `嵌入引擎返回的向量条数不对：期望 ${expected}，实际 ${Array.isArray(vectors) ? vectors.length : '非数组'}`,
    );
  }
  for (const vector of vectors) {
    if (!Array.isArray(vector) || vector.length !== dim) {
      throw new Error(
        `嵌入引擎返回的向量维度不对：期望 ${dim}，实际 ${Array.isArray(vector) ? vector.length : '非数组'}`,
      );
    }
  }
  return vectors;
}

/**
 * 把还需要向量的块分批嵌入。**断点续做**的关键：
 *
 * - 已嵌好（`embedded` 且模型一致）的块根本不会进 `targets`，所以"接着做"不会重头再来；
 * - 某一批抛错 ⇒ **立刻停**（离线时后面几批必定也失败，没必要空转），但已完成批次的
 *   结果照常返回给调用方落库；
 * - 引擎返回条数/维度不对 ⇒ 当成同一类失败处理（宁可留着 pending，也不写脏向量）。
 */
export async function embedPendingChunks(
  chunks: readonly KbEmbeddableChunk[],
  engine: EmbeddingEngine,
  options: EmbedPendingOptions = {},
): Promise<EmbedPendingResult> {
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? DEFAULT_EMBED_BATCH_SIZE));
  const next: KbEmbeddableChunk[] = chunks.map((chunk) => ({ ...chunk }));
  const targets = next.filter((chunk) => chunkNeedsEmbedding(chunk, engine.model));

  let attempted = 0;
  let embedded = 0;
  let error: { message: string } | null = null;

  for (let start = 0; start < targets.length; start += batchSize) {
    const batch = targets.slice(start, start + batchSize);
    attempted += batch.length;
    try {
      const vectors = validateBatch(await engine.embed(batch.map((chunk) => chunk.text)), batch.length, engine.dim);
      batch.forEach((chunk, index) => {
        chunk.vector = toFloat32(vectors[index]);
        chunk.embeddingModel = engine.model;
        chunk.state = 'embedded';
      });
      embedded += batch.length;
    } catch (cause) {
      error = { message: cause instanceof Error ? cause.message : String(cause) };
      break;
    }
  }

  return { chunks: next, attempted, embedded, failed: attempted - embedded, error };
}
