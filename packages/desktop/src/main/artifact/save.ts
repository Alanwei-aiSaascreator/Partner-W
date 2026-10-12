import { copyFileSync, existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { basename, extname, resolve, sep } from 'path';
import { randomUUID } from 'crypto';
import type { Artifact } from '@clawwork/shared';
import { getDb, getSqlite } from '../db/index.js';
import { artifacts } from '../db/schema.js';
import { ensureTaskDir } from '../workspace/init.js';
import { uniqueFileNameIn } from '../workspace/safe-name.js';
import { artifactFromRow } from './row.js';
import { isUniqueArtifactError } from './unique-error.js';
import { ArtifactIntegrityError, isVerifiedFileName, verifyArtifactBuffer } from './verify.js';

const MIME_MAP: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.md': 'text/markdown',
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.js': 'text/javascript',
  '.jsx': 'text/javascript',
  '.json': 'application/json',
  '.html': 'text/html',
  '.css': 'text/css',
  '.txt': 'text/plain',
  '.pdf': 'application/pdf',
  // ⚠️ Office 那几个必须和 `artifact/reconcile.ts` 的表**一致**：那边有 .pptx，
  //    这边原来没有 ⇒ 同一份 pptx 走不同路径进产物会得到两种 MIME
  //    （这边落成 application/octet-stream，界面就没法当文档处理）。
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip',
};

function detectMimeType(fileName: string): string {
  const ext = extname(fileName).toLowerCase();
  return MIME_MAP[ext] ?? 'application/octet-stream';
}

/**
 * 产物最终叫什么、落在哪。
 *
 * ⭐ 2026-09-25：**撞名才改名**（`uniqueFileNameIn`）—— 原来无条件拼 `-<8位随机>`，
 * 于是助手生成的那份报告在产物面板里叫 `内测汇报-3f9c2a1b.pptx`。
 * "同一任务目录里永不覆盖"这条不变式不变：目录里已有同名文件时照样退到带后缀的名字。
 */
function resolveArtifactDestination(taskDir: string, fileName: string): { destPath: string; finalName: string } {
  const finalName = uniqueFileNameIn(taskDir, fileName);
  const resolvedTaskDir = resolve(taskDir);
  const destPath = resolve(taskDir, finalName);

  if (!destPath.startsWith(`${resolvedTaskDir}${sep}`)) {
    throw new Error('artifact path escapes task dir');
  }

  return { destPath, finalName };
}

interface SaveArtifactParams {
  workspacePath: string;
  taskId: string;
  messageId: string;
  sourcePath: string;
  fileName?: string;
  mediaType?: string;
  sourceKey?: string;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 登记的唯一约束语义（2026-10-07 体检 P2-2 / P2-4）
 *
 * `artifacts` 表上有两条唯一索引（见 `db/index.ts` 的迁移）：
 *   · `artifacts_source_dedup(message_id, source_key)` —— 同一条消息里**同一份内容**
 *     重放/重试（三条生成器链路 + 自动收编链路就是这么进来的）；
 *   · `artifacts_task_local_path(task_id, root, local_path)` —— 同一个落点已有行。
 *
 * 旧实现两条都只会"删掉刚写好的文件再抛错"，于是：
 *   · docgen/slidegen/htmlgen 把**已经生成成功**的第二次处理报成"生成失败"；
 *   · `uniqueFileNameIn` 只查磁盘不查库 ⇒ 磁盘文件被外部删掉后名字被复用 ⇒ 必撞
 *     `task_local_path` ⇒ 刚写的好文件被 unlink ⇒ 这个名字被**永久毒化**（重试必同败）。
 *
 * 现在的口径：**唯一约束 = "它已经存在"**，登记前先结算（重放直接返回既有行），
 * 真出现竞态冲突也返回赢家行、**不删刚写的新文件**；只有"找不到赢家"的其它 DB 故障
 * 才回落到原来的"删文件 + 抛错"。
 * ──────────────────────────────────────────────────────────────────────────── */

type ArtifactDb = ReturnType<typeof getDb>;
type RawSqlite = NonNullable<ReturnType<typeof getSqlite>>;
type ArtifactRow = Record<string, unknown>;

/**
 * 既有行的读取用**原始 SQLite**（不是 drizzle 的 `db.select()`）。
 *
 * ⚠️ 这不是口味问题：drizzle 的 `.select()` 返回的是 **camelCase** 属性
 *    （`localPath` / `filePath` / `sourceKey`），而 `artifactFromRow`（与 reconcile 共用的
 *    那一份行 → 领域对象映射）吃的是**表的原始列名**（`local_path` / `file_path`）。
 *    混着用会把 `local_path` 读成 `undefined` —— 探针里当场就抓到了（返回的行 localPath
 *    是字符串 `"undefined"`）。原始行也正好与 reconcile 的清行/查询口径逐字一致。
 */
function rawRow(sqlite: RawSqlite, sql: string, ...params: unknown[]): ArtifactRow | undefined {
  return sqlite.prepare(sql).get(...params) as ArtifactRow | undefined;
}

/** 这一行的文件现在还在盘上吗？（`file_path` 为空的老行按本次落点判） */
function rowFileExists(row: ArtifactRow, fallbackPath: string): boolean {
  const filePath = typeof row.file_path === 'string' && row.file_path.length > 0 ? row.file_path : fallbackPath;
  try {
    return existsSync(filePath);
  } catch {
    return false;
  }
}

/** 同一 (message_id, source_key) 的既有行：`artifacts_source_dedup` 的语义。 */
function rowForReplay(sqlite: RawSqlite, messageId: string, sourceKey: string): ArtifactRow | undefined {
  return rawRow(
    sqlite,
    'SELECT * FROM artifacts WHERE message_id = ? AND source_key = ? LIMIT 1',
    messageId,
    sourceKey,
  );
}

/**
 * 重放探测（2026-10-12 视频接入）：同 message + sourceKey 已有行、且文件还在盘上 ⇒ 返回既有产物。
 *
 * 为什么单独开这个出口：视频的"生成"是**远端付费任务**。`saveArtifactFromBuffer` 自己的
 * 重放结算发生在**已经花完钱之后**——对 docgen 无所谓（本机渲染），对视频意味着
 * "同一份请求被处理两次 = 付两次费"。调用方（`main/videogen/generate.ts`）必须在
 * **创建远端任务之前**先调这里探测：非空 ⇒ 直接算已交付，一个请求都不发。
 *
 * 判据与 `settleExistingRows` 的 ① 逐字同款（同 message + 同 sourceKey + 文件在盘），
 * 不复用那个函数是因为它同时会**删陈旧行**——那是登记路径的事务动作，探测必须只读。
 */
export function findReplayArtifact(messageId: string, sourceKey: string): Artifact | null {
  const sqlite = getSqlite();
  if (!sqlite || !messageId || !sourceKey) return null;
  const row = rowForReplay(sqlite, messageId, sourceKey);
  if (!row) return null;
  return rowFileExists(row, '') ? artifactFromRow(row) : null;
}

/** 同一 (task_id, root, local_path) 的既有行：`artifacts_task_local_path` 的语义。 */
function rowForLocalPath(sqlite: RawSqlite, taskId: string, localPath: string): ArtifactRow | undefined {
  return rawRow(
    sqlite,
    'SELECT * FROM artifacts WHERE task_id = ? AND root = ? AND local_path = ? LIMIT 1',
    taskId,
    'workspace',
    localPath,
  );
}

/**
 * 删掉一行**陈旧登记**。
 *
 * ⚠️ 按 `id + source_key` 双击复核（与 `reconcile.ts` 清行同一个口径）：并发那趟如果已经
 *    把它换成新登记，这里必须一个字节都不动 —— 按 (task_id, root, local_path) 删会误伤新行。
 */
function deleteRowById(sqlite: RawSqlite, row: ArtifactRow): void {
  sqlite
    .prepare('DELETE FROM artifacts WHERE id = ? AND source_key = ?')
    .run(String(row.id), String(row.source_key ?? ''));
}

/**
 * 登记前的"既有行结算"。返回非空 = 这次**不需要写盘**（重放：内容已经存好了）。
 *
 * 规则（三条，都在写盘之前跑，所以判断的是"旧行自己的文件还在不在"）：
 * ① 同 message + 同 sourceKey 有行、文件还在 ⇒ 重放 ⇒ 返回既有行；
 * ② 同 message + 同 sourceKey 有行、文件没了 ⇒ 陈旧 ⇒ 删行，让这次的新文件顶上；
 * ③ 落点已有行、它的文件没了 ⇒ 陈旧（名字被"有行无文件"毒化）⇒ 删行再登记。
 */
function settleExistingRows(
  sqlite: RawSqlite,
  input: { taskId: string; messageId: string; sourceKey?: string; localPath: string; destPath: string },
): Artifact | null {
  const { taskId, messageId, sourceKey, localPath, destPath } = input;

  if (sourceKey) {
    const replay = rowForReplay(sqlite, messageId, sourceKey);
    if (replay) {
      if (rowFileExists(replay, destPath)) return artifactFromRow(replay);
      deleteRowById(sqlite, replay);
    }
  }

  const occupied = rowForLocalPath(sqlite, taskId, localPath);
  if (occupied && !rowFileExists(occupied, destPath)) deleteRowById(sqlite, occupied);
  return null;
}

/**
 * INSERT 撞唯一约束 ⇒ 找"赢家"行返回（**不删刚写的新文件**）。
 * 找不到赢家（理论上不该发生）⇒ `null`，调用方回落到"删文件 + 抛错"的旧语义。
 */
function resolveInsertConflict(
  sqlite: RawSqlite,
  err: unknown,
  input: { taskId: string; messageId: string; sourceKey?: string; localPath: string },
): Artifact | null {
  if (!isUniqueArtifactError(err)) return null;
  if (input.sourceKey) {
    const replay = rowForReplay(sqlite, input.messageId, input.sourceKey);
    if (replay) return artifactFromRow(replay);
  }
  const occupied = rowForLocalPath(sqlite, input.taskId, input.localPath);
  return occupied ? artifactFromRow(occupied) : null;
}

/** 写盘之后的登记：成功返回新行；冲突返回赢家行；其余故障删掉刚写的文件并抛。 */
function persistArtifactRow(
  db: ArtifactDb,
  sqlite: RawSqlite,
  artifact: Artifact,
  input: { taskId: string; messageId: string; sourceKey?: string; localPath: string; destPath: string },
): Artifact {
  try {
    db.insert(artifacts)
      .values({
        id: artifact.id,
        taskId: artifact.taskId,
        messageId: artifact.messageId,
        type: artifact.type,
        name: artifact.name,
        filePath: artifact.filePath,
        localPath: artifact.localPath,
        mimeType: artifact.mimeType,
        size: artifact.size,
        sourceKey: artifact.sourceKey ?? '',
        contentText: artifact.contentText ?? '',
        createdAt: artifact.createdAt,
      })
      .run();
    return artifact;
  } catch (err) {
    const winner = resolveInsertConflict(sqlite, err, input);
    if (winner) return winner;
    try {
      unlinkSync(input.destPath);
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
}

export async function saveArtifact(params: SaveArtifactParams): Promise<Artifact> {
  const { workspacePath, taskId, messageId, sourcePath, fileName, mediaType, sourceKey } = params;

  const taskDir = ensureTaskDir(workspacePath, taskId);
  const originalName = fileName ?? basename(sourcePath);
  const { finalName, destPath } = resolveArtifactDestination(taskDir, originalName);

  // M1 登记前置门（2026-10-06）：坏 PPTX / DOCX **不复制、不登记**。与"DB 失败回滚"同一段时间线：
  // 出错时任务目录里不留半成品（这里连复制都还没发生，天然无残留）。
  if (isVerifiedFileName(finalName)) {
    let buffer: Buffer;
    try {
      buffer = readFileSync(sourcePath);
    } catch {
      throw new ArtifactIntegrityError('unreadable');
    }
    const integrity = verifyArtifactBuffer(finalName, buffer);
    if (!integrity.ok) throw new ArtifactIntegrityError(integrity.reason);
  }

  const localPath = `${taskId}/${finalName}`;
  // ⚠️ 结算/取库在**写盘之前**：重放要在这里就返回（不写第二份），陈旧行也要在这里清掉
  //    （清完 `uniqueFileNameIn` 复用的那个名字才不会再撞库）。
  const sqlite = getSqlite();
  if (!sqlite) throw new Error('database not ready');
  const db = getDb();
  const replay = settleExistingRows(sqlite, { taskId, messageId, sourceKey, localPath, destPath });
  if (replay) return replay;

  copyFileSync(sourcePath, destPath);

  const stat = statSync(destPath);
  const mimeType = mediaType ?? detectMimeType(finalName);
  const now = new Date().toISOString();
  const id = randomUUID();

  const artifact: Artifact = {
    id,
    taskId,
    messageId,
    type: 'file',
    name: finalName,
    // `filePath` 对外是“这份成品现在在哪”，不是一个可能已被清掉的临时源文件。
    filePath: destPath,
    localPath,
    mimeType,
    size: stat.size,
    sourceKey: sourceKey ?? '',
    createdAt: now,
    availability: 'available',
  };

  return persistArtifactRow(db, sqlite, artifact, { taskId, messageId, sourceKey, localPath, destPath });
}

interface SaveArtifactFromBufferParams {
  workspacePath: string;
  taskId: string;
  messageId: string;
  fileName: string;
  buffer: Buffer;
  artifactType: 'code' | 'image' | 'file';
  contentText?: string;
  sourceKey?: string;
}

export async function saveArtifactFromBuffer(params: SaveArtifactFromBufferParams): Promise<Artifact> {
  const { workspacePath, taskId, messageId, fileName, buffer, artifactType, contentText, sourceKey } = params;

  const taskDir = ensureTaskDir(workspacePath, taskId);
  const { finalName, destPath } = resolveArtifactDestination(taskDir, fileName);

  // M1 登记前置门（2026-10-06）：坏 PPTX / DOCX **不落盘、不登记**——校验内存 buffer，写之前拦下。
  if (isVerifiedFileName(finalName)) {
    const integrity = verifyArtifactBuffer(finalName, buffer);
    if (!integrity.ok) throw new ArtifactIntegrityError(integrity.reason);
  }

  const localPath = `${taskId}/${finalName}`;
  const sqlite = getSqlite();
  if (!sqlite) throw new Error('database not ready');
  const db = getDb();
  const replay = settleExistingRows(sqlite, { taskId, messageId, sourceKey, localPath, destPath });
  if (replay) return replay;

  writeFileSync(destPath, buffer);

  const mimeType = detectMimeType(finalName);
  const now = new Date().toISOString();
  const id = randomUUID();

  const artifact: Artifact = {
    id,
    taskId,
    messageId,
    type: artifactType,
    name: finalName,
    filePath: destPath,
    localPath,
    mimeType,
    size: buffer.length,
    sourceKey: sourceKey ?? '',
    contentText: contentText ?? '',
    createdAt: now,
    availability: 'available',
  };

  return persistArtifactRow(db, sqlite, artifact, { taskId, messageId, sourceKey, localPath, destPath });
}
