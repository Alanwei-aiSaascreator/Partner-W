/**
 * 资料库（T6a：存储 + 切片 + 状态机 + 降级）的领域类型。
 *
 * 这一层**刻意不依赖 Electron / Node / SQLite**：切片、状态机、混合排序都是纯函数，
 * 落库适配在 `packages/desktop/src/main/db/kb*.ts`。这样 U 盘索引这条链上的
 * 关键判定（哪些块要重嵌入、换模型后旧向量还能不能用）能在 core 里直接测。
 */

/** 一份"资料"的来源。 */
export type KbSourceKind = 'file' | 'artifact' | 'note';

/**
 * 切片状态机（设计 §三 / §五）：
 *
 * - `pending_embedding`：已切片、还没有向量（**没有嵌入引擎时的默认态**）
 * - `embedded`：有向量，且 `embeddingModel` 与当前引擎一致
 * - `stale`：曾经有向量，但嵌入模型换了 ⇒ 旧向量留着不删、检索时跳过，等重建
 *
 * 断点续做：`pending_embedding → embedded` 只在**整批成功**时发生；失败的批次
 * 保持原状态，下次从这些块接着做（已嵌好的不会重做，见 `embedPendingChunks`）。
 */
export const KB_CHUNK_STATES = ['pending_embedding', 'embedded', 'stale'] as const;

export type KbChunkState = (typeof KB_CHUNK_STATES)[number];

export function isKbChunkState(value: unknown): value is KbChunkState {
  return typeof value === 'string' && (KB_CHUNK_STATES as readonly string[]).includes(value);
}

/** 切片草案：切片器/重建产出的、准备落库的字段（还没有 id 与向量）。 */
export interface KbChunkDraft {
  /** 在所属资料内的序号，从 0 开始、连续。 */
  ordinal: number;
  /** 送模型 / 建索引 / 存库的最终文本（**含标题路径前缀**）。 */
  text: string;
  /** 粗略 token 估算（仅供花费预览；计费以 relay 回传的真实 usage 为准）。 */
  tokenEstimate: number;
}

/**
 * 参与状态机的最小切片形状。desktop 侧的 `KbChunkRow` 与它结构兼容，
 * 所以 store 读出来的行可以直接喂给 `embedPendingChunks` / `rankKbCandidates`。
 */
export interface KbEmbeddableChunk {
  id: string;
  ordinal: number;
  text: string;
  /** 已嵌入的向量（float32）；没有就是 `null`。 */
  vector: Float32Array | null;
  /** 生成该向量的模型名；没有就是 `null`。 */
  embeddingModel: string | null;
  state: KbChunkState;
}

export interface KbChunkingOptions {
  /** 目标块大小（**字符**数，中文按 1 字算）。设计口径 300–600 字。 */
  chunkSize?: number;
  /** 相邻块的重叠字符数（设计口径约 15%）。 */
  chunkOverlap?: number;
  /** 收尾块小于这个长度就并回上一块（避免出现几字宽的碎块）。 */
  minChunkSize?: number;
}
