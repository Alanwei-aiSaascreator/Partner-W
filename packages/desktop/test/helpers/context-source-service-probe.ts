import { rmSync } from 'node:fs';
import { initDatabase, closeDatabase, getSqlite } from '../../src/main/db/index.js';
import {
  createFolderSource,
  listGrantedFiles,
  listTaskContextSources,
  readGrantedFile,
  resolveGrantedFile,
  revokeTaskContextSource,
} from '../../src/main/context/source-service.js';

const [, , workspacePath, scenario, grantedPath, outsidePath = ''] = process.argv;

function capture(fn: () => unknown): { value?: unknown; error?: string } {
  try {
    return { value: fn() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function insertTask(id: string): void {
  getSqlite()!
    .prepare(
      `INSERT INTO tasks
       (id, session_key, session_id, title, status, created_at, updated_at, tags, artifact_dir, gateway_id)
       VALUES (?, ?, '', '', 'active', ?, ?, '[]', '', '')`,
    )
    .run(id, `session-${id}`, new Date().toISOString(), new Date().toISOString());
}

initDatabase(workspacePath);
insertTask('task-1');
insertTask('task-2');

let result: Record<string, unknown>;
if (scenario === 'lifecycle') {
  const source = createFolderSource({ taskId: 'task-1', absolutePath: grantedPath });
  const duplicate = createFolderSource({ taskId: 'task-1', absolutePath: grantedPath });
  result = {
    source,
    duplicate,
    listed: listTaskContextSources('task-1'),
    files: listGrantedFiles('task-1', source.id),
    queried: listGrantedFiles('task-1', source.id, 'inside'),
    read: readGrantedFile('task-1', source.id, 'inside.txt'),
  };
} else if (scenario === 'missing') {
  createFolderSource({ taskId: 'task-1', absolutePath: grantedPath });
  rmSync(grantedPath, { recursive: true, force: true });
  result = { listed: listTaskContextSources('task-1') };
} else {
  const source = createFolderSource({ taskId: 'task-1', absolutePath: grantedPath });
  result = {
    parentEscape: capture(() => resolveGrantedFile('task-1', source.id, '../outside.txt')),
    absolute: capture(() => resolveGrantedFile('task-1', source.id, outsidePath)),
    empty: capture(() => resolveGrantedFile('task-1', source.id, '')),
    nul: capture(() => resolveGrantedFile('task-1', source.id, 'inside.txt\0tail')),
    symlink: capture(() => resolveGrantedFile('task-1', source.id, 'linked.txt')),
    otherTaskResolve: capture(() => resolveGrantedFile('task-2', source.id, 'inside.txt')),
    wrongTaskRevoke: revokeTaskContextSource('task-2', source.id),
    stillReadable: capture(() => readGrantedFile('task-1', source.id, 'inside.txt')),
    revoked: revokeTaskContextSource('task-1', source.id),
    afterRevoke: capture(() => readGrantedFile('task-1', source.id, 'inside.txt')),
  };
}

closeDatabase();
process.stdout.write(`CONTEXT_SOURCE_RESULT=${JSON.stringify(result)}\n`);
