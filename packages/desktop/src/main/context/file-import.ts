import type { ImportFileRejectionReason, ImportFilesResult, ImportedTaskFile } from '@clawwork/shared';
import { createHash, randomUUID } from 'node:crypto';
import type { Dir, Stats } from 'node:fs';
import { existsSync, lstatSync, mkdirSync, opendirSync, realpathSync, statSync } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { link, lstat, open, realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ensureTaskDir } from '../workspace/init.js';
import { uniqueFileName } from '../workspace/safe-name.js';
import { getMimeType } from './file-types.js';

const MAX_FILE_SIZE = 100 * 1024 * 1024;
const COPY_CHUNK_SIZE = 1024 * 1024;
const MAX_LIST_VISITED = 2000;
const MAX_LIST_RESULTS = 100;
const TIMESTAMP_TOLERANCE_MS = 0;

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
  taskIdentity: Stats;
  inboxIdentity: Stats;
}

interface TrustedStaging {
  stagingPath: string;
  realStaging: string;
  stagingIdentity: Stats;
}

interface SourceSnapshot {
  selectedPath: string;
  canonicalPath: string;
  identity: Stats;
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

function hasStrongIdentity(stats: Stats): boolean {
  return Number.isFinite(stats.dev) && Number.isFinite(stats.ino) && stats.dev > 0 && stats.ino > 0;
}

function sameStrongIdentity(left: Stats, right: Stats): boolean {
  return hasStrongIdentity(left) && hasStrongIdentity(right) && left.dev === right.dev && left.ino === right.ino;
}

function sameTimestamp(left: number, right: number): boolean {
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= TIMESTAMP_TOLERANCE_MS;
}

function sameSourceSnapshot(left: Stats, right: Stats): boolean {
  return (
    sameStrongIdentity(left, right) &&
    left.size === right.size &&
    sameTimestamp(left.mtimeMs, right.mtimeMs) &&
    sameTimestamp(left.ctimeMs, right.ctimeMs)
  );
}

function sameTargetSnapshot(left: Stats, right: Stats): boolean {
  return sameSourceSnapshot(left, right);
}

function samePublishedTarget(left: Stats, right: Stats): boolean {
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
  const workspaceStats = lstatSync(workspacePath);
  if (!workspaceStats.isDirectory()) throw new Error();
  const taskPath = join(workspacePath, taskId);
  if (!existsSync(taskPath)) {
    if (!create) return null;
    ensureTaskDir(workspacePath, taskId);
  }
  const taskStats = lstatSync(taskPath);
  if (taskStats.isSymbolicLink() || !taskStats.isDirectory() || !hasStrongIdentity(taskStats)) throw new Error();
  const realTask = realpathSync.native(taskPath);
  if (!isWithin(realWorkspace, realTask) || !samePath(realTask, resolve(realWorkspace, taskId))) throw new Error();

  const inboxPath = join(taskPath, 'inbox');
  if (!existsSync(inboxPath)) {
    if (!create) return null;
    mkdirSync(inboxPath);
  }
  const inboxStats = lstatSync(inboxPath);
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
    const taskStats = lstatSync(trusted.taskPath);
    const inboxStats = lstatSync(trusted.inboxPath);
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
    const stagingIdentity = lstatSync(stagingPath);
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
    const stats = lstatSync(staging.stagingPath);
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

function sourceFileName(sourcePath: string): string {
  return basename(sourcePath.replaceAll('\\', '/'));
}

function regularMimeType(extension: string): string {
  return LEGACY_OFFICE_MIME[extension] ?? getMimeType(extension);
}

function sourceMimeType(fileName: string): string | null {
  const lowerName = fileName.toLowerCase();
  if (lowerName.startsWith('~$')) return null;
  if (SPECIAL_NAMES.has(lowerName)) return 'text/plain';
  if (lowerName.startsWith('.')) return null;
  const extension = extname(lowerName);
  return IMPORT_EXTENSIONS.has(extension) ? regularMimeType(extension) : null;
}

function storedMimeType(fileName: string): string | null {
  const lowerName = fileName.toLowerCase();
  for (const specialName of SPECIAL_NAMES) {
    if (lowerName === specialName) return 'text/plain';
    const prefix = `${specialName}-`;
    if (lowerName.startsWith(prefix) && /^[a-f0-9]{8}$/.test(lowerName.slice(prefix.length))) return 'text/plain';
  }
  if (lowerName.startsWith('.')) return null;
  const extension = extname(lowerName);
  return IMPORT_EXTENSIONS.has(extension) ? regularMimeType(extension) : null;
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
  const handleStats = await handle.stat();
  const linkStats = await lstat(selectedPath);
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
  const canonicalStats = await stat(canonicalPath);
  if (!canonicalStats.isFile() || !sameStrongIdentity(handleStats, canonicalStats)) {
    throw new ImportItemError('unavailable');
  }
  return { selectedPath, canonicalPath, identity: handleStats };
}

async function verifySource(source: SourceSnapshot, handle: FileHandle): Promise<void> {
  try {
    const handleStats = await handle.stat();
    const linkStats = await lstat(source.selectedPath);
    const currentCanonical = await realpath(source.selectedPath);
    const canonicalStats = await stat(currentCanonical);
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
  targetIdentity: Stats,
  handle: FileHandle,
): Promise<Stats> {
  verifyTrustedInbox(trusted);
  const handleStats = await handle.stat();
  const linkStats = await lstat(destinationPath);
  const canonicalPath = await realpath(destinationPath);
  const canonicalStats = await stat(canonicalPath);
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

async function publishTarget(
  sourcePath: string,
  stagingPath: string,
  trusted: TrustedInbox,
  staging: TrustedStaging,
  expectedTarget: Stats,
  hooks: ImportTestHooks,
): Promise<string> {
  let stagingHandle: FileHandle | null = null;
  let publishedName: string | null = null;
  let failure: unknown = null;
  try {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const destinationName = uniqueFileName(sourceFileName(sourcePath));
      const destinationPath = join(trusted.inboxPath, destinationName);
      const context = { sourcePath, destinationPath, inboxPath: trusted.inboxPath };
      await hooks.beforePublish?.(context);
      verifyTrustedStaging(trusted, staging);
      stagingHandle = await open(stagingPath, 'r');
      let collision = false;
      try {
        const handleStats = await stagingHandle.stat();
        const stagingStats = await lstat(stagingPath);
        const realStagedPath = await realpath(stagingPath);
        const canonicalStats = await stat(realStagedPath);
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
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') collision = true;
        else throw error;
      }
      const attemptCloseError = await closeHandle(stagingHandle);
      stagingHandle = null;
      if (attemptCloseError) throw new ImportIntegrityError('unable to close staged import after publish attempt');
      if (collision) continue;
      const publishedStats = await lstat(destinationPath);
      const publishedRealPath = await realpath(destinationPath);
      const publishedCanonicalStats = await stat(publishedRealPath);
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
  return publishedName;
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
  let targetIdentity: Stats | null = null;
  let destinationPath = '';
  let context: ImportTestContext | null = null;
  let created = false;
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
    targetIdentity = await targetHandle.stat();
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

    const beforeSync = await targetHandle.stat();
    if (beforeSync.size > MAX_FILE_SIZE) throw new ImportItemError('too-large');
    if (!sameStrongIdentity(targetIdentity, beforeSync) || beforeSync.size !== bytesWritten) {
      throw new ImportIntegrityError('import destination size changed');
    }
    await targetHandle.sync();
    const afterSync = await targetHandle.stat();
    if (afterSync.size > MAX_FILE_SIZE) throw new ImportItemError('too-large');
    if (!sameStrongIdentity(targetIdentity, afterSync) || afterSync.size !== bytesWritten) {
      throw new ImportIntegrityError('import destination size changed');
    }
    await verifySource(source, sourceHandle);
    const currentTarget = await verifyTarget(trusted, destinationPath, targetIdentity, targetHandle);
    if (currentTarget.size > MAX_FILE_SIZE || currentTarget.size !== bytesWritten) {
      throw new ImportItemError(currentTarget.size > MAX_FILE_SIZE ? 'too-large' : 'copy-failed');
    }
    await hooks.beforeTargetHash?.(context);
    const targetHash = await hashTarget(targetHandle, bytesWritten);
    if (targetHash !== readHash.digest('hex')) throw new ImportIntegrityError('import destination hash mismatch');
    const finalTarget = await verifyTarget(trusted, destinationPath, targetIdentity, targetHandle);
    if (!sameTargetSnapshot(currentTarget, finalTarget) || finalTarget.size !== bytesWritten) {
      throw new ImportIntegrityError('import destination changed during verification');
    }
    const targetCloseBeforePublish = await closeHandle(targetHandle);
    targetHandle = null;
    if (targetCloseBeforePublish) throw new ImportIntegrityError('unable to close staged import before publish');
    const sourceCloseBeforePublish = await closeHandle(sourceHandle);
    sourceHandle = null;
    if (sourceCloseBeforePublish) throw new ImportIntegrityError('unable to close source before publish');
    const destinationName = await publishTarget(sourcePath, destinationPath, trusted, staging, finalTarget, hooks);
    output = { destinationName, size: finalTarget.size };
  } catch (error) {
    failure = error;
  }

  const targetCloseError = await closeHandle(targetHandle);
  targetHandle = null;
  const sourceCloseError = await closeHandle(sourceHandle);
  sourceHandle = null;
  if (targetCloseError || sourceCloseError) failure = failure ?? targetCloseError ?? sourceCloseError;

  if (failure || !output) {
    if (created) {
      if (!context || !targetIdentity) throw new ImportIntegrityError('created import target identity is unavailable');
      try {
        await hooks.beforeCleanup?.(context);
      } catch {
        throw new ImportIntegrityError('unable to safely prepare imported file cleanup');
      }
      // Node has no directory-relative unlink. Keep the permanently hidden staging entry instead of
      // introducing a verify-then-unlink race against a path that a same-privilege process can replace.
      verifyTrustedStaging(trusted, staging);
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
        const stats = lstatSync(fullPath);
        const realFile = realpathSync.native(fullPath);
        if (
          !stats.isFile() ||
          stats.isSymbolicLink() ||
          !hasStrongIdentity(stats) ||
          stats.size > MAX_FILE_SIZE ||
          !isWithin(inbox.realInbox, realFile) ||
          !samePath(realFile, fullPath) ||
          !sameStrongIdentity(stats, statSync(realFile))
        ) {
          continue;
        }
        files.push({
          item: { fileName: entry.name, localPath: localPath(taskId, entry.name), mimeType, size: stats.size },
          mtimeMs: stats.mtimeMs,
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
  importTaskFiles: (
    input: { workspacePath: string; taskId: string; sourcePaths: string[] },
    hooks: ImportTestHooks,
  ): Promise<ImportFilesResult> => importTaskFilesImpl(input, hooks),
});
