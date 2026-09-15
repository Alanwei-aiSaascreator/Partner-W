import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import type { FileIndexEntry, FileReadResult, TaskContextSource } from '@clawwork/shared';
import { getSqlite } from '../db/index.js';
import { scanFolder } from './file-index.js';
import { readContextFile } from './file-reader.js';

interface SourceRow {
  id: string;
  task_id: string;
  kind: 'folder';
  absolute_path: string;
  display_name: string;
  created_at: string;
  last_seen_at: string;
}

function database() {
  const sqlite = getSqlite();
  if (!sqlite) throw new Error('context source database is unavailable');
  return sqlite;
}

function nativeRealpath(targetPath: string): string {
  return realpathSync.native(targetPath);
}

function trustedCurrentRoot(source: SourceRow): string {
  // Grants authorize a canonical path, not a persisted disk-object identity. Recreating an
  // ordinary directory at this same path remains authorized between operations; a symlink or
  // junction resolving the stored path somewhere else is never authorized.
  let currentPath: string;
  try {
    currentPath = nativeRealpath(source.absolute_path);
    if (!statSync(currentPath).isDirectory()) throw new Error();
  } catch {
    throw new Error('context source is unavailable');
  }

  if (relative(source.absolute_path, currentPath) !== '') {
    throw new Error('context source path changed');
  }
  return currentPath;
}

function isAvailable(source: SourceRow): boolean {
  try {
    trustedCurrentRoot(source);
    return true;
  } catch {
    return false;
  }
}

function toSource(row: SourceRow): TaskContextSource {
  return {
    id: row.id,
    taskId: row.task_id,
    kind: row.kind,
    absolutePath: row.absolute_path,
    displayName: row.display_name,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    availability: isAvailable(row) ? 'available' : 'missing',
  };
}

function findSource(taskId: string, sourceId: string): SourceRow {
  const row = database()
    .prepare('SELECT * FROM task_context_sources WHERE task_id = ? AND id = ?')
    .get(taskId, sourceId) as SourceRow | undefined;
  if (!row) throw new Error('context source is not available for this task');
  return row;
}

export function createFolderSource(input: { taskId: string; absolutePath: string }): TaskContextSource {
  if (!input.taskId?.trim()) throw new Error('taskId is required');
  if (!input.absolutePath?.trim()) throw new Error('folder path is required');

  let realFolder: string;
  try {
    realFolder = nativeRealpath(input.absolutePath);
    if (!statSync(realFolder).isDirectory()) throw new Error();
  } catch {
    throw new Error('selected folder is unavailable');
  }

  const sqlite = database();
  const existing = sqlite
    .prepare('SELECT * FROM task_context_sources WHERE task_id = ? AND absolute_path = ?')
    .get(input.taskId, realFolder) as SourceRow | undefined;
  if (existing) return toSource(existing);

  const now = new Date().toISOString();
  const row: SourceRow = {
    id: randomUUID(),
    task_id: input.taskId,
    kind: 'folder',
    absolute_path: realFolder,
    display_name: basename(realFolder),
    created_at: now,
    last_seen_at: now,
  };
  try {
    sqlite
      .prepare(
        `INSERT INTO task_context_sources
         (id, task_id, kind, absolute_path, display_name, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.task_id, row.kind, row.absolute_path, row.display_name, row.created_at, row.last_seen_at);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message.includes('FOREIGN KEY constraint failed')) throw new Error('task does not exist');
    throw error;
  }
  return toSource(row);
}

export function listTaskContextSources(taskId: string): TaskContextSource[] {
  if (!taskId?.trim()) throw new Error('taskId is required');
  const rows = database()
    .prepare('SELECT * FROM task_context_sources WHERE task_id = ? ORDER BY created_at ASC')
    .all(taskId) as SourceRow[];
  return rows.map(toSource);
}

export function revokeTaskContextSource(taskId: string, sourceId: string): boolean {
  if (!taskId?.trim() || !sourceId?.trim()) throw new Error('taskId and sourceId are required');
  const result = database()
    .prepare('DELETE FROM task_context_sources WHERE task_id = ? AND id = ?')
    .run(taskId, sourceId);
  return result.changes > 0;
}

export function resolveGrantedFile(taskId: string, sourceId: string, relativePath: string): string {
  if (!taskId?.trim() || !sourceId?.trim()) throw new Error('taskId and sourceId are required');
  if (typeof relativePath !== 'string' || relativePath.length === 0) throw new Error('relativePath is required');
  if (relativePath.includes('\0')) throw new Error('relativePath is invalid');
  if (isAbsolute(relativePath)) throw new Error('relativePath must be relative');

  const source = findSource(taskId, sourceId);
  const realRoot = trustedCurrentRoot(source);
  let realTarget: string;
  try {
    realTarget = nativeRealpath(resolve(realRoot, relativePath));
  } catch {
    throw new Error('requested file is unavailable');
  }

  const fromRoot = relative(realRoot, realTarget);
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error('requested file is outside the granted folder');
  }
  return realTarget;
}

export function listGrantedFiles(taskId: string, sourceId: string, query?: string): FileIndexEntry[] {
  const source = findSource(taskId, sourceId);
  trustedCurrentRoot(source);
  return scanFolder(source.absolute_path, { query });
}

export function readGrantedFile(taskId: string, sourceId: string, relativePath: string): FileReadResult {
  const realTarget = resolveGrantedFile(taskId, sourceId, relativePath);
  const source = findSource(taskId, sourceId);
  trustedCurrentRoot(source);
  return readContextFile(realTarget, [source.absolute_path]);
}
