import type { ImportFileRejectionReason, ImportFilesResult, ImportedTaskFile } from '@clawwork/shared';
import { COPYFILE_EXCL } from 'node:constants';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { copyFile, lstat, mkdir } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { ensureTaskDir } from '../workspace/init.js';
import { uniqueFileName } from '../workspace/safe-name.js';
import { classifyTier, getMimeType } from './file-types.js';

const MAX_FILE_SIZE = 100 * 1024 * 1024;

function sourceFileName(sourcePath: string): string {
  return basename(sourcePath.replaceAll('\\', '/'));
}

function localPath(taskId: string, fileName: string): string {
  return [taskId, 'inbox', fileName].join('/');
}

function rejection(fileName: string, reason: ImportFileRejectionReason): ImportFilesResult['rejected'][number] {
  return { fileName, reason };
}

async function copyWithUniqueName(sourcePath: string, inboxDir: string, fileName: string): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const destinationName = uniqueFileName(fileName);
    try {
      await copyFile(sourcePath, join(inboxDir, destinationName), COPYFILE_EXCL);
      return destinationName;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new Error('unable to allocate a unique inbox file name');
}

export async function importTaskFiles(input: {
  workspacePath: string;
  taskId: string;
  sourcePaths: string[];
}): Promise<ImportFilesResult> {
  const taskDir = ensureTaskDir(input.workspacePath, input.taskId);
  const inboxDir = join(taskDir, 'inbox');
  await mkdir(inboxDir, { recursive: true });
  const result: ImportFilesResult = { imported: [], rejected: [] };

  for (const sourcePath of input.sourcePaths) {
    const fileName = sourceFileName(sourcePath);
    let sourceStat: Awaited<ReturnType<typeof lstat>>;
    try {
      sourceStat = await lstat(sourcePath);
    } catch {
      result.rejected.push(rejection(fileName, 'unavailable'));
      continue;
    }
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
      result.rejected.push(rejection(fileName, 'unavailable'));
      continue;
    }
    const extension = extname(fileName).toLowerCase();
    if (classifyTier(extension) === 'unsupported') {
      result.rejected.push(rejection(fileName, 'unsupported'));
      continue;
    }
    if (sourceStat.size > MAX_FILE_SIZE) {
      result.rejected.push(rejection(fileName, 'too-large'));
      continue;
    }
    try {
      const destinationName = await copyWithUniqueName(sourcePath, inboxDir, fileName);
      result.imported.push({
        fileName: destinationName,
        localPath: localPath(input.taskId, destinationName),
        mimeType: getMimeType(extension),
        size: sourceStat.size,
      });
    } catch {
      result.rejected.push(rejection(fileName, 'copy-failed'));
    }
  }

  return result;
}

export function listImportedTaskFiles(workspacePath: string, taskId: string): ImportedTaskFile[] {
  const taskDir = ensureTaskDir(workspacePath, taskId);
  const inboxDir = join(taskDir, 'inbox');
  if (!existsSync(inboxDir)) return [];

  return readdirSync(inboxDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith('.') && !entry.name.startsWith('~$'))
    .map((entry) => {
      const extension = extname(entry.name).toLowerCase();
      if (classifyTier(extension) === 'unsupported') return null;
      const stats = lstatSync(join(inboxDir, entry.name));
      if (!stats.isFile() || stats.isSymbolicLink()) return null;
      return {
        item: {
          fileName: entry.name,
          localPath: localPath(taskId, entry.name),
          mimeType: getMimeType(extension),
          size: stats.size,
        },
        mtimeMs: stats.mtimeMs,
      };
    })
    .filter((entry): entry is { item: ImportedTaskFile; mtimeMs: number } => entry !== null)
    .sort((left, right) => right.mtimeMs - left.mtimeMs || left.item.fileName.localeCompare(right.item.fileName))
    .map((entry) => entry.item);
}
