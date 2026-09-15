import type { ImportFileRejectionReason, ImportFilesResult, ImportedTaskFile } from '@clawwork/shared';
import type { Stats } from 'node:fs';
import { COPYFILE_EXCL } from 'node:constants';
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { copyFile, lstat, realpath, stat, unlink } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ensureTaskDir } from '../workspace/init.js';
import { uniqueFileName } from '../workspace/safe-name.js';
import { getMimeType } from './file-types.js';

const MAX_FILE_SIZE = 100 * 1024 * 1024;

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
  taskIdentity: { dev: number; ino: number };
  inboxIdentity: { dev: number; ino: number };
}

interface SourceSnapshot {
  selectedPath: string;
  canonicalPath: string;
  identity: Stats;
}

class ImportRejectionError extends Error {
  constructor(readonly reason: ImportFileRejectionReason) {
    super(reason);
  }
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' || process.platform === 'darwin'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function isWithin(parent: string, child: string): boolean {
  const fromParent = relative(parent, child);
  return fromParent === '' || (!fromParent.startsWith(`..${sep}`) && fromParent !== '..' && !isAbsolute(fromParent));
}

function sameIdentity(left: Stats, right: Stats): boolean {
  const hasDevAndIno =
    Number.isFinite(left.dev) &&
    Number.isFinite(left.ino) &&
    Number.isFinite(right.dev) &&
    Number.isFinite(right.ino) &&
    left.dev > 0 &&
    left.ino > 0 &&
    right.dev > 0 &&
    right.ino > 0;
  if (hasDevAndIno) return left.dev === right.dev && left.ino === right.ino;
  const hasFallback =
    Number.isFinite(left.birthtimeMs) &&
    Number.isFinite(right.birthtimeMs) &&
    left.birthtimeMs > 0 &&
    right.birthtimeMs > 0 &&
    Number.isFinite(left.size) &&
    Number.isFinite(right.size) &&
    Number.isFinite(left.mtimeMs) &&
    Number.isFinite(right.mtimeMs);
  return (
    hasFallback && left.birthtimeMs === right.birthtimeMs && left.size === right.size && left.mtimeMs === right.mtimeMs
  );
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
  let realWorkspace: string;
  try {
    realWorkspace = realpathSync.native(workspacePath);
  } catch {
    throw new Error('trusted task inbox is unavailable');
  }

  const workspaceStats = lstatSync(workspacePath);
  if (!workspaceStats.isDirectory()) throw new Error('trusted task inbox is unavailable');
  const taskPath = join(workspacePath, taskId);
  if (!existsSync(taskPath)) {
    if (!create) return null;
    ensureTaskDir(workspacePath, taskId);
  }
  const taskStats = lstatSync(taskPath);
  if (taskStats.isSymbolicLink() || !taskStats.isDirectory()) throw new Error('trusted task inbox is unavailable');
  const realTask = realpathSync.native(taskPath);
  if (!isWithin(realWorkspace, realTask) || !samePath(realTask, resolve(realWorkspace, taskId))) {
    throw new Error('trusted task inbox is unavailable');
  }

  const inboxPath = join(taskPath, 'inbox');
  if (!existsSync(inboxPath)) {
    if (!create) return null;
    mkdirSync(inboxPath);
  }
  const inboxStats = lstatSync(inboxPath);
  if (inboxStats.isSymbolicLink() || !inboxStats.isDirectory()) throw new Error('trusted task inbox is unavailable');
  const realInbox = realpathSync.native(inboxPath);
  if (!isWithin(realTask, realInbox) || !samePath(realInbox, resolve(realTask, 'inbox'))) {
    throw new Error('trusted task inbox is unavailable');
  }

  return {
    workspacePath,
    taskPath,
    inboxPath,
    realWorkspace,
    realTask,
    realInbox,
    taskIdentity: { dev: taskStats.dev, ino: taskStats.ino },
    inboxIdentity: { dev: inboxStats.dev, ino: inboxStats.ino },
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

function checkTrustedInbox(trusted: TrustedInbox): void {
  const taskStats = lstatSync(trusted.taskPath);
  const inboxStats = lstatSync(trusted.inboxPath);
  if (
    taskStats.isSymbolicLink() ||
    inboxStats.isSymbolicLink() ||
    !taskStats.isDirectory() ||
    !inboxStats.isDirectory() ||
    taskStats.dev !== trusted.taskIdentity.dev ||
    taskStats.ino !== trusted.taskIdentity.ino ||
    inboxStats.dev !== trusted.inboxIdentity.dev ||
    inboxStats.ino !== trusted.inboxIdentity.ino ||
    !samePath(realpathSync.native(trusted.workspacePath), trusted.realWorkspace) ||
    !samePath(realpathSync.native(trusted.taskPath), trusted.realTask) ||
    !samePath(realpathSync.native(trusted.inboxPath), trusted.realInbox)
  ) {
    throw new Error('trusted task inbox changed');
  }
}

function verifyTrustedInbox(trusted: TrustedInbox): void {
  try {
    checkTrustedInbox(trusted);
  } catch {
    throw new Error('trusted task inbox changed');
  }
}

function sourceFileName(sourcePath: string): string {
  return basename(sourcePath.replaceAll('\\', '/'));
}

function importMimeType(extension: string): string {
  return LEGACY_OFFICE_MIME[extension] ?? getMimeType(extension);
}

function localPath(taskId: string, fileName: string): string {
  return [taskId, 'inbox', fileName].join('/');
}

function rejection(fileName: string, reason: ImportFileRejectionReason): ImportFilesResult['rejected'][number] {
  return { fileName, reason };
}

async function cleanupCreatedFile(destinationPath: string): Promise<void> {
  await unlink(destinationPath).catch(() => undefined);
}

async function verifySourceSnapshot(source: SourceSnapshot): Promise<void> {
  try {
    const selectedStats = await lstat(source.selectedPath);
    if (!selectedStats.isFile() || selectedStats.isSymbolicLink()) throw new Error('source path changed');
    const currentCanonicalPath = await realpath(source.selectedPath);
    const currentIdentity = await stat(currentCanonicalPath);
    if (
      !samePath(currentCanonicalPath, source.canonicalPath) ||
      !currentIdentity.isFile() ||
      !sameIdentity(source.identity, currentIdentity) ||
      currentIdentity.size !== source.identity.size
    ) {
      throw new Error('source identity changed');
    }
  } catch {
    throw new ImportRejectionError('copy-failed');
  }
}

async function copyWithUniqueName(
  source: SourceSnapshot,
  trusted: TrustedInbox,
  fileName: string,
): Promise<{ destinationName: string; size: number }> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    verifyTrustedInbox(trusted);
    const destinationName = uniqueFileName(fileName);
    const destinationPath = join(trusted.inboxPath, destinationName);
    try {
      await copyFile(source.canonicalPath, destinationPath, COPYFILE_EXCL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
    try {
      verifyTrustedInbox(trusted);
      await verifySourceSnapshot(source);
      const destinationStats = await lstat(destinationPath);
      const realDestination = await realpath(destinationPath);
      if (
        destinationStats.isSymbolicLink() ||
        !destinationStats.isFile() ||
        !isWithin(trusted.realInbox, realDestination) ||
        !samePath(realDestination, resolve(trusted.realInbox, destinationName))
      ) {
        throw new Error('copied file escaped trusted task inbox');
      }
      if (destinationStats.size > MAX_FILE_SIZE) throw new ImportRejectionError('too-large');
      return { destinationName, size: destinationStats.size };
    } catch (error) {
      await cleanupCreatedFile(destinationPath);
      throw error;
    }
  }
  throw new Error('unable to allocate a unique inbox file name');
}

export async function importTaskFiles(input: {
  workspacePath: string;
  taskId: string;
  sourcePaths: string[];
}): Promise<ImportFilesResult> {
  const taskId = validateImportTaskId(input.taskId);
  const inbox = trustedInbox(input.workspacePath, taskId, true);
  if (!inbox) throw new Error('trusted task inbox is unavailable');
  const result: ImportFilesResult = { imported: [], rejected: [] };

  for (const sourcePath of input.sourcePaths) {
    const fileName = sourceFileName(sourcePath);
    let sourceStat: Awaited<ReturnType<typeof lstat>>;
    let source: SourceSnapshot;
    try {
      sourceStat = await lstat(sourcePath);
      if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error('not a regular file');
      const canonicalPath = await realpath(sourcePath);
      const canonicalStat = await stat(canonicalPath);
      if (!canonicalStat.isFile() || !sameIdentity(sourceStat, canonicalStat)) {
        throw new Error('source identity changed');
      }
      source = { selectedPath: sourcePath, canonicalPath, identity: canonicalStat };
    } catch {
      result.rejected.push(rejection(fileName, 'unavailable'));
      continue;
    }
    const extension = extname(fileName).toLowerCase();
    if (!IMPORT_EXTENSIONS.has(extension)) {
      result.rejected.push(rejection(fileName, 'unsupported'));
      continue;
    }
    if (source.identity.size > MAX_FILE_SIZE) {
      result.rejected.push(rejection(fileName, 'too-large'));
      continue;
    }
    try {
      const copied = await copyWithUniqueName(source, inbox, fileName);
      result.imported.push({
        fileName: copied.destinationName,
        localPath: localPath(taskId, copied.destinationName),
        mimeType: importMimeType(extension),
        size: copied.size,
      });
    } catch (error) {
      const reason =
        error instanceof ImportRejectionError
          ? error.reason
          : (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? 'unavailable'
            : 'copy-failed';
      result.rejected.push(rejection(fileName, reason));
    }
  }

  return result;
}

export function listImportedTaskFiles(workspacePath: string, taskIdValue: string): ImportedTaskFile[] {
  const taskId = validateImportTaskId(taskIdValue);
  const inbox = trustedInbox(workspacePath, taskId, false);
  if (!inbox) return [];
  verifyTrustedInbox(inbox);

  const entries = readdirSync(inbox.realInbox, { withFileTypes: true });
  verifyTrustedInbox(inbox);
  return entries
    .filter((entry) => entry.isFile() && !entry.name.startsWith('.') && !entry.name.startsWith('~$'))
    .map((entry) => {
      try {
        const extension = extname(entry.name).toLowerCase();
        if (!IMPORT_EXTENSIONS.has(extension)) return null;
        const fullPath = join(inbox.realInbox, entry.name);
        const stats = lstatSync(fullPath);
        const realFile = realpathSync.native(fullPath);
        if (
          !stats.isFile() ||
          stats.isSymbolicLink() ||
          !isWithin(inbox.realInbox, realFile) ||
          !samePath(realFile, resolve(inbox.realInbox, entry.name))
        ) {
          return null;
        }
        return {
          item: {
            fileName: entry.name,
            localPath: localPath(taskId, entry.name),
            mimeType: importMimeType(extension),
            size: stats.size,
          },
          mtimeMs: stats.mtimeMs,
        };
      } catch {
        return null;
      }
    })
    .filter((entry): entry is { item: ImportedTaskFile; mtimeMs: number } => entry !== null)
    .sort((left, right) => right.mtimeMs - left.mtimeMs || left.item.fileName.localeCompare(right.item.fileName))
    .map((entry) => entry.item);
}
