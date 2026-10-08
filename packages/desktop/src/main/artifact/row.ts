import type { Artifact, ArtifactRootKind } from '@clawwork/shared';

/**
 * 行上的 `root` → 领域值。
 *
 * ⚠️ **白名单**（而不是 `row.root ?? 'workspace'`）：`artifacts` 表里可能躺着历史脏值，
 *    认不出的一律归 `'workspace'`（= 加这一列之前的行为）。
 * ⚠️ 每加一个根**必须在这里放行**（第三个根 `'workspace-root'`，2026-10-07）：漏改的方向
 *    不是"少一条"，是**读回时降级成 `'workspace'`** ⇒ 应用根那趟把根层的行当成自己的
 *    ⇒ `local_path` 前缀对不上 ⇒ 整批判 `missing` ⇒ 界面上一片红。
 */
function artifactRootKind(value: unknown): ArtifactRootKind {
  return value === 'agent' || value === 'workspace-root' ? value : 'workspace';
}

/**
 * `artifacts` 表的行 → 领域对象（`Artifact`）。
 *
 * ## 为什么单独一个模块（2026-10-07）
 *
 * 原来只有 `reconcile.ts` 有一份（收编扫描用）。`save.ts` 的"重放/冲突 ⇒ 返回既有行"
 * 也需要它 —— 两份实现只差一行 `root` 归一，而那一行恰恰是**不能走偏**的那行。
 * 合并到这里，两个调用点共用同一口径。
 *
 * ⚠️ `availability` 恒为 `'available'`：它描述的是"登记那一刻文件在盘上"，不是展示层的
 *    实时判定 —— 实时判定由 `getArtifactAvailability` / `artifact:list` 负责。
 */
export function artifactFromRow(row: Record<string, unknown>): Artifact {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    messageId: String(row.message_id),
    type: String(row.type) as Artifact['type'],
    name: String(row.name),
    filePath: String(row.file_path),
    localPath: String(row.local_path),
    // ⚠️ 只认已登记的根，其余（含老行的 `'workspace'` 与任何脏值）一律归 `'workspace'` ——
    //    与 `Artifact.root` 是可选字段、缺省即老行为**同一个方向**。见 `artifactRootKind`。
    root: artifactRootKind(row.root),
    mimeType: String(row.mime_type),
    size: Number(row.size),
    sourceKey: String(row.source_key),
    contentText: String(row.content_text),
    createdAt: String(row.created_at),
    availability: 'available',
  };
}
