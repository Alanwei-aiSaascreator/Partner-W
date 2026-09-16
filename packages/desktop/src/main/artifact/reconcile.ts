import { randomUUID } from 'node:crypto';
import type { Dirent, Stats } from 'node:fs';
import { closeSync, existsSync, fstatSync, lstatSync, openSync, opendirSync, realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Artifact } from '@clawwork/shared';
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

interface TrustedTaskRoot {
  workspacePath: string;
  taskPath: string;
  realWorkspace: string;
  realTask: string;
  workspaceIdentity: Stats;
  taskIdentity: Stats;
}

interface Candidate {
  absolutePath: string;
  relativePath: string;
  stats: Stats;
  mimeType: string;
}

class UnstableArtifactError extends Error {}

function hasStrongIdentity(stats: Stats): boolean {
  return Number.isFinite(stats.dev) && Number.isFinite(stats.ino) && stats.dev > 0 && stats.ino > 0;
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return hasStrongIdentity(left) && hasStrongIdentity(right) && left.dev === right.dev && left.ino === right.ino;
}

function sameSnapshot(left: Stats, right: Stats): boolean {
  return (
    sameIdentity(left, right) &&
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
    const workspaceIdentity = lstatSync(workspacePath);
    const realWorkspace = realpathSync.native(workspacePath);
    const taskPath = join(workspacePath, taskId);
    const taskIdentity = lstatSync(taskPath);
    const realTask = realpathSync.native(taskPath);
    if (
      workspaceIdentity.isSymbolicLink() ||
      taskIdentity.isSymbolicLink() ||
      !workspaceIdentity.isDirectory() ||
      !taskIdentity.isDirectory() ||
      !hasStrongIdentity(workspaceIdentity) ||
      !hasStrongIdentity(taskIdentity) ||
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
    const workspaceIdentity = lstatSync(root.workspacePath);
    const taskIdentity = lstatSync(root.taskPath);
    if (
      workspaceIdentity.isSymbolicLink() ||
      taskIdentity.isSymbolicLink() ||
      !workspaceIdentity.isDirectory() ||
      !taskIdentity.isDirectory() ||
      !sameIdentity(workspaceIdentity, root.workspaceIdentity) ||
      !sameIdentity(taskIdentity, root.taskIdentity) ||
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

function signature(stats: Stats): string {
  return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
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
  const before = lstatSync(directoryPath);
  const realDirectory = realpathSync.native(directoryPath);
  const canonical = statSync(realDirectory);
  if (
    before.isSymbolicLink() ||
    !before.isDirectory() ||
    !sameIdentity(before, canonical) ||
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
    const after = lstatSync(directoryPath);
    if (!sameIdentity(before, after) || !samePath(realpathSync.native(directoryPath), realDirectory)) {
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
      let stats: Stats;
      try {
        stats = lstatSync(absolutePath);
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
      if (!stats.isFile() || !mimeType || !hasStrongIdentity(stats) || stats.size <= 0 || stats.size > MAX_FILE_BYTES) {
        skipped.push(relativePath);
        continue;
      }
      if (candidates.length >= budgets.maxResults || totalBytes + stats.size > budgets.maxTotalBytes) {
        budgetExhausted = true;
        skipped.push(relativePath);
        continue;
      }
      candidates.push({ absolutePath, relativePath, stats, mimeType });
      totalBytes += stats.size;
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

export async function captureTaskArtifactBaseline(input: {
  workspacePath: string;
  taskId: string;
}): Promise<ArtifactBaseline> {
  validateImportTaskId(input.taskId);
  if (!existsSync(join(input.workspacePath, input.taskId))) ensureTaskDir(input.workspacePath, input.taskId);
  const root = trustedTaskRoot(input.workspacePath, input.taskId);
  const { candidates } = collectPaths(root, DEFAULT_BUDGETS);
  verifyTrustedRoot(root);
  return Object.fromEntries(candidates.map((candidate) => [candidate.relativePath, signature(candidate.stats)]));
}

async function stableCandidate(
  root: TrustedTaskRoot,
  candidate: Candidate,
  hooks: ReconcileHooks,
): Promise<{ candidate: Candidate; fd: number; stats: Stats } | null> {
  let fd = -1;
  try {
    fd = openSync(candidate.absolutePath, 'r');
    const opened = fstatSync(fd);
    const pathStats = lstatSync(candidate.absolutePath);
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
    const secondHandle = fstatSync(fd);
    const secondPath = lstatSync(candidate.absolutePath);
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

function localPath(taskId: string, relativePath: string): string {
  return `${taskId}/${relativePath}`;
}

function sourceKey(relativePath: string, stats: Stats): string {
  return `workspace-file:${relativePath}:${stats.size}:${stats.mtimeMs}`;
}

export async function reconcileTaskArtifacts(
  input: ReconcileTaskArtifactsInput,
  hooks: ReconcileHooks = {},
): Promise<ReconcileTaskArtifactsResult> {
  const root = trustedTaskRoot(input.workspacePath, input.taskId);
  const budgets = { ...DEFAULT_BUDGETS, ...hooks.budgets };
  const discovered = collectPaths(root, budgets);
  const existingRows = listTaskArtifacts(input.taskId);
  const taskLocalPrefix = `${input.taskId}/`;
  const missing = existingRows.filter(
    (artifact) =>
      !artifact.localPath.startsWith(taskLocalPrefix) ||
      getArtifactAvailability(artifact.localPath, input.workspacePath) === 'missing',
  );
  const saved: Artifact[] = [];
  const existing: Artifact[] = [];
  const updated: Artifact[] = [];
  // Open and verify candidates in parallel so the stability window is paid
  // once per reconciliation, not once per output file. The result budget caps
  // the number of simultaneously open read-only handles.
  const stableCandidates = await Promise.all(
    discovered.candidates.map(async (candidate) => {
      if (input.baseline[candidate.relativePath] === signature(candidate.stats)) return null;
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
        const finalHandle = fstatSync(stable.fd);
        const finalPath = lstatSync(candidate.absolutePath);
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
          size: stable.stats.size,
          sourceKey: sourceKey(candidate.relativePath, stable.stats),
          contentText: '',
          createdAt: now,
        };
        const persist = sqlite.transaction((): { kind: 'saved' | 'existing' | 'updated'; artifact: Artifact } => {
          const beforeHandle = fstatSync(stable.fd);
          const beforePath = lstatSync(candidate.absolutePath);
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
          const afterHandle = fstatSync(stable.fd);
          const afterPath = lstatSync(candidate.absolutePath);
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

export function getArtifactAvailability(localPathValue: string, workspacePath: string): 'available' | 'missing' {
  if (!localPathValue || isAbsolute(localPathValue) || localPathValue.includes('\0')) return 'missing';
  try {
    const absolutePath = resolve(workspacePath, localPathValue);
    const realWorkspace = realpathSync.native(workspacePath);
    const realFile = realpathSync.native(absolutePath);
    const linkStats = lstatSync(absolutePath);
    const canonicalStats = statSync(realFile);
    if (
      linkStats.isSymbolicLink() ||
      !linkStats.isFile() ||
      !hasStrongIdentity(linkStats) ||
      !sameIdentity(linkStats, canonicalStats) ||
      !isWithin(realWorkspace, realFile) ||
      !samePath(realFile, absolutePath)
    ) {
      return 'missing';
    }
    return 'available';
  } catch {
    return 'missing';
  }
}
