import type { ImportFileRejectionReason, ImportFilesResult, ImportedTaskFile } from '@clawwork/shared';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import type { BigIntStats, Dir } from 'node:fs';
import { hasStrongIdentity, identityOf, sameIdentity } from '../util/file-identity.js';
import { existsSync, lstatSync, mkdirSync, opendirSync, realpathSync, statSync } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { link, lstat, open, realpath, stat, unlink } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ensureTaskDir } from '../workspace/init.js';
import { uniqueFileName } from '../workspace/safe-name.js';
import { getMimeType } from './file-types.js';

const MAX_FILE_SIZE = 100 * 1024 * 1024;
const COPY_CHUNK_SIZE = 1024 * 1024;
const MAX_LIST_VISITED = 2000;
const MAX_LIST_RESULTS = 100;
const TIMESTAMP_TOLERANCE_MS = 0;
const STAGING_GC_TTL_MS = 24 * 60 * 60 * 1000;
const STAGING_GC_SOFT_MAX_ENTRIES_PER_BATCH = 32;
const STAGING_GC_SOFT_MAX_BYTES_PER_BATCH = 200 * 1024 * 1024;
const STAGING_GC_SCAN_BUDGET_PER_BATCH = 256;
const STAGING_FILE_PATTERN = /^\.import-[a-f0-9-]+\.partial$/;

export const IMPORT_FILE_EXTENSIONS = [
  'ts',
  'tsx',
  'js',
  'jsx',
  'py',
  'go',
  'rs',
  'java',
  'c',
  'cpp',
  'h',
  'rb',
  'sh',
  'sql',
  'yaml',
  'yml',
  'toml',
  'json',
  'xml',
  'html',
  'css',
  'scss',
  'less',
  'md',
  'txt',
  'csv',
  'env',
  'gitignore',
  'dockerfile',
  'log',
  'vue',
  'svelte',
  'swift',
  'kt',
  'r',
  'lua',
  'pl',
  'makefile',
  'cmake',
  'proto',
  'graphql',
  'tf',
  'ini',
  'cfg',
  'conf',
  'lock',
  'editorconfig',
  'png',
  'jpg',
  'jpeg',
  'webp',
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
] as const;

const IMPORT_EXTENSIONS = new Set<string>(IMPORT_FILE_EXTENSIONS.map((extension) => `.${extension}`));
const SPECIAL_NAMES = new Set([
  '.env',
  '.gitignore',
  '.dockerfile',
  '.editorconfig',
  '.cmake',
  '.makefile',
  'dockerfile',
  'makefile',
]);
const LEGACY_OFFICE_MIME: Record<string, string> = {
  '.doc': 'application/msword',
  '.xls': 'application/vnd.ms-excel',
  '.ppt': 'application/vnd.ms-powerpoint',
};

interface TrustedInbox {
  workspacePath: string;
  taskPath: string;
  inboxPath: string;
  realWorkspace: string;
  realTask: string;
  realInbox: string;
  taskIdentity: BigIntStats;
  inboxIdentity: BigIntStats;
}

interface TrustedStaging {
  stagingPath: string;
  realStaging: string;
  stagingIdentity: BigIntStats;
}

interface SourceSnapshot {
  selectedPath: string;
  canonicalPath: string;
  identity: BigIntStats;
}

interface ImportTestContext {
  sourcePath: string;
  destinationPath: string;
  inboxPath: string;
}

interface ImportTestHooks {
  beforeTargetOpen?: (context: ImportTestContext) => void | Promise<void>;
  afterTargetOpen?: (context: ImportTestContext) => void | Promise<void>;
  afterChunkWritten?: (context: ImportTestContext) => void | Promise<void>;
  beforeTargetHash?: (context: ImportTestContext) => void | Promise<void>;
  beforePublish?: (context: ImportTestContext) => void | Promise<void>;
  beforeCleanup?: (context: ImportTestContext) => void | Promise<void>;
  nativeMovePublisher?: (sourcePath: string, destinationPath: string) => Promise<void>;
}

interface StagingGarbageTestHooks {
  beforeDelete?: (path: string) => void | Promise<void>;
}

class ImportItemError extends Error {
  constructor(readonly reason: ImportFileRejectionReason) {
    super(reason);
  }
}

export class ImportIntegrityError extends Error {}

function samePath(left: string, right: string): boolean {
  return relative(resolve(left), resolve(right)) === '';
}

function isWithin(parent: string, child: string): boolean {
  const fromParent = relative(parent, child);
  return fromParent === '' || (!fromParent.startsWith(`..${sep}`) && fromParent !== '..' && !isAbsolute(fromParent));
}

/**
 * 身份判定一律走 `util/file-identity.ts`（bigint，逐位比）。
 *
 * ⚠️ 原来的守卫是 `Number.isFinite(dev) && Number.isFinite(ino) && dev > 0 && ino > 0`，
 *    **挡不住丢精度**：`ino` 是 64 位，Number 在超过 2^53 后会把**相邻的两个值**舍入成同一个，
 *    而 NTFS 顺序分配 inode ⇒ 连续创建的两个文件 ino 必然相邻 ⇒ **必然**被判成「同一个文件」。
 *
 * ⚠️ 这里是**导入**路径：这些判定管的是"我打开的这个文件，还是用户选的那份吗"。
 *    答错的代价是把**别的内容**当成用户选的那份导进来 —— 而且**不报错**（fail-open）。
 */
function sameStrongIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return sameIdentity(identityOf(left), identityOf(right));
}

function sameTimestamp(left: bigint, right: bigint): boolean {
  // ⚠️ 必须转 Number 再比：bigint 上 `Math.abs` 会抛（不能用 Number.isFinite 判 bigint，恒为 false）
  const delta = Number(left) - Number(right);
  return Number.isFinite(delta) && Math.abs(delta) <= TIMESTAMP_TOLERANCE_MS;
}

function sameSourceSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameStrongIdentity(left, right) &&
    left.size === right.size &&
    sameTimestamp(left.mtimeMs, right.mtimeMs) &&
    sameTimestamp(left.ctimeMs, right.ctimeMs)
  );
}

function sameTargetSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return sameSourceSnapshot(left, right);
}

function samePublishedTarget(left: BigIntStats, right: BigIntStats): boolean {
  return sameStrongIdentity(left, right) && left.size === right.size && sameTimestamp(left.mtimeMs, right.mtimeMs);
}

export function validateImportTaskId(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error('taskId is required');
  if (value === '.' || value === '..' || value.includes('/') || value.includes('\\') || value.includes('\0')) {
    throw new Error('taskId must be a safe path component');
  }
  if (isAbsolute(value)) throw new Error('taskId must be a safe path component');
  return value;
}

function resolveTrustedInbox(workspacePath: string, taskId: string, create: boolean): TrustedInbox | null {
  const realWorkspace = realpathSync.native(workspacePath);
  const workspaceStats = lstatSync(workspacePath, { bigint: true });
  if (!workspaceStats.isDirectory()) throw new Error();
  const taskPath = join(workspacePath, taskId);
  if (!existsSync(taskPath)) {
    if (!create) return null;
    ensureTaskDir(workspacePath, taskId);
  }
  const taskStats = lstatSync(taskPath, { bigint: true });
  if (taskStats.isSymbolicLink() || !taskStats.isDirectory() || !hasStrongIdentity(taskStats)) throw new Error();
  const realTask = realpathSync.native(taskPath);
  if (!isWithin(realWorkspace, realTask) || !samePath(realTask, resolve(realWorkspace, taskId))) throw new Error();

  const inboxPath = join(taskPath, 'inbox');
  if (!existsSync(inboxPath)) {
    if (!create) return null;
    mkdirSync(inboxPath);
  }
  const inboxStats = lstatSync(inboxPath, { bigint: true });
  if (inboxStats.isSymbolicLink() || !inboxStats.isDirectory() || !hasStrongIdentity(inboxStats)) throw new Error();
  const realInbox = realpathSync.native(inboxPath);
  if (!isWithin(realTask, realInbox) || !samePath(realInbox, resolve(realTask, 'inbox'))) throw new Error();
  return {
    workspacePath,
    taskPath,
    inboxPath,
    realWorkspace,
    realTask,
    realInbox,
    taskIdentity: taskStats,
    inboxIdentity: inboxStats,
  };
}

function trustedInbox(workspacePath: string, taskIdValue: unknown, create: boolean): TrustedInbox | null {
  const taskId = validateImportTaskId(taskIdValue);
  try {
    return resolveTrustedInbox(workspacePath, taskId, create);
  } catch {
    throw new Error('trusted task inbox is unavailable');
  }
}

function verifyTrustedInbox(trusted: TrustedInbox): void {
  try {
    const taskStats = lstatSync(trusted.taskPath, { bigint: true });
    const inboxStats = lstatSync(trusted.inboxPath, { bigint: true });
    if (
      taskStats.isSymbolicLink() ||
      inboxStats.isSymbolicLink() ||
      !taskStats.isDirectory() ||
      !inboxStats.isDirectory() ||
      !sameStrongIdentity(taskStats, trusted.taskIdentity) ||
      !sameStrongIdentity(inboxStats, trusted.inboxIdentity) ||
      !samePath(realpathSync.native(trusted.workspacePath), trusted.realWorkspace) ||
      !samePath(realpathSync.native(trusted.taskPath), trusted.realTask) ||
      !samePath(realpathSync.native(trusted.inboxPath), trusted.realInbox)
    ) {
      throw new Error();
    }
  } catch {
    throw new ImportIntegrityError('trusted task inbox changed');
  }
}

function resolveTrustedStaging(trusted: TrustedInbox): TrustedStaging {
  verifyTrustedInbox(trusted);
  const stagingPath = join(trusted.inboxPath, '.import-staging');
  if (!existsSync(stagingPath)) {
    try {
      mkdirSync(stagingPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  try {
    const stagingIdentity = lstatSync(stagingPath, { bigint: true });
    const realStaging = realpathSync.native(stagingPath);
    if (
      stagingIdentity.isSymbolicLink() ||
      !stagingIdentity.isDirectory() ||
      !hasStrongIdentity(stagingIdentity) ||
      !isWithin(trusted.realInbox, realStaging) ||
      !samePath(realStaging, stagingPath)
    ) {
      throw new Error();
    }
    return { stagingPath, realStaging, stagingIdentity };
  } catch {
    throw new ImportIntegrityError('trusted import staging directory is unavailable');
  }
}

function verifyTrustedStaging(trusted: TrustedInbox, staging: TrustedStaging): void {
  verifyTrustedInbox(trusted);
  try {
    const stats = lstatSync(staging.stagingPath, { bigint: true });
    if (
      stats.isSymbolicLink() ||
      !stats.isDirectory() ||
      !sameStrongIdentity(stats, staging.stagingIdentity) ||
      !samePath(realpathSync.native(staging.stagingPath), staging.realStaging)
    ) {
      throw new Error();
    }
  } catch {
    throw new ImportIntegrityError('trusted import staging directory changed');
  }
}

async function stagedFileSnapshot(
  trusted: TrustedInbox,
  staging: TrustedStaging,
  filePath: string,
): Promise<BigIntStats> {
  verifyTrustedStaging(trusted, staging);
  const linkStats = await lstat(filePath, { bigint: true });
  const canonicalPath = await realpath(filePath);
  const canonicalStats = await stat(canonicalPath, { bigint: true });
  if (
    linkStats.isSymbolicLink() ||
    !linkStats.isFile() ||
    !hasStrongIdentity(linkStats) ||
    !sameSourceSnapshot(linkStats, canonicalStats) ||
    !isWithin(staging.realStaging, canonicalPath) ||
    !samePath(canonicalPath, filePath)
  ) {
    throw new ImportIntegrityError('staged import file identity changed');
  }
  return linkStats;
}

async function deleteStagedFile(
  trusted: TrustedInbox,
  staging: TrustedStaging,
  filePath: string,
  requiredIdentity: BigIntStats | null,
  hooks: StagingGarbageTestHooks = {},
): Promise<void> {
  const initial = await stagedFileSnapshot(trusted, staging, filePath);
  if (requiredIdentity && !sameStrongIdentity(requiredIdentity, initial)) {
    throw new ImportIntegrityError('staged import file identity changed');
  }
  await hooks.beforeDelete?.(filePath);
  const current = await stagedFileSnapshot(trusted, staging, filePath);
  if (!sameSourceSnapshot(initial, current)) {
    throw new ImportIntegrityError('staged import file changed before cleanup');
  }
  const handle = await open(filePath, 'r');
  let failure: unknown = null;
  try {
    const handleStats = await handle.stat({ bigint: true });
    const finalPathStats = await stagedFileSnapshot(trusted, staging, filePath);
    if (!sameSourceSnapshot(current, handleStats) || !sameSourceSnapshot(current, finalPathStats)) {
      throw new ImportIntegrityError('staged import file changed before unlink');
    }
    await unlink(filePath);
    verifyTrustedStaging(trusted, staging);
  } catch (error) {
    failure = error;
  }
  const closeError = await closeHandle(handle);
  if (closeError) throw new ImportIntegrityError('unable to close staged import cleanup handle');
  if (failure) throw failure;
}

async function collectStagingGarbage(
  trusted: TrustedInbox,
  staging: TrustedStaging,
  hooks: StagingGarbageTestHooks = {},
): Promise<void> {
  verifyTrustedStaging(trusted, staging);
  const candidates: Array<{ path: string; stats: BigIntStats; name: string }> = [];
  const directory = opendirSync(staging.realStaging);
  try {
    for (let visited = 0; visited < STAGING_GC_SCAN_BUDGET_PER_BATCH; visited += 1) {
      const entry = directory.readSync();
      if (!entry) break;
      if (!entry.isFile() || !STAGING_FILE_PATTERN.test(entry.name)) continue;
      const filePath = join(staging.realStaging, entry.name);
      try {
        const stats = lstatSync(filePath, { bigint: true });
        const canonicalPath = realpathSync.native(filePath);
        if (
          stats.isSymbolicLink() ||
          !stats.isFile() ||
          !hasStrongIdentity(stats) ||
          !sameSourceSnapshot(stats, statSync(canonicalPath, { bigint: true })) ||
          !isWithin(staging.realStaging, canonicalPath) ||
          !samePath(canonicalPath, filePath)
        ) {
          continue;
        }
        candidates.push({ path: filePath, stats, name: entry.name });
      } catch {
        continue;
      }
    }
    directory.closeSync();
  } catch (error) {
    closeDirectory(directory, error);
  }

  candidates.sort(
    (left, right) => Number(left.stats.mtimeMs - right.stats.mtimeMs) || codePointCompare(left.name, right.name),
  );
  let remainingCount = candidates.length;
  let remainingBytes = candidates.reduce((sum, candidate) => sum + Number(candidate.stats.size), 0);
  const expiry = Date.now() - STAGING_GC_TTL_MS;
  for (const candidate of candidates) {
    if (
      candidate.stats.mtimeMs >= expiry &&
      remainingCount <= STAGING_GC_SOFT_MAX_ENTRIES_PER_BATCH &&
      remainingBytes <= STAGING_GC_SOFT_MAX_BYTES_PER_BATCH
    ) {
      continue;
    }
    await deleteStagedFile(trusted, staging, candidate.path, candidate.stats, hooks);
    remainingCount -= 1;
    remainingBytes -= Number(candidate.stats.size);
  }
}

function sourceFileName(sourcePath: string): string {
  return basename(sourcePath.replaceAll('\\', '/'));
}

function regularMimeType(extension: string): string {
  return LEGACY_OFFICE_MIME[extension] ?? getMimeType(extension);
}

function classifyImportFileName(fileName: string, allowStoredSpecialSuffix: boolean): string | null {
  const lowerName = fileName.toLowerCase();
  if (lowerName.startsWith('~$')) return null;
  if (SPECIAL_NAMES.has(lowerName)) return 'text/plain';
  if (allowStoredSpecialSuffix) {
    for (const specialName of SPECIAL_NAMES) {
      const prefix = `${specialName}-`;
      if (lowerName.startsWith(prefix) && /^[a-f0-9]{8}$/.test(lowerName.slice(prefix.length))) {
        return 'text/plain';
      }
    }
  }
  if (lowerName.startsWith('.')) return null;
  const extension = extname(lowerName);
  return IMPORT_EXTENSIONS.has(extension) ? regularMimeType(extension) : null;
}

function sourceMimeType(fileName: string): string | null {
  return classifyImportFileName(fileName, false);
}

function storedMimeType(fileName: string): string | null {
  return classifyImportFileName(fileName, true);
}

function localPath(taskId: string, fileName: string): string {
  return [taskId, 'inbox', fileName].join('/');
}

function rejection(fileName: string, reason: ImportFileRejectionReason): ImportFilesResult['rejected'][number] {
  return { fileName, reason };
}

async function closeHandle(handle: FileHandle | null): Promise<Error | null> {
  if (!handle) return null;
  try {
    await handle.close();
    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error('file handle close failed');
  }
}

async function sourceSnapshot(selectedPath: string, handle: FileHandle): Promise<SourceSnapshot> {
  const handleStats = await handle.stat({ bigint: true });
  const linkStats = await lstat(selectedPath, { bigint: true });
  if (
    !handleStats.isFile() ||
    !hasStrongIdentity(handleStats) ||
    !linkStats.isFile() ||
    linkStats.isSymbolicLink() ||
    !sameStrongIdentity(handleStats, linkStats)
  ) {
    throw new ImportItemError('unavailable');
  }
  const canonicalPath = await realpath(selectedPath);
  const canonicalStats = await stat(canonicalPath, { bigint: true });
  if (!canonicalStats.isFile() || !sameStrongIdentity(handleStats, canonicalStats)) {
    throw new ImportItemError('unavailable');
  }
  return { selectedPath, canonicalPath, identity: handleStats };
}

async function verifySource(source: SourceSnapshot, handle: FileHandle): Promise<void> {
  try {
    const handleStats = await handle.stat({ bigint: true });
    const linkStats = await lstat(source.selectedPath, { bigint: true });
    const currentCanonical = await realpath(source.selectedPath);
    const canonicalStats = await stat(currentCanonical, { bigint: true });
    if (
      !handleStats.isFile() ||
      !linkStats.isFile() ||
      linkStats.isSymbolicLink() ||
      !samePath(currentCanonical, source.canonicalPath) ||
      !sameSourceSnapshot(source.identity, handleStats) ||
      !sameSourceSnapshot(source.identity, linkStats) ||
      !sameSourceSnapshot(source.identity, canonicalStats)
    ) {
      throw new Error();
    }
  } catch {
    throw new ImportItemError('copy-failed');
  }
}

async function verifyTarget(
  trusted: TrustedInbox,
  destinationPath: string,
  targetIdentity: BigIntStats,
  handle: FileHandle,
): Promise<BigIntStats> {
  verifyTrustedInbox(trusted);
  const handleStats = await handle.stat({ bigint: true });
  const linkStats = await lstat(destinationPath, { bigint: true });
  const canonicalPath = await realpath(destinationPath);
  const canonicalStats = await stat(canonicalPath, { bigint: true });
  if (
    !handleStats.isFile() ||
    !linkStats.isFile() ||
    linkStats.isSymbolicLink() ||
    !sameStrongIdentity(targetIdentity, handleStats) ||
    !sameStrongIdentity(targetIdentity, linkStats) ||
    !sameStrongIdentity(targetIdentity, canonicalStats) ||
    !isWithin(trusted.realInbox, canonicalPath) ||
    !samePath(canonicalPath, destinationPath)
  ) {
    throw new ImportIntegrityError('import destination identity changed');
  }
  return handleStats;
}

async function hashTarget(handle: FileHandle, expectedBytes: number): Promise<string> {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(COPY_CHUNK_SIZE);
  let position = 0;
  while (position < expectedBytes) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, expectedBytes - position), position);
    if (bytesRead === 0) throw new ImportIntegrityError('import destination ended early');
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest('hex');
}

const POWERSHELL_NO_REPLACE_MOVE_SCRIPT =
  '& { param([string]$s,[string]$d) $ErrorActionPreference="Stop"; function Decode([string]$v) { $v=$v.Replace("-","+").Replace("_","/"); while (($v.Length % 4) -ne 0) { $v += "=" }; [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($v)) }; [System.IO.File]::Move((Decode $s),(Decode $d)) }';

const WINDOWS_MOVE_OPTIONS = Object.freeze({ windowsHide: true, timeout: 15_000, maxBuffer: 64 * 1024 });

async function resolveWindowsPowerShellPath(
  systemRootValue = process.env.SystemRoot ?? process.env.WINDIR,
  useSysnative = process.arch === 'ia32' && Boolean(process.env.PROCESSOR_ARCHITEW6432),
): Promise<string> {
  if (!systemRootValue || !isAbsolute(systemRootValue)) throw new Error('trusted Windows PowerShell is unavailable');
  try {
    const rootLinkStats = await lstat(systemRootValue, { bigint: true });
    const realRoot = await realpath(systemRootValue);
    const rootStats = await stat(realRoot, { bigint: true });
    if (
      rootLinkStats.isSymbolicLink() ||
      !rootLinkStats.isDirectory() ||
      !sameStrongIdentity(rootLinkStats, rootStats)
    ) {
      throw new Error();
    }

    const candidateRoots = useSysnative ? ['Sysnative', 'System32'] : ['System32'];
    for (const candidateRoot of candidateRoots) {
      const relativeParent = join(candidateRoot, 'WindowsPowerShell', 'v1.0');
      const candidate = join(systemRootValue, relativeParent, 'powershell.exe');
      try {
        const parentPath = dirname(candidate);
        const [parentLinkStats, executableLinkStats, realParent, realExecutable] = await Promise.all([
          lstat(parentPath, { bigint: true }),
          lstat(candidate, { bigint: true }),
          realpath(parentPath),
          realpath(candidate),
        ]);
        const [parentStats, executableStats] = await Promise.all([
          stat(realParent, { bigint: true }),
          stat(realExecutable, { bigint: true }),
        ]);
        const expectedParents = (candidateRoot === 'Sysnative' ? ['Sysnative', 'System32'] : [candidateRoot]).map(
          (physicalRoot) => resolve(realRoot, physicalRoot, 'WindowsPowerShell', 'v1.0'),
        );
        if (
          parentLinkStats.isSymbolicLink() ||
          executableLinkStats.isSymbolicLink() ||
          !parentLinkStats.isDirectory() ||
          !executableLinkStats.isFile() ||
          !sameStrongIdentity(parentLinkStats, parentStats) ||
          !sameStrongIdentity(executableLinkStats, executableStats) ||
          !expectedParents.some((expectedParent) => samePath(realParent, expectedParent)) ||
          !samePath(realExecutable, join(realParent, 'powershell.exe')) ||
          !isWithin(realRoot, realExecutable)
        ) {
          throw new Error();
        }
        return candidate;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
    }
  } catch {
    throw new Error('trusted Windows PowerShell is unavailable');
  }
  throw new Error('trusted Windows PowerShell is unavailable');
}

function windowsMoveArguments(sourcePath: string, destinationPath: string): string[] {
  return [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    POWERSHELL_NO_REPLACE_MOVE_SCRIPT,
    Buffer.from(sourcePath, 'utf8').toString('base64url'),
    Buffer.from(destinationPath, 'utf8').toString('base64url'),
  ];
}

async function nativeWindowsMove(sourcePath: string, destinationPath: string): Promise<void> {
  const executable = await resolveWindowsPowerShellPath();
  await new Promise<void>((resolvePromise, rejectPromise) => {
    execFile(executable, windowsMoveArguments(sourcePath, destinationPath), WINDOWS_MOVE_OPTIONS, (error) =>
      error ? rejectPromise(error) : resolvePromise(),
    );
  });
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath, { bigint: true });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function verifyPublishedTarget(
  trusted: TrustedInbox,
  destinationPath: string,
  expectedTarget: BigIntStats,
  expectedHash: string,
): Promise<void> {
  verifyTrustedInbox(trusted);
  const publishedStats = await lstat(destinationPath, { bigint: true });
  const publishedRealPath = await realpath(destinationPath);
  const publishedCanonicalStats = await stat(publishedRealPath, { bigint: true });
  if (
    publishedStats.isSymbolicLink() ||
    !publishedStats.isFile() ||
    !samePublishedTarget(expectedTarget, publishedStats) ||
    !samePublishedTarget(expectedTarget, publishedCanonicalStats) ||
    !isWithin(trusted.realInbox, publishedRealPath) ||
    !samePath(publishedRealPath, destinationPath)
  ) {
    throw new ImportIntegrityError('published import identity changed');
  }
  const handle = await open(destinationPath, 'r');
  let failure: unknown = null;
  try {
    const handleStats = await handle.stat({ bigint: true });
    if (!samePublishedTarget(publishedStats, handleStats)) {
      throw new ImportIntegrityError('published import handle identity changed');
    }
    if ((await hashTarget(handle, Number(publishedStats.size))) !== expectedHash) {
      throw new ImportIntegrityError('published import hash changed');
    }
  } catch (error) {
    failure = error;
  }
  const closeError = await closeHandle(handle);
  if (closeError) throw new ImportIntegrityError('unable to close published import handle');
  if (failure) throw failure;
}

async function publishTarget(
  sourcePath: string,
  stagingPath: string,
  trusted: TrustedInbox,
  staging: TrustedStaging,
  expectedTarget: BigIntStats,
  expectedHash: string,
  hooks: ImportTestHooks,
): Promise<{ destinationName: string; stagingMoved: boolean }> {
  let stagingHandle: FileHandle | null = null;
  let publishedName: string | null = null;
  let stagingMoved = false;
  let failure: unknown = null;
  let useNativeMove = false;
  try {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const destinationName = uniqueFileName(sourceFileName(sourcePath));
      const destinationPath = join(trusted.inboxPath, destinationName);
      const context = { sourcePath, destinationPath, inboxPath: trusted.inboxPath };
      await hooks.beforePublish?.(context);
      verifyTrustedStaging(trusted, staging);
      if (useNativeMove) {
        const stagedStats = await stagedFileSnapshot(trusted, staging, stagingPath);
        if (!sameTargetSnapshot(expectedTarget, stagedStats)) {
          throw new ImportIntegrityError('staged import changed before native publish');
        }
        if (await pathExists(destinationPath)) continue;
        const publisher = hooks.nativeMovePublisher ?? nativeWindowsMove;
        let moveFailure: unknown = null;
        try {
          await publisher(stagingPath, destinationPath);
        } catch (error) {
          moveFailure = error;
        }
        const [sourceStillExists, destinationExists] = await Promise.all([
          pathExists(stagingPath),
          pathExists(destinationPath),
        ]);
        if (!sourceStillExists && destinationExists) {
          await verifyPublishedTarget(trusted, destinationPath, expectedTarget, expectedHash);
          publishedName = destinationName;
          stagingMoved = true;
          break;
        }
        if (sourceStillExists && destinationExists) continue;
        if (sourceStillExists && !destinationExists) {
          throw new ImportItemError('publish-unavailable');
        }
        throw new ImportIntegrityError(
          moveFailure ? 'native import publish ended in an unknown state' : 'native import publish lost its source',
        );
      }
      stagingHandle = await open(stagingPath, 'r');
      let collision = false;
      try {
        const handleStats = await stagingHandle.stat({ bigint: true });
        const stagingStats = await lstat(stagingPath, { bigint: true });
        const realStagedPath = await realpath(stagingPath);
        const canonicalStats = await stat(realStagedPath, { bigint: true });
        if (
          stagingStats.isSymbolicLink() ||
          !stagingStats.isFile() ||
          !sameTargetSnapshot(expectedTarget, handleStats) ||
          !sameTargetSnapshot(expectedTarget, stagingStats) ||
          !sameTargetSnapshot(expectedTarget, canonicalStats) ||
          !isWithin(staging.realStaging, realStagedPath) ||
          !samePath(realStagedPath, stagingPath)
        ) {
          throw new ImportIntegrityError('staged import identity changed before publish');
        }
        await link(stagingPath, destinationPath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EEXIST') collision = true;
        else if (
          code === 'EPERM' ||
          code === 'ENOTSUP' ||
          code === 'EOPNOTSUPP' ||
          code === 'ENOSYS' ||
          code === 'EXDEV'
        ) {
          if (process.platform !== 'win32' && !hooks.nativeMovePublisher) {
            throw new ImportItemError('publish-unavailable');
          }
          useNativeMove = true;
        } else throw error;
      }
      const attemptCloseError = await closeHandle(stagingHandle);
      stagingHandle = null;
      if (attemptCloseError) throw new ImportIntegrityError('unable to close staged import after publish attempt');
      if (collision) continue;
      if (useNativeMove) {
        attempt -= 1;
        continue;
      }
      await verifyPublishedTarget(trusted, destinationPath, expectedTarget, expectedHash);
      publishedName = destinationName;
      break;
    }
  } catch (error) {
    failure = error;
  }
  const closeError = await closeHandle(stagingHandle);
  if (closeError) throw new ImportIntegrityError('unable to close staged import after publish');
  if (failure) throw failure;
  if (!publishedName) {
    // A collision can only arrive from another writer after the generated name was chosen.
    // Retry is bounded so an adversarial writer cannot keep the main process in an infinite loop.
    throw new ImportItemError('copy-failed');
  }
  return { destinationName: publishedName, stagingMoved };
}

async function writeAll(handle: FileHandle, chunk: Buffer, position: number): Promise<void> {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset, position + offset);
    if (bytesWritten <= 0) throw new ImportItemError('copy-failed');
    offset += bytesWritten;
  }
}

async function copyOneFile(
  sourcePath: string,
  trusted: TrustedInbox,
  staging: TrustedStaging,
  hooks: ImportTestHooks,
): Promise<{ destinationName: string; size: number }> {
  let sourceHandle: FileHandle | null = null;
  let targetHandle: FileHandle | null = null;
  let targetIdentity: BigIntStats | null = null;
  let destinationPath = '';
  let context: ImportTestContext | null = null;
  let created = false;
  let cleanupAttempted = false;
  let output: { destinationName: string; size: number } | null = null;
  let failure: unknown = null;

  try {
    sourceHandle = await open(sourcePath, 'r');
    const source = await sourceSnapshot(sourcePath, sourceHandle);
    if (source.identity.size > MAX_FILE_SIZE) throw new ImportItemError('too-large');
    verifyTrustedInbox(trusted);
    destinationPath = join(staging.stagingPath, `.import-${randomUUID()}.partial`);
    context = { sourcePath, destinationPath, inboxPath: trusted.inboxPath };
    await hooks.beforeTargetOpen?.(context);
    verifyTrustedStaging(trusted, staging);
    targetHandle = await open(destinationPath, 'wx+');
    created = true;
    targetIdentity = await targetHandle.stat({ bigint: true });
    if (!targetIdentity.isFile() || !hasStrongIdentity(targetIdentity)) {
      throw new ImportIntegrityError('import destination has no strong identity');
    }
    await hooks.afterTargetOpen?.(context);
    await verifyTarget(trusted, destinationPath, targetIdentity, targetHandle);

    const readHash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(COPY_CHUNK_SIZE);
    let bytesWritten = 0;
    let chunkHookCalled = false;
    while (true) {
      const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, bytesWritten);
      if (bytesRead === 0) break;
      if (bytesWritten + bytesRead > MAX_FILE_SIZE) throw new ImportItemError('too-large');
      const chunk = buffer.subarray(0, bytesRead);
      readHash.update(chunk);
      await writeAll(targetHandle, chunk, bytesWritten);
      bytesWritten += bytesRead;
      if (!chunkHookCalled) {
        chunkHookCalled = true;
        await hooks.afterChunkWritten?.(context);
      }
    }

    const beforeSync = await targetHandle.stat({ bigint: true });
    if (Number(beforeSync.size) > MAX_FILE_SIZE) throw new ImportItemError('too-large');
    if (!sameStrongIdentity(targetIdentity, beforeSync) || Number(beforeSync.size) !== bytesWritten) {
      throw new ImportIntegrityError('import destination size changed');
    }
    await targetHandle.sync();
    const afterSync = await targetHandle.stat({ bigint: true });
    if (Number(afterSync.size) > MAX_FILE_SIZE) throw new ImportItemError('too-large');
    if (!sameStrongIdentity(targetIdentity, afterSync) || Number(afterSync.size) !== bytesWritten) {
      throw new ImportIntegrityError('import destination size changed');
    }
    await verifySource(source, sourceHandle);
    const currentTarget = await verifyTarget(trusted, destinationPath, targetIdentity, targetHandle);
    const currentTargetSize = Number(currentTarget.size);
    if (currentTargetSize > MAX_FILE_SIZE || currentTargetSize !== bytesWritten) {
      throw new ImportItemError(currentTargetSize > MAX_FILE_SIZE ? 'too-large' : 'copy-failed');
    }
    await hooks.beforeTargetHash?.(context);
    const targetHash = await hashTarget(targetHandle, bytesWritten);
    const sourceHash = readHash.digest('hex');
    if (targetHash !== sourceHash) throw new ImportIntegrityError('import destination hash mismatch');
    const finalTarget = await verifyTarget(trusted, destinationPath, targetIdentity, targetHandle);
    if (!sameTargetSnapshot(currentTarget, finalTarget) || Number(finalTarget.size) !== bytesWritten) {
      throw new ImportIntegrityError('import destination changed during verification');
    }
    const targetCloseBeforePublish = await closeHandle(targetHandle);
    targetHandle = null;
    if (targetCloseBeforePublish) throw new ImportIntegrityError('unable to close staged import before publish');
    const sourceCloseBeforePublish = await closeHandle(sourceHandle);
    sourceHandle = null;
    if (sourceCloseBeforePublish) throw new ImportIntegrityError('unable to close source before publish');
    const published = await publishTarget(
      sourcePath,
      destinationPath,
      trusted,
      staging,
      finalTarget,
      targetHash,
      hooks,
    );
    if (published.stagingMoved) {
      created = false;
    } else {
      cleanupAttempted = true;
      await hooks.beforeCleanup?.(context);
      await deleteStagedFile(trusted, staging, destinationPath, targetIdentity);
      created = false;
    }
    output = { destinationName: published.destinationName, size: Number(finalTarget.size) };
  } catch (error) {
    failure = error;
  }

  const targetCloseError = await closeHandle(targetHandle);
  targetHandle = null;
  const sourceCloseError = await closeHandle(sourceHandle);
  sourceHandle = null;
  if (targetCloseError || sourceCloseError) failure = failure ?? targetCloseError ?? sourceCloseError;

  if (failure || !output) {
    if (created && !cleanupAttempted) {
      if (!context || !targetIdentity) throw new ImportIntegrityError('created import target identity is unavailable');
      cleanupAttempted = true;
      try {
        await hooks.beforeCleanup?.(context);
      } catch {
        throw new ImportIntegrityError('unable to safely prepare imported file cleanup');
      }
      await deleteStagedFile(trusted, staging, destinationPath, targetIdentity);
    }
    if (failure instanceof ImportIntegrityError || failure instanceof ImportItemError) throw failure;
    throw new ImportItemError(
      (failure as NodeJS.ErrnoException | null)?.code === 'ENOENT' ? 'unavailable' : 'copy-failed',
    );
  }
  return output;
}

async function importTaskFilesImpl(
  input: { workspacePath: string; taskId: string; sourcePaths: string[] },
  hooks: ImportTestHooks,
): Promise<ImportFilesResult> {
  const taskId = validateImportTaskId(input.taskId);
  const inbox = trustedInbox(input.workspacePath, taskId, true);
  if (!inbox) throw new Error('trusted task inbox is unavailable');
  const staging = resolveTrustedStaging(inbox);
  await collectStagingGarbage(inbox, staging);
  const result: ImportFilesResult = { imported: [], rejected: [] };
  for (const sourcePath of input.sourcePaths) {
    const fileName = sourceFileName(sourcePath);
    const mimeType = sourceMimeType(fileName);
    if (!mimeType) {
      result.rejected.push(rejection(fileName, 'unsupported'));
      continue;
    }
    try {
      const copied = await copyOneFile(sourcePath, inbox, staging, hooks);
      result.imported.push({
        fileName: copied.destinationName,
        localPath: localPath(taskId, copied.destinationName),
        mimeType,
        size: copied.size,
      });
    } catch (error) {
      if (error instanceof ImportIntegrityError) throw error;
      const reason = error instanceof ImportItemError ? error.reason : 'copy-failed';
      result.rejected.push(rejection(fileName, reason));
    }
  }
  return result;
}

export async function importTaskFiles(input: {
  workspacePath: string;
  taskId: string;
  sourcePaths: string[];
}): Promise<ImportFilesResult> {
  return importTaskFilesImpl(input, {});
}

function codePointCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function closeDirectory(directory: Dir, failure: unknown): never {
  try {
    directory.closeSync();
  } catch {
    throw new ImportIntegrityError('unable to close imported file listing');
  }
  throw failure;
}

export function listImportedTaskFiles(workspacePath: string, taskIdValue: string): ImportedTaskFile[] {
  const taskId = validateImportTaskId(taskIdValue);
  const inbox = trustedInbox(workspacePath, taskId, false);
  if (!inbox) return [];
  verifyTrustedInbox(inbox);
  const files: Array<{ item: ImportedTaskFile; mtimeMs: number }> = [];
  const directory = opendirSync(inbox.realInbox);
  try {
    for (let visited = 0; visited < MAX_LIST_VISITED; visited += 1) {
      const entry = directory.readSync();
      if (!entry) break;
      if (!entry.isFile() || entry.name.startsWith('~$')) continue;
      const mimeType = storedMimeType(entry.name);
      if (!mimeType) continue;
      try {
        const fullPath = join(inbox.realInbox, entry.name);
        const stats = lstatSync(fullPath, { bigint: true });
        const realFile = realpathSync.native(fullPath);
        if (
          !stats.isFile() ||
          stats.isSymbolicLink() ||
          !hasStrongIdentity(stats) ||
          stats.size > MAX_FILE_SIZE ||
          !isWithin(inbox.realInbox, realFile) ||
          !samePath(realFile, fullPath) ||
          !sameStrongIdentity(stats, statSync(realFile, { bigint: true }))
        ) {
          continue;
        }
        files.push({
          item: { fileName: entry.name, localPath: localPath(taskId, entry.name), mimeType, size: Number(stats.size) },
          mtimeMs: Number(stats.mtimeMs),
        });
      } catch {
        continue;
      }
    }
    directory.closeSync();
  } catch (error) {
    closeDirectory(directory, error);
  }
  verifyTrustedInbox(inbox);
  return files
    .sort((left, right) => right.mtimeMs - left.mtimeMs || codePointCompare(left.item.fileName, right.item.fileName))
    .slice(0, MAX_LIST_RESULTS)
    .map((entry) => entry.item);
}

export const __testing = Object.freeze({
  /**
   * 身份判定只给测试用。
   *
   * ⚠️ 为什么必须露出来：`sameStrongIdentity` 是否**精确**，用真文件测不出来 ——
   *    造不出"只有 dev/ino 不同"的形态（size/mtime 能对齐，ctime 改不了）。
   *    而它答错的代价是：把**别的内容**当成用户选的那份导进来，且**不报错**。
   *    ⇒ 只能在函数层用合成的 bigint stats 钉。
   */
  sameStrongIdentity,
  sameSourceSnapshot,
  nativeWindowsMove,
  resolveWindowsPowerShellPath,
  windowsMoveOptions: WINDOWS_MOVE_OPTIONS,
  windowsMoveArguments,
  importTaskFiles: (
    input: { workspacePath: string; taskId: string; sourcePaths: string[] },
    hooks: ImportTestHooks,
  ): Promise<ImportFilesResult> => importTaskFilesImpl(input, hooks),
  collectStagingGarbage: async (
    input: { workspacePath: string; taskId: string },
    hooks: StagingGarbageTestHooks = {},
  ): Promise<void> => {
    const inbox = trustedInbox(input.workspacePath, input.taskId, true);
    if (!inbox) throw new Error('trusted task inbox is unavailable');
    const staging = resolveTrustedStaging(inbox);
    await collectStagingGarbage(inbox, staging, hooks);
  },
});
