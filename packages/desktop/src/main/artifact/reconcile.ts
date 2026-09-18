import { randomUUID } from 'node:crypto';
import type { BigIntStats, Dirent } from 'node:fs';
import { hasStrongIdentity, identityKey, identityOf, sameIdentity } from '../util/file-identity.js';
import { closeSync, existsSync, fstatSync, lstatSync, openSync, opendirSync, realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Artifact, ArtifactAvailability } from '@clawwork/shared';
import { getSqlite } from '../db/index.js';
import { validateImportTaskId } from '../context/file-import.js';
import { ensureTaskDir } from '../workspace/init.js';

const DEFAULT_BUDGETS = Object.freeze({
  maxDepth: 4,
  maxVisited: 1_000,
  maxResults: 100,
  maxTotalBytes: 512 * 1024 * 1024,
});
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const STABILITY_DELAY_MS = 250;

const MIME_TYPES: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.ts': 'text/typescript',
  '.py': 'text/x-python',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip',
};

export type ArtifactBaseline = Record<string, string>;
const BASELINE_COMPLETE = Symbol('artifactBaselineComplete');
type TrackedArtifactBaseline = ArtifactBaseline & { [BASELINE_COMPLETE]?: boolean };

export interface ArtifactScanBudgets {
  maxDepth: number;
  maxVisited: number;
  maxResults: number;
  maxTotalBytes: number;
}

export interface ReconcileTaskArtifactsInput {
  workspacePath: string;
  taskId: string;
  messageId: string;
  baseline: ArtifactBaseline;
}

export interface ReconcileTaskArtifactsResult {
  saved: Artifact[];
  existing: Artifact[];
  updated: Artifact[];
  missing: Artifact[];
  skipped: string[];
  budgetExhausted: boolean;
}

interface ReconcileHooks {
  beforeSecondSnapshot?: (input: { absolutePath: string; relativePath: string }) => void | Promise<void>;
  budgets?: Partial<ArtifactScanBudgets>;
  stabilityDelayMs?: number;
}

interface CaptureBaselineHooks {
  budgets?: Partial<ArtifactScanBudgets>;
}

interface TrustedTaskRoot {
  workspacePath: string;
  taskPath: string;
  realWorkspace: string;
  realTask: string;
  workspaceIdentity: BigIntStats;
  taskIdentity: BigIntStats;
}

interface Candidate {
  absolutePath: string;
  relativePath: string;
  stats: BigIntStats;
  mimeType: string;
}

class UnstableArtifactError extends Error {}

/**
 * 身份判定一律走 `util/file-identity.ts`（bigint，逐位比）。
 *
 * ⚠️ 这段原来的守卫是 `Number.isFinite(dev) && Number.isFinite(ino) && dev > 0 && ino > 0`，
 *    **挡不住丢精度**：`ino` 是 64 位，Number 在超过 2^53 后会把**相邻的两个值**舍入成同一个
 *    ⇒ 两个不同的文件被判成「同一个」。而这里几处全是**变更检测 / 防掉包**
 *    （「扫描期间这个文件/目录被换过吗」），误判 = **fail-open**：
 *    把变了的当成没变 ⇒ 索引到陈旧内容、或把别的内容当成用户那份，**不报错、只出错**。
 */
function sameSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameIdentity(identityOf(left), identityOf(right)) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function samePath(left: string, right: string): boolean {
  return relative(resolve(left), resolve(right)) === '';
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function trustedTaskRoot(workspacePath: string, taskIdValue: string): TrustedTaskRoot {
  const taskId = validateImportTaskId(taskIdValue);
  try {
    const workspaceIdentity = lstatSync(workspacePath, { bigint: true });
    const realWorkspace = realpathSync.native(workspacePath);
    const taskPath = join(workspacePath, taskId);
    const taskIdentity = lstatSync(taskPath, { bigint: true });
    const realTask = realpathSync.native(taskPath);
    if (
      workspaceIdentity.isSymbolicLink() ||
      taskIdentity.isSymbolicLink() ||
      !workspaceIdentity.isDirectory() ||
      !taskIdentity.isDirectory() ||
      !hasStrongIdentity(identityOf(workspaceIdentity)) ||
      !hasStrongIdentity(identityOf(taskIdentity)) ||
      !isWithin(realWorkspace, realTask) ||
      !samePath(realTask, resolve(realWorkspace, taskId))
    ) {
      throw new Error();
    }
    return { workspacePath, taskPath, realWorkspace, realTask, workspaceIdentity, taskIdentity };
  } catch {
    throw new Error('trusted task output directory is unavailable');
  }
}

function verifyTrustedRoot(root: TrustedTaskRoot): void {
  try {
    const workspaceIdentity = lstatSync(root.workspacePath, { bigint: true });
    const taskIdentity = lstatSync(root.taskPath, { bigint: true });
    if (
      workspaceIdentity.isSymbolicLink() ||
      taskIdentity.isSymbolicLink() ||
      !workspaceIdentity.isDirectory() ||
      !taskIdentity.isDirectory() ||
      !sameIdentity(identityOf(workspaceIdentity), identityOf(root.workspaceIdentity)) ||
      !sameIdentity(identityOf(taskIdentity), identityOf(root.taskIdentity)) ||
      !samePath(realpathSync.native(root.workspacePath), root.realWorkspace) ||
      !samePath(realpathSync.native(root.taskPath), root.realTask)
    ) {
      throw new Error();
    }
  } catch {
    throw new Error('trusted task output directory changed');
  }
}

function normalizedRelativePath(taskPath: string, absolutePath: string): string {
  return relative(taskPath, absolutePath).split(sep).join('/');
}

/**
 * 基线签名。⚠️ 身份部分必须用 `identityKey`（bigint 的精确值）：
 *    这里比的是「内容没变就跳过」，用 Number 版的身份会让两个**不同**文件的签名相同
 *    ⇒ 该处理的被跳过 ⇒ **陈旧数据**。
 * ⚠️ 换格式会让**旧基线一次性作废**（多跑一轮全量），方向是安全的（多做不会漏）。
 */
function signature(stats: BigIntStats): string {
  return `${identityKey(identityOf(stats))}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
}

function excludedName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    name.startsWith('.') ||
    name.startsWith('~$') ||
    lower.endsWith('.tmp') ||
    lower.endsWith('.part') ||
    lower.endsWith('.partial') ||
    lower.endsWith('.lock') ||
    lower.endsWith('~')
  );
}

function mimeTypeFor(name: string): string | null {
  return MIME_TYPES[extname(name).toLowerCase()] ?? null;
}

function artifactType(mimeType: string): Artifact['type'] {
  return mimeType.startsWith('image/') ? 'image' : 'file';
}

function safeDirectoryEntries(directoryPath: string, taskRoot: string): Dirent[] {
  const before = lstatSync(directoryPath, { bigint: true });
  const realDirectory = realpathSync.native(directoryPath);
  const canonical = statSync(realDirectory, { bigint: true });
  if (
    before.isSymbolicLink() ||
    !before.isDirectory() ||
    !sameIdentity(identityOf(before), identityOf(canonical)) ||
    !isWithin(taskRoot, realDirectory) ||
    !samePath(realDirectory, directoryPath)
  ) {
    throw new Error('task output directory identity changed');
  }
  const directory = opendirSync(directoryPath);
  const entries: Dirent[] = [];
  try {
    while (true) {
      const entry = directory.readSync();
      if (!entry) break;
      entries.push(entry);
    }
    const after = lstatSync(directoryPath, { bigint: true });
    if (
      !sameIdentity(identityOf(before), identityOf(after)) ||
      !samePath(realpathSync.native(directoryPath), realDirectory)
    ) {
      throw new Error('task output directory identity changed');
    }
    directory.closeSync();
    return entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  } catch (error) {
    try {
      directory.closeSync();
    } catch {
      throw new Error('unable to close task output directory');
    }
    throw error;
  }
}

function collectPaths(
  root: TrustedTaskRoot,
  budgets: ArtifactScanBudgets,
  baseline?: ArtifactBaseline,
): {
  candidates: Candidate[];
  skipped: string[];
  budgetExhausted: boolean;
} {
  const candidates: Candidate[] = [];
  const skipped: string[] = [];
  const queue: Array<{ path: string; depth: number }> = [{ path: root.realTask, depth: 0 }];
  let visited = 0;
  let totalBytes = 0;
  let budgetExhausted = false;

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const entry of safeDirectoryEntries(current.path, root.realTask)) {
      if (visited >= budgets.maxVisited) {
        budgetExhausted = true;
        break;
      }
      visited += 1;
      const absolutePath = join(current.path, entry.name);
      const relativePath = normalizedRelativePath(root.realTask, absolutePath);
      if ((current.depth === 0 && entry.name.toLowerCase() === 'inbox') || excludedName(entry.name)) {
        skipped.push(relativePath);
        continue;
      }
      let stats: BigIntStats;
      try {
        stats = lstatSync(absolutePath, { bigint: true });
      } catch {
        skipped.push(relativePath);
        continue;
      }
      if (stats.isSymbolicLink()) {
        skipped.push(relativePath);
        continue;
      }
      if (stats.isDirectory()) {
        if (current.depth >= budgets.maxDepth) {
          skipped.push(relativePath);
          budgetExhausted = true;
        } else {
          const realDirectory = realpathSync.native(absolutePath);
          if (isWithin(root.realTask, realDirectory) && samePath(realDirectory, absolutePath)) {
            queue.push({ path: realDirectory, depth: current.depth + 1 });
          } else {
            skipped.push(relativePath);
          }
        }
        continue;
      }
      const mimeType = mimeTypeFor(entry.name);
      const size = Number(stats.size);
      if (!stats.isFile() || !mimeType || !hasStrongIdentity(identityOf(stats)) || size <= 0 || size > MAX_FILE_BYTES) {
        skipped.push(relativePath);
        continue;
      }
      if (baseline?.[relativePath] === signature(stats)) continue;
      if (candidates.length >= budgets.maxResults || totalBytes + size > budgets.maxTotalBytes) {
        budgetExhausted = true;
        skipped.push(relativePath);
        continue;
      }
      candidates.push({ absolutePath, relativePath, stats, mimeType });
      totalBytes += size;
    }
    if (budgetExhausted && visited >= budgets.maxVisited) break;
  }
  return { candidates, skipped, budgetExhausted };
}

function artifactFromRow(row: Record<string, unknown>): Artifact {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    messageId: String(row.message_id),
    type: String(row.type) as Artifact['type'],
    name: String(row.name),
    filePath: String(row.file_path),
    localPath: String(row.local_path),
    mimeType: String(row.mime_type),
    size: Number(row.size),
    sourceKey: String(row.source_key),
    contentText: String(row.content_text),
    createdAt: String(row.created_at),
    availability: 'available',
  };
}

function listTaskArtifacts(taskId: string): Artifact[] {
  const sqlite = getSqlite();
  if (!sqlite) throw new Error('database not ready');
  return (
    sqlite.prepare('SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at, id').all(taskId) as Record<
      string,
      unknown
    >[]
  ).map(artifactFromRow);
}

export async function captureTaskArtifactBaseline(
  input: {
    workspacePath: string;
    taskId: string;
  },
  hooks: CaptureBaselineHooks = {},
): Promise<ArtifactBaseline> {
  validateImportTaskId(input.taskId);
  if (!existsSync(join(input.workspacePath, input.taskId))) ensureTaskDir(input.workspacePath, input.taskId);
  const root = trustedTaskRoot(input.workspacePath, input.taskId);
  const budgets = {
    ...DEFAULT_BUDGETS,
    maxResults: DEFAULT_BUDGETS.maxVisited,
    maxTotalBytes: Number.MAX_SAFE_INTEGER,
    ...hooks.budgets,
  };
  const { candidates, budgetExhausted } = collectPaths(root, budgets);
  verifyTrustedRoot(root);
  const baseline = Object.fromEntries(
    candidates.map((candidate) => [candidate.relativePath, signature(candidate.stats)]),
  ) as TrackedArtifactBaseline;
  Object.defineProperty(baseline, BASELINE_COMPLETE, { value: !budgetExhausted });
  return baseline;
}

async function stableCandidateOnce(
  root: TrustedTaskRoot,
  candidate: Candidate,
  hooks: ReconcileHooks,
): Promise<{ candidate: Candidate; fd: number; stats: BigIntStats } | null> {
  let fd = -1;
  try {
    fd = openSync(candidate.absolutePath, 'r');
    const opened = fstatSync(fd, { bigint: true });
    const pathStats = lstatSync(candidate.absolutePath, { bigint: true });
    const realFile = realpathSync.native(candidate.absolutePath);
    if (
      pathStats.isSymbolicLink() ||
      !opened.isFile() ||
      !sameSnapshot(candidate.stats, opened) ||
      !sameSnapshot(opened, pathStats) ||
      !isWithin(root.realTask, realFile) ||
      !samePath(realFile, candidate.absolutePath)
    ) {
      closeSync(fd);
      return null;
    }
    await hooks.beforeSecondSnapshot?.({ absolutePath: candidate.absolutePath, relativePath: candidate.relativePath });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, hooks.stabilityDelayMs ?? STABILITY_DELAY_MS));
    const secondHandle = fstatSync(fd, { bigint: true });
    const secondPath = lstatSync(candidate.absolutePath, { bigint: true });
    if (!sameSnapshot(opened, secondHandle) || !sameSnapshot(opened, secondPath)) {
      closeSync(fd);
      return null;
    }
    return { candidate, fd, stats: secondHandle };
  } catch {
    if (fd >= 0) {
      try {
        closeSync(fd);
      } catch {}
    }
    return null;
  }
}

function refreshCandidate(root: TrustedTaskRoot, relativePath: string): Candidate | null {
  try {
    verifyTrustedRoot(root);
    const absolutePath = resolve(root.realTask, relativePath);
    const stats = lstatSync(absolutePath, { bigint: true });
    const mimeType = mimeTypeFor(relativePath);
    if (
      !mimeType ||
      stats.isSymbolicLink() ||
      !stats.isFile() ||
      !hasStrongIdentity(identityOf(stats)) ||
      Number(stats.size) <= 0 ||
      Number(stats.size) > MAX_FILE_BYTES ||
      !isWithin(root.realTask, absolutePath) ||
      !samePath(realpathSync.native(absolutePath), absolutePath)
    ) {
      return null;
    }
    return { absolutePath, relativePath, stats, mimeType };
  } catch {
    return null;
  }
}

async function stableCandidate(
  root: TrustedTaskRoot,
  candidate: Candidate,
  hooks: ReconcileHooks,
): Promise<{ candidate: Candidate; fd: number; stats: BigIntStats } | null> {
  let current: Candidate | null = candidate;
  for (let attempt = 0; attempt < 2 && current; attempt += 1) {
    const stable = await stableCandidateOnce(root, current, hooks);
    if (stable) return stable;
    current = refreshCandidate(root, candidate.relativePath);
  }
  return null;
}

function localPath(taskId: string, relativePath: string): string {
  return `${taskId}/${relativePath}`;
}

/**
 * 落库的来源键。⚠️ 身份部分是 `artifacts` 表里用来判「同一个来源文件」的，
 *    同样必须精确 —— 否则两个不同文件会被认成同一个来源（去重错误）。
 */
function sourceKey(relativePath: string, stats: BigIntStats): string {
  return `workspace-file:${relativePath}:${identityKey(identityOf(stats))}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
}

export async function reconcileTaskArtifacts(
  input: ReconcileTaskArtifactsInput,
  hooks: ReconcileHooks = {},
): Promise<ReconcileTaskArtifactsResult> {
  const root = trustedTaskRoot(input.workspacePath, input.taskId);
  const budgets = { ...DEFAULT_BUDGETS, ...hooks.budgets };
  const existingRows = listTaskArtifacts(input.taskId);
  const taskLocalPrefix = `${input.taskId}/`;
  const missing = existingRows.filter(
    (artifact) =>
      !artifact.localPath.startsWith(taskLocalPrefix) ||
      getArtifactAvailability(artifact.localPath, input.workspacePath) !== 'available',
  );
  const saved: Artifact[] = [];
  const existing: Artifact[] = [];
  const updated: Artifact[] = [];
  if ((input.baseline as TrackedArtifactBaseline)[BASELINE_COMPLETE] === false) {
    verifyTrustedRoot(root);
    return { saved, existing, updated, missing, skipped: [], budgetExhausted: true };
  }
  const discovered = collectPaths(root, budgets, input.baseline);
  // Open and verify candidates in parallel so the stability window is paid
  // once per reconciliation, not once per output file. The result budget caps
  // the number of simultaneously open read-only handles.
  const stableCandidates = await Promise.all(
    discovered.candidates.map(async (candidate) => {
      const stable = await stableCandidate(root, candidate, hooks);
      if (!stable) discovered.skipped.push(candidate.relativePath);
      return stable;
    }),
  );

  try {
    for (const stable of stableCandidates) {
      if (!stable) continue;
      const { candidate } = stable;
      try {
        verifyTrustedRoot(root);
        const finalHandle = fstatSync(stable.fd, { bigint: true });
        const finalPath = lstatSync(candidate.absolutePath, { bigint: true });
        if (!sameSnapshot(stable.stats, finalHandle) || !sameSnapshot(stable.stats, finalPath)) {
          discovered.skipped.push(candidate.relativePath);
          continue;
        }
        const sqlite = getSqlite();
        if (!sqlite) throw new Error('database not ready');
        const storedLocalPath = localPath(input.taskId, candidate.relativePath);
        const now = new Date().toISOString();
        const artifact: Artifact = {
          id: randomUUID(),
          taskId: input.taskId,
          messageId: input.messageId,
          type: artifactType(candidate.mimeType),
          name: candidate.relativePath.split('/').at(-1)!,
          filePath: '',
          localPath: storedLocalPath,
          mimeType: candidate.mimeType,
          size: Number(stable.stats.size),
          sourceKey: sourceKey(candidate.relativePath, stable.stats),
          contentText: '',
          createdAt: now,
          availability: 'available',
        };
        const persist = sqlite.transaction((): { kind: 'saved' | 'existing' | 'updated'; artifact: Artifact } => {
          const beforeHandle = fstatSync(stable.fd, { bigint: true });
          const beforePath = lstatSync(candidate.absolutePath, { bigint: true });
          if (!sameSnapshot(stable.stats, beforeHandle) || !sameSnapshot(stable.stats, beforePath)) {
            throw new UnstableArtifactError();
          }
          const prior = sqlite
            .prepare('SELECT * FROM artifacts WHERE task_id = ? AND local_path = ? LIMIT 1')
            .get(input.taskId, storedLocalPath) as Record<string, unknown> | undefined;
          let result: { kind: 'saved' | 'existing' | 'updated'; artifact: Artifact };
          if (prior) {
            const previous = artifactFromRow(prior);
            if (
              !previous.sourceKey?.startsWith('workspace-file:') ||
              (previous.sourceKey === artifact.sourceKey &&
                previous.size === artifact.size &&
                previous.mimeType === artifact.mimeType)
            ) {
              result = { kind: 'existing', artifact: previous };
            } else {
              const changed = { ...artifact, id: previous.id, createdAt: previous.createdAt };
              sqlite
                .prepare(
                  `UPDATE artifacts
                 SET message_id = @messageId, type = @type, name = @name, file_path = @filePath,
                     mime_type = @mimeType, size = @size, source_key = @sourceKey, content_text = @contentText
                 WHERE id = @id`,
                )
                .run(changed);
              result = { kind: 'updated', artifact: changed };
            }
          } else {
            const insert = sqlite
              .prepare(
                `INSERT INTO artifacts
               (id, task_id, message_id, type, name, file_path, local_path, mime_type, size, source_key, content_text,
                created_at)
               VALUES (@id, @taskId, @messageId, @type, @name, @filePath, @localPath, @mimeType, @size, @sourceKey,
                       @contentText, @createdAt)
               ON CONFLICT(task_id, local_path) DO NOTHING`,
              )
              .run(artifact);
            if (insert.changes === 1) result = { kind: 'saved', artifact };
            else {
              const winner = sqlite
                .prepare('SELECT * FROM artifacts WHERE task_id = ? AND local_path = ? LIMIT 1')
                .get(input.taskId, storedLocalPath) as Record<string, unknown>;
              result = { kind: 'existing', artifact: artifactFromRow(winner) };
            }
          }
          const afterHandle = fstatSync(stable.fd, { bigint: true });
          const afterPath = lstatSync(candidate.absolutePath, { bigint: true });
          if (!sameSnapshot(stable.stats, afterHandle) || !sameSnapshot(stable.stats, afterPath)) {
            throw new UnstableArtifactError();
          }
          return result;
        });
        try {
          const result = persist();
          if (result.kind === 'saved') saved.push(result.artifact);
          else if (result.kind === 'updated') updated.push(result.artifact);
          else existing.push(result.artifact);
        } catch (error) {
          if (!(error instanceof UnstableArtifactError)) throw error;
          discovered.skipped.push(candidate.relativePath);
        }
      } finally {
        closeSync(stable.fd);
        stable.fd = -1;
      }
    }
  } finally {
    for (const stable of stableCandidates) {
      if (!stable || stable.fd < 0) continue;
      try {
        closeSync(stable.fd);
      } catch {}
      stable.fd = -1;
    }
  }
  verifyTrustedRoot(root);
  return {
    saved,
    existing,
    updated,
    missing,
    skipped: [...new Set(discovered.skipped)].sort(),
    budgetExhausted: discovered.budgetExhausted,
  };
}

export function getArtifactAvailability(localPathValue: string, workspacePath: string): ArtifactAvailability {
  if (!localPathValue || isAbsolute(localPathValue) || localPathValue.includes('\0')) return 'unsafe';
  try {
    const absolutePath = resolve(workspacePath, localPathValue);
    const realWorkspace = realpathSync.native(workspacePath);
    const realFile = realpathSync.native(absolutePath);
    const linkStats = lstatSync(absolutePath, { bigint: true });
    const canonicalStats = statSync(realFile, { bigint: true });
    if (
      linkStats.isSymbolicLink() ||
      !linkStats.isFile() ||
      !hasStrongIdentity(identityOf(linkStats)) ||
      !sameIdentity(identityOf(linkStats), identityOf(canonicalStats)) ||
      !isWithin(realWorkspace, realFile) ||
      !samePath(realFile, absolutePath)
    ) {
      return 'unsafe';
    }
    return 'available';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unsafe';
  }
}

/**
 * 只给测试用。
 *
 * ⚠️ 为什么必须把它们露出来：`signature` / `sourceKey` 的**身份部分**是否精确，
 *    用**真文件**测不出来 —— 真文件上没法造出"只有 dev/ino 不同、size/mtime/ctime 全一样"
 *    的形态（ctime 改不了，它总会在签名里兜住）。而恰恰是"两个不同的文件签名相同"
 *    才会导致"该重建的跳过 ⇒ 陈旧数据"。所以只能在函数层面用合成的 bigint stats 钉。
 */
export const __testing = Object.freeze({ signature, sourceKey });
