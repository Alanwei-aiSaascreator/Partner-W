import { closeDatabase, getSqlite, initDatabase } from '../../src/main/db/index.js';

interface SchemaSnapshot {
  columns: string[];
  indexes: Array<{ name: string; unique: number }>;
  indexColumns: string[];
  tableSql: string | undefined;
}

interface ConstraintSnapshot {
  insertedKind: string;
  duplicateError: string | undefined;
  invalidKindError: string | undefined;
  sourceCountAfterTaskDelete: number;
}

function snapshotSchema(): SchemaSnapshot {
  const sqlite = getSqlite();
  if (!sqlite) throw new Error('Database was not initialized');

  const columns = sqlite
    .prepare('PRAGMA table_info(task_context_sources)')
    .all()
    .map((column) => (column as { name: string }).name);
  const indexes = sqlite.prepare('PRAGMA index_list(task_context_sources)').all() as Array<{
    name: string;
    unique: number;
  }>;
  const indexColumns = sqlite
    .prepare('PRAGMA index_info(task_context_sources_task_path)')
    .all()
    .map((column) => (column as { name: string }).name);
  const table = sqlite
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'task_context_sources'")
    .get() as { sql: string } | undefined;

  return { columns, indexes, indexColumns, tableSql: table?.sql };
}

function verifyConstraints(): ConstraintSnapshot {
  const sqlite = getSqlite();
  if (!sqlite) throw new Error('Database was not initialized');

  sqlite
    .prepare('INSERT INTO tasks (id, session_key, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run('task-1', 'session-1', '2026-09-16T00:00:00.000Z', '2026-09-16T00:00:00.000Z');
  const insertSource = sqlite.prepare(
    `INSERT INTO task_context_sources
     (id, task_id, kind, absolute_path, display_name, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const timestamp = '2026-09-16T00:00:00.000Z';

  insertSource.run('source-1', 'task-1', 'folder', 'C:\\workspace\\docs', 'docs', timestamp, timestamp);

  const inserted = sqlite.prepare('SELECT kind FROM task_context_sources WHERE id = ?').get('source-1') as {
    kind: string;
  };
  let duplicateError: string | undefined;
  let invalidKindError: string | undefined;

  try {
    insertSource.run('source-duplicate', 'task-1', 'folder', 'C:\\workspace\\docs', 'duplicate', timestamp, timestamp);
  } catch (error) {
    duplicateError = error instanceof Error ? error.message : String(error);
  }

  try {
    insertSource.run('source-invalid', 'task-1', 'file', 'C:\\workspace\\invalid', 'invalid', timestamp, timestamp);
  } catch (error) {
    invalidKindError = error instanceof Error ? error.message : String(error);
  }

  sqlite.prepare('DELETE FROM tasks WHERE id = ?').run('task-1');
  const remaining = sqlite.prepare('SELECT COUNT(*) AS count FROM task_context_sources').get() as {
    count: number;
  };

  return {
    insertedKind: inserted.kind,
    duplicateError,
    invalidKindError,
    sourceCountAfterTaskDelete: remaining.count,
  };
}

const workspacePath = process.argv[2];
if (!workspacePath) throw new Error('Expected a temporary workspace path');

try {
  initDatabase(workspacePath);
  const initial = snapshotSchema();
  const constraints = verifyConstraints();
  closeDatabase();

  initDatabase(workspacePath);
  const reopened = snapshotSchema();

  console.log(`DB_CONTEXT_SOURCES_RESULT=${JSON.stringify({ initial, reopened, constraints })}`);
} finally {
  closeDatabase();
}
