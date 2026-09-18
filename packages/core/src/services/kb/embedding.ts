/**
 * 嵌入引擎的**可注入接口**。
 *
 * T6a 只定义形状 + 一条"未配置 ⇒ 全走 FTS"的默认路径（`engine = null`），
 * 真引擎（本地 ONNX / 走 relay 的 `/v1/embeddings`）留到 T6b —— 那时只要实现
 * 这个接口传进来即可，**流水线一行都不用改**。
 *
 * 约束（写进接口就是为了 T6b 别再想歪）：
 * - 引擎**只能**看到切片文本，看不到文件路径、工作区、会话（设计 §一：原文不出本机，
 *   只有"被命中的切片"随请求发给上游）；
 * - `embed` 抛错必须**可恢复**：调用方会保留已完成批次的进度、把剩下的块留在
 *   `pending_embedding`，下次接着做（离线/U 盘换机场景）。
 */

export interface EmbeddingEngine {
  /** 模型标识，写进 `kb_meta.embedding_model` 与每个块的 `kb_chunks.embedding_model`。 */
  readonly model: string;
  /** 向量维度（写进 `kb_meta.dim`，用于发现"模型换了但维度没变"之外的错配）。 */
  readonly dim: number;
  /**
   * 批量嵌入。返回数组与 `texts` **等长、同序**。
   * 实现方可以自行再分批，但对外必须是一次调用一次完整结果（要么全成功、要么抛错）。
   */
  embed(texts: readonly string[]): Promise<number[][]>;
}

/** 引擎是否可用（`null`/`undefined` ⇒ 未配置 ⇒ 纯关键词检索，这是**合法默认**，不是错误）。 */
export function isEmbeddingEngineReady(engine: EmbeddingEngine | null | undefined): engine is EmbeddingEngine {
  return engine != null && typeof engine.model === 'string' && engine.model.length > 0;
}
