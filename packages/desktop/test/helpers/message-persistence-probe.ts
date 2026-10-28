import Database from 'better-sqlite3';
import { join } from 'node:path';
import { buildSessionKey, DB_FILE_NAME } from '@clawwork/shared';
import { closeDatabase, getSqlite, initDatabase } from '../../src/main/db/index.js';
import { initFTS } from '../../src/main/db/fts.js';
import { registerDataHandlers } from '../../src/main/ipc/data-handlers.js';
import { handlers } from './message-persistence-ipc.js';

const [, , workspacePath, scenario, role = 'system', collision = 'task'] = process.argv;
const timestamp = '2026-09-30T00:00:00.000Z';
const sessionKey = buildSessionKey('task-1', 'main', 'test-device');

function message(id: string, messageRole = role) {
  return { id, taskId: 'task-1', sessionKey, role: messageRole, content: `content ${id}`, timestamp };
}

function invoke(msg: ReturnType<typeof message>) {
  return handlers.get('data:create-message')!({}, msg);
}

function rows() {
  return getSqlite()!
    .prepare(
      'SELECT id, task_id, session_key, role, content, timestamp, model, thinking_content FROM messages ORDER BY id',
    )
    .all();
}

function indexSql() {
  return getSqlite()!.prepare("SELECT sql FROM sqlite_master WHERE name = 'messages_dedup'").get();
}

function seedTasks() {
  for (const id of ['task-1', 'task-2']) {
    getSqlite()!
      .prepare('INSERT INTO tasks (id, session_key, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(id, buildSessionKey(id, 'main', 'test-device'), timestamp, timestamp);
  }
}

function seedArtifact(messageId: string) {
  getSqlite()!
    .prepare(
      `INSERT INTO artifacts (id, task_id, message_id, name, file_path, local_path, created_at)
       VALUES ('artifact-1', 'task-1', ?, 'history.txt', 'history.txt', 'task-1/history.txt', ?)`,
    )
    .run(messageId, timestamp);
}

function integrity() {
  return {
    artifacts: getSqlite()!.prepare('SELECT id, message_id FROM artifacts ORDER BY id').all(),
    foreignKeys: getSqlite()!.prepare('PRAGMA foreign_key_check').all(),
    fts: getSqlite()!.prepare('SELECT rowid, content FROM messages_fts ORDER BY rowid').all(),
    duplicates: getSqlite()!
      .prepare(
        `SELECT task_id, session_key, role, timestamp, COUNT(*) AS count
         FROM messages WHERE role <> 'system'
         GROUP BY task_id, session_key, role, timestamp HAVING COUNT(*) > 1`,
      )
      .all(),
  };
}

function seedLegacy(duplicates = false) {
  const legacy = new Database(join(workspacePath, DB_FILE_NAME));
  legacy.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE tasks (id TEXT PRIMARY KEY, session_key TEXT NOT NULL, session_id TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', artifact_dir TEXT NOT NULL DEFAULT '');
    CREATE TABLE messages (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), role TEXT NOT NULL,
      content TEXT NOT NULL, timestamp TEXT NOT NULL, session_key TEXT);
    CREATE TABLE artifacts (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
      message_id TEXT NOT NULL REFERENCES messages(id), type TEXT NOT NULL DEFAULT 'file', name TEXT NOT NULL,
      file_path TEXT NOT NULL, local_path TEXT NOT NULL, mime_type TEXT NOT NULL DEFAULT '',
      size INTEGER NOT NULL DEFAULT 0, content_text TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
    CREATE ${duplicates ? '' : 'UNIQUE '}INDEX messages_dedup ON messages(task_id, session_key, role, timestamp);
    CREATE INDEX messages_logical_unique ON messages(timestamp);
  `);
  legacy
    .prepare('INSERT INTO tasks (id, session_key, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run('task-1', sessionKey, timestamp, timestamp);
  for (const [id, messageRole, date] of [
    ['old-system', 'system', timestamp],
    ['old-user', 'user', timestamp],
    ['old-assistant', 'assistant', timestamp],
    ...(duplicates ? [['old-user-duplicate', 'user', timestamp]] : []),
  ]) {
    legacy
      .prepare('INSERT INTO messages (id, task_id, role, content, timestamp, session_key) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, 'task-1', messageRole, `history ${id}`, date, sessionKey);
  }
  legacy
    .prepare(
      `INSERT INTO artifacts (id, task_id, message_id, name, file_path, local_path, created_at)
       VALUES ('artifact-1', 'task-1', 'old-system', 'history.txt', 'history.txt', 'task-1/history.txt', ?)`,
    )
    .run(timestamp);
  initFTS(legacy);
  const history = legacy.prepare('SELECT rowid, id, content FROM messages ORDER BY id').all();
  const oldIndex = legacy.prepare("SELECT sql FROM sqlite_master WHERE name = 'messages_dedup'").get();
  legacy.close();
  return { history, oldIndex };
}

function main() {
  if (scenario === 'migration-rollback') {
    const before = seedLegacy(true);
    let error = '';
    try {
      initDatabase(workspacePath);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const legacy = new Database(join(workspacePath, DB_FILE_NAME));
    const result = {
      before,
      error,
      index: legacy.prepare("SELECT sql FROM sqlite_master WHERE name = 'messages_dedup'").get(),
      logicalIndex: legacy.prepare("SELECT name FROM sqlite_master WHERE name = 'messages_logical_unique'").get(),
      history: legacy.prepare('SELECT rowid, id, content FROM messages ORDER BY id').all(),
    };
    legacy.close();
    return result;
  }
  const legacy = scenario === 'migration' ? seedLegacy() : undefined;
  initDatabase(workspacePath);
  registerDataHandlers();
  if (scenario !== 'migration') seedTasks();
  if (scenario === 'fresh') return { index: indexSql(), integrity: integrity() };
  if (scenario === 'migration') {
    const migrated = { index: indexSql(), rows: rows(), integrity: integrity() };
    const response = invoke(message('new-system', 'system'));
    const history = getSqlite()!.prepare('SELECT rowid, id, content FROM messages ORDER BY id').all();
    closeDatabase();
    initDatabase(workspacePath);
    return {
      legacy,
      migrated,
      response,
      history,
      reopened: { rows: rows(), index: indexSql(), integrity: integrity() },
    };
  }
  if (scenario === 'distinct' || scenario === 'same-text') {
    const first = message('system-1', 'system');
    const second = { ...first, id: 'system-2', content: scenario === 'same-text' ? first.content : 'second notice' };
    const responses = [invoke(first), invoke(second)];
    seedArtifact(first.id);
    const before = rows();
    closeDatabase();
    initDatabase(workspacePath);
    return { responses, before, reopened: rows(), integrity: integrity() };
  }
  if (scenario === 'replay') {
    const first = message('system-1', 'system');
    const responses = [invoke(first), invoke(first), invoke({ ...first, content: 'updated notice' })];
    seedArtifact(first.id);
    return { responses, rows: rows(), integrity: integrity() };
  }
  if (scenario === 'canonical') {
    const first = { ...message('canonical-1'), model: 'fixture-model', thinkingContent: 'stored thinking' };
    const responses = [invoke(first)];
    seedArtifact(first.id);
    responses.push(invoke({ ...message('incoming-2'), content: 'updated canonical' }));
    return { responses, rows: rows(), integrity: integrity() };
  }
  if (scenario === 'collision') {
    const first = message('owned-id');
    const responses = [invoke(first)];
    const incoming = { ...first, content: 'must not overwrite' };
    if (collision === 'task') incoming.taskId = 'task-2';
    if (collision === 'session') incoming.sessionKey = buildSessionKey('task-1', 'other', 'test-device');
    if (collision === 'role') incoming.role = role === 'system' ? 'assistant' : 'system';
    responses.push(invoke({ ...incoming, id: 'other-canonical', content: 'other route history' }));
    const before = rows();
    responses.push(invoke(incoming));
    return { responses, before, after: rows(), integrity: integrity() };
  }
  if (scenario === 'isolation') {
    const responses = [
      invoke(message('first')),
      invoke({ ...message('task-2'), taskId: 'task-2' }),
      invoke({ ...message('session-2'), sessionKey: buildSessionKey('task-1', 'other', 'test-device') }),
    ];
    return { responses, rows: rows(), integrity: integrity() };
  }
  throw new Error(`Unknown scenario: ${scenario}`);
}

try {
  console.log(`MESSAGE_PERSISTENCE_RESULT=${JSON.stringify(main())}`);
} finally {
  closeDatabase();
}
