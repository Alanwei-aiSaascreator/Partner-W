import { closeSync, copyFileSync, existsSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs';
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

/**
 * ⭐ BUG-058②（2026-10-13 计划口径）：既有行的**目标本体**现在仍然有效吗。
 *
 * 为什么不能拿 `existsSync`（`rowFileExists`）当"重放命中"：登记行说的是"这份产物
 * 曾经写好并登记过"，而重放的语义是"它**现在**仍然是那份可交付的东西"。目标被外部
 * 改坏/截断时照单全收 = 拿坏文件冒充"已存在"（§9.4"目标被改坏"）。
 *
 * 判据（对**已保存的目标**，不是源）：
 *  - 可读：`stat` 到了、是文件；非受检格式再开一次句柄（真读权限）立即关；
 *  - 大小：行上记了 size（> 0）就必须与盘上一致；
 *  - 受检格式（pptx/docx/xlsx/pdf/mp4）：读字节过 `verifyArtifactBuffer`（与登记门同一份判据）；
 *  - 已有 SHA：`artifacts` 表当前没有 sha 列 —— 有列时在这里对（占位，不假记）。
 *
 * ⚠️ 读不动 / 太大 / 被判坏 ⇒ 一律 false（"确认仍有效才返回"；不伪成功）。
 */
function rowTargetIsIntact(row: ArtifactRow, fallbackPath: string): boolean {
  const filePath = typeof row.file_path === 'string' && row.file_path.length > 0 ? row.file_path : fallbackPath;
  if (!filePath) return false;
  let size: number;
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) return false;
    size = stat.size;
  } catch {
    return false;
  }
  const recorded = typeof row.size === 'number' && Number.isFinite(row.size) && row.size > 0 ? row.size : undefined;
  if (recorded !== undefined && recorded !== size) return false;
  const name = typeof row.name === 'string' && row.name.length > 0 ? row.name : filePath;
  if (isVerifiedFileName(name)) {
    let buffer: Buffer;
    try {
      buffer = readFileSync(filePath);
    } catch {
      return false;
    }
    return verifyArtifactBuffer(name, buffer).ok;
  }
  try {
    closeSync(openSync(filePath, 'r'));
    return true;
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
 * ⭐ T20（2026-10-16 本地全量执行 · Owner D）：**同 task + 同 source_key** 的既有行 ——
 * **跨 assistant 消息**的同源去重（登记的第三条口径）。
 *
 * 为什么必须补这一条：现场 `finish_reason` 续写会创建**新的 assistant 消息（新 messageId）**，
 * 同一套牌可能在两条消息里各出现一次。此时登记层的**两条唯一约束都不触发**：
 *   · `artifacts_source_dedup(message_id, source_key)` —— message_id 不同；
 *   · `artifacts_task_local_path(task_id, root, local_path)` —— `uniqueFileNameIn` **只看磁盘**，
 *     第一份文件还在 ⇒ 第二份退到 `<名>-<rand>.pptx` ⇒ local_path 不同。
 * ⇒ 同一套牌被登记两次、落两份文件（用户成果列表出现两份重复）。
 *
 * 语义边界：`source_key` 是**内容**键（docgen/slidegen 用「标题 + 版面源码哈希」算它），
 * 所以"同 task 同 source_key" == "同一份产物"；**改稿**产物源码不同 ⇒ source_key 不同 ⇒
 * 照常产新版，不受本口径影响（见 `artifact-cross-message-dedup.test.ts` 的保护面用例）。
 */
function rowForSourceInTask(sqlite: RawSqlite, taskId: string, sourceKey: string): ArtifactRow | undefined {
  return rawRow(
    sqlite,
    'SELECT * FROM artifacts WHERE task_id = ? AND source_key = ? ORDER BY created_at, rowid LIMIT 1',
    taskId,
    sourceKey,
  );
}

/**
 * ⭐ BUG-058②（2026-10-13）：保存路径的**只读**重放探测，必须在**读源字节之前**跑。
 *
 * 现场（slidegen-cli 落位路）：同 message + 同 sourceKey 的重放里，**源文件已被清理**，
 * 而旧顺序先做完整性门（`readFileSync(sourcePath)` ⇒ `ArtifactIntegrityError('unreadable')`）
 * ⇒ 本该返回既有行的重放把整轮报成 failed。
 *
 * 与 `settleExistingRows` 的关系（为什么另开一个，而不是把那个函数前移）：
 *  · 本函数**只读**（不删任何行）；`settleExistingRows` 会清陈旧行 —— 那是登记路径的
 *    事务动作，必须留在完整性门**之后**（坏新源不许借它清掉任何既有行）；
 *  · 命中口径 = 同 `task` + `message` + `sourceKey`，且**目标本体仍然有效**
 *    （见 `rowTargetIsIntact`）—— 目标缺/坏 ⇒ 不算命中，让完整性门如实报失败。
 */
function verifiedReplayArtifact(
  sqlite: RawSqlite,
  input: { taskId: string; sourceKey?: string; destPath: string },
): Artifact | null {
  if (!input.sourceKey) return null;
  const row = rowForSourceInTask(sqlite, input.taskId, input.sourceKey);
  if (!row) return null;
  return rowTargetIsIntact(row, input.destPath) ? artifactFromRow(row) : null;
}

/**
 * 重放探测（2026-10-12 视频接入）：同 message + sourceKey 已有行、且**目标本体仍然有效**
 * ⇒ 返回既有产物。
 *
 * 为什么单独开这个出口：视频的"生成"是**远端付费任务**。`saveArtifactFromBuffer` 自己的
 * 重放结算发生在**已经花完钱之后**——对 docgen 无所谓（本机渲染），对视频意味着
 * "同一份请求被处理两次 = 付两次费"。调用方（`main/videogen/generate.ts`）必须在
 * **创建远端任务之前**先调这里探测：非空 ⇒ 直接算已交付，一个请求都不发。
 *
 * 判据与 `settleExistingRows` 的 ① 逐字同款（同 message + 同 sourceKey + **目标本体
 * 仍然有效**），不复用那个函数是因为它同时会**删陈旧行**——那是登记路径的事务动作，
 * 探测必须只读。
 *
 * ⭐ BUG-058②（2026-10-13）：判据从 `existsSync` 收紧为 `rowTargetIsIntact`
 * （可读 / 大小 / 受检格式字节完整）—— 存坏了的 mp4 不算"已交付"（宁可真重生成，
 * 不给用户一个打不开的"已完成"）。
 */
export function findReplayArtifact(messageId: string, sourceKey: string): Artifact | null {
  const sqlite = getSqlite();
  if (!sqlite || !messageId || !sourceKey) return null;
  const row = rowForReplay(sqlite, messageId, sourceKey);
  if (!row) return null;
  return rowTargetIsIntact(row, '') ? artifactFromRow(row) : null;
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
 * ① 同 message + 同 sourceKey 有行、**目标本体仍然有效** ⇒ 重放 ⇒ 返回既有行；
 * ② 同 message + 同 sourceKey 有行、文件没了（或已改坏）⇒ 陈旧 ⇒ 删行，让这次的新文件顶上；
 * ③ 落点已有行、它的文件没了 ⇒ 陈旧（名字被"有行无文件"毒化）⇒ 删行再登记。
 *
 * ⭐ BUG-058②（2026-10-13）：① 的命中判据从 `existsSync` 收紧为 `rowTargetIsIntact`
 * —— "目标被改坏"的行不再算重放（不拿坏文件冒充"已存在"）。② 的"删陈旧行"动作
 * **位置不动**（必须在完整性门之后）：坏新源不许借它清掉任何既有行。
 */
function settleExistingRows(
  sqlite: RawSqlite,
  input: { taskId: string; sourceKey?: string; localPath: string; destPath: string },
): Artifact | null {
  const { taskId, sourceKey, localPath, destPath } = input;

  if (sourceKey) {
    // ⭐ T20：跨 assistant 消息的同源去重（同 task + 同 source_key）—— 见 `rowForSourceInTask`。
    const replay = rowForSourceInTask(sqlite, taskId, sourceKey);
    if (replay) {
      if (rowTargetIsIntact(replay, destPath)) return artifactFromRow(replay);
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
  input: { taskId: string; sourceKey?: string; localPath: string },
): Artifact | null {
  if (!isUniqueArtifactError(err)) return null;
  if (input.sourceKey) {
    // ⭐ T20：跨消息同源冲突也按 (task, source_key) 找赢家。
    const replay = rowForSourceInTask(sqlite, input.taskId, input.sourceKey);
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

  const localPath = `${taskId}/${finalName}`;
  const sqlite = getSqlite();
  if (!sqlite) throw new Error('database not ready');

  // ⭐ BUG-058②（2026-10-13）：**读源字节之前**先做只读重放探测（同 task/message/sourceKey +
  //    目标本体复核）。重放的源可能已被清理（slidegen-cli 落位路）——旧顺序先读源做完整性门，
  //    等于拿"源不在了"否掉一份**已经存好并且现在仍然有效**的产物，把整轮报成 failed。
  //    ⚠️ 只探测、不结算：会删陈旧行的 `settleExistingRows` 必须留在完整性门之后。
  const alreadySaved = verifiedReplayArtifact(sqlite, { taskId, sourceKey, destPath });
  if (alreadySaved) return alreadySaved;

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

  // ⚠️ 结算/取库在**写盘之前**：重放要在这里就返回（不写第二份），陈旧行也要在这里清掉
  //    （清完 `uniqueFileNameIn` 复用的那个名字才不会再撞库）。
  const db = getDb();
  const replay = settleExistingRows(sqlite, { taskId, sourceKey, localPath, destPath });
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
  // `'video'`（2026-10-17 BUG-120）：视频产物不再借 `'file'` 这一档。
  artifactType: 'code' | 'image' | 'file' | 'video';
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
  const replay = settleExistingRows(sqlite, { taskId, sourceKey, localPath, destPath });
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
