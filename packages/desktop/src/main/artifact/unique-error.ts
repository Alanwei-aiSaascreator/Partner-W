/**
 * "唯一约束冲突"的**唯一**判据（2026-10-07）。
 *
 * ## 为什么必须集中在一处
 *
 * `artifacts` 表上有两条唯一索引，冲突都长成同一句话开头：
 *
 * - `artifacts_source_dedup(message_id, source_key)` —— 同一条消息里**同一份内容**被
 *   重放/重试（生成器链路、自动收编链路）。命中 = 第一次已经存好了。
 * - `artifacts_task_local_path(task_id, root, local_path)` —— 同名落点已有行
 *   （磁盘文件被外部删掉后名字被复用、并发登记）。命中 = 这个落点已经有一行。
 *
 * 两种含义最终都归到同一句："**它已经存在**"。调用方据此**返回既有行**，
 * 而不是当成失败（旧实现会删掉刚写好的文件再报错 —— 重试必然同败，见 2026-10-07 体检 P2-2/P2-4）。
 *
 * ⚠️ 判据是**前缀**（`artifacts.`）不是整句：两条索引的列清单不同，而 `better-sqlite3`
 *    的错误文本会把列名逐字拼进去（`UNIQUE constraint failed: artifacts.task_id, artifacts.root, …`）。
 */
export function isUniqueArtifactError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('UNIQUE constraint failed: artifacts.');
}
