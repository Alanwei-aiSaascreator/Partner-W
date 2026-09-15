import { closeDatabase, getSqlite, initDatabase } from '../../src/main/db/index.js';

interface SchemaSnapshot {
  columns: string[];
  indexes: Array<{ name: string; unique: number }>;
  tableSql: string | undefined;
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
  const table = sqlite
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'task_context_sources'")
    .get() as { sql: string } | undefined;

  return { columns, indexes, tableSql: table?.sql };
}

const workspacePath = process.argv[2];
if (!workspacePath) throw new Error('Expected a temporary workspace path');

try {
  initDatabase(workspacePath);
  const initial = snapshotSchema();
  closeDatabase();

  initDatabase(workspacePath);
  const reopened = snapshotSchema();

  console.log(`DB_CONTEXT_SOURCES_RESULT=${JSON.stringify({ initial, reopened })}`);
} finally {
  closeDatabase();
}
