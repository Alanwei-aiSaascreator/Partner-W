import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { join, dirname, resolve } from 'path';
import { mkdirSync } from 'fs';
import { DB_FILE_NAME } from '@clawwork/shared';
import * as schema from './schema.js';
import { initFTS } from './fts.js';
import { initKbSchema } from './kb-schema.js';

let db: ReturnType<typeof drizzle> | null = null;
let sqlite: Database.Database | null = null;
let initializedWorkspacePath: string | null = null;

function canonicalWorkspacePath(workspacePath: string): string {
  return resolve(workspacePath);
}

function migrateAddColumn(database: Database.Database, sql: string): void {
  try {
    database.exec(sql);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('duplicate column')) {
      return;
    }
    throw e;
  }
}

const CREATE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  session_key TEXT NOT NULL,
  session_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  model TEXT,
  model_provider TEXT,
  thinking_level TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  context_tokens INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  artifact_dir TEXT NOT NULL DEFAULT '',
  gateway_id TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS task_context_sources (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind = 'folder'),
  absolute_path TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS task_context_sources_task_path
ON task_context_sources(task_id, absolute_path);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  image_attachments TEXT,
  tool_calls TEXT,
  model TEXT
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  message_id TEXT NOT NULL REFERENCES messages(id),
  type TEXT NOT NULL DEFAULT 'file',
  name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  local_path TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0,
  source_key TEXT NOT NULL DEFAULT '',
  content_text TEXT NOT NULL DEFAULT '',
  root TEXT NOT NULL DEFAULT 'workspace',
  created_at TEXT NOT NULL
);
`;

function openDatabaseAt(workspacePath: string): void {
  const dbPath = join(workspacePath, DB_FILE_NAME);
  mkdirSync(dirname(dbPath), { recursive: true });
  try {
    openAndMigrate(dbPath);
  } catch (err) {
    // ⚠️ 打不开就必须**把句柄放掉**，不能只把异常抛出去。
    //
    // 现场（2026-09-18 实测，真 sqlite）：库文件损坏时 `new Database()` 是成功的，
    // 炸在下面第一条 `pragma`（非数据库文件 ⇒ SQLITE_NOTADB）。此时句柄已经开着了，
    // 而调用方（`workspace/startup.ts` 的「重建工作区」）紧接着就要把这个坏文件
    // `rename` 到一边 —— Windows 上 sqlite 打开文件用的共享模式**不含**
    // FILE_SHARE_DELETE ⇒ 必然 EBUSY。改名失败 ⇒ 下一轮 init 还是同一个坏文件
    // ⇒ 转满 5 轮后退出。也就是说"可恢复"这条路上**永远修不好**。
    closeDatabase();
    throw err;
  }
  console.log(`[db] initialized at ${dbPath}`);
}

function openAndMigrate(dbPath: string): void {
  sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  // 工作区可能在 U 盘上、也可能被两台机器先后挂载 ⇒ 写锁撞上时**等一下重试**，
  // 而不是当场抛 SQLITE_BUSY（资料库的批量写入会更容易撞上，见 db/kb.ts 的并发说明）。
  sqlite.pragma('busy_timeout = 5000');
  sqlite.exec(CREATE_TABLES_SQL);

  migrateAddColumn(sqlite, "ALTER TABLE tasks ADD COLUMN gateway_id TEXT NOT NULL DEFAULT ''");

  for (const sql of [
    'ALTER TABLE tasks ADD COLUMN model TEXT',
    'ALTER TABLE tasks ADD COLUMN model_provider TEXT',
    'ALTER TABLE tasks ADD COLUMN thinking_level TEXT',
    'ALTER TABLE tasks ADD COLUMN input_tokens INTEGER',
    'ALTER TABLE tasks ADD COLUMN output_tokens INTEGER',
    'ALTER TABLE tasks ADD COLUMN context_tokens INTEGER',
  ]) {
    migrateAddColumn(sqlite, sql);
  }

  migrateAddColumn(sqlite, 'ALTER TABLE messages ADD COLUMN image_attachments TEXT');
  migrateAddColumn(sqlite, 'ALTER TABLE messages ADD COLUMN tool_calls TEXT');
  // 模型的推理输出（`stream:"thinking"`）。落库是为了重载后还在 ——
  // 否则它只活在内存的 activeTurn 里，刷新一次就没了。
  migrateAddColumn(sqlite, 'ALTER TABLE messages ADD COLUMN thinking_content TEXT');
  // 这条回复**实际**是哪个模型生成的（逐条来自网关 transcript）。
  // 老数据留空 —— 不 backfill、也不拿会话级模型兜底（那是"选中的"不是"生成它的"）。
  migrateAddColumn(sqlite, 'ALTER TABLE messages ADD COLUMN model TEXT');

  for (const col of ['session_key TEXT', 'agent_id TEXT', 'run_id TEXT']) {
    migrateAddColumn(sqlite, `ALTER TABLE messages ADD COLUMN ${col}`);
  }

  migrateAddColumn(sqlite, 'ALTER TABLE tasks ADD COLUMN ensemble INTEGER NOT NULL DEFAULT 0');
  // 置顶（NULL = 未置顶）。老数据留 NULL —— 语义就是"没置顶"，不需要 backfill。
  migrateAddColumn(sqlite, 'ALTER TABLE tasks ADD COLUMN pinned_at TEXT');
  migrateAddColumn(sqlite, 'ALTER TABLE tasks ADD COLUMN team_id TEXT');

  sqlite.exec(`
    UPDATE messages SET session_key = (
      SELECT t.session_key FROM tasks t WHERE t.id = messages.task_id
    ) WHERE session_key IS NULL
  `);
  sqlite.exec(`UPDATE messages SET session_key = '' WHERE session_key IS NULL`);

  sqlite.exec(`DROP INDEX IF EXISTS messages_logical_unique`);
  sqlite.exec(`DROP INDEX IF EXISTS messages_dedup`);

  sqlite.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS messages_dedup
    ON messages(task_id, session_key, role, timestamp)
  `);

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS task_rooms (
      task_id TEXT PRIMARY KEY REFERENCES tasks(id),
      status TEXT NOT NULL DEFAULT 'active',
      conductor_ready INTEGER NOT NULL DEFAULT 0
    )
  `);

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS task_room_sessions (
      session_key TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      agent_id TEXT NOT NULL,
      agent_name TEXT NOT NULL DEFAULT '',
      emoji TEXT,
      verified_at TEXT NOT NULL
    )
  `);

  sqlite.exec(`
    DELETE FROM messages
    WHERE role = 'assistant'
      AND (content = '' OR TRIM(content) = 'NO_REPLY')
      AND COALESCE(image_attachments, '') = ''
      AND COALESCE(tool_calls, '') = ''
      AND NOT EXISTS (
        SELECT 1 FROM artifacts WHERE artifacts.message_id = messages.id
      )
  `);

  migrateAddColumn(sqlite, "ALTER TABLE artifacts ADD COLUMN content_text TEXT NOT NULL DEFAULT ''");
  migrateAddColumn(sqlite, "ALTER TABLE artifacts ADD COLUMN source_key TEXT NOT NULL DEFAULT ''");
  // ⭐ 产物的**受信根**（2026-09-27）。原来是隐含的：所有 `local_path` 都被当作
  //    相对**应用工作区**（`<appWorkspace>/<taskId>/…`）。
  //
  //    加这一列是因为助手把文件写在**它自己的工作区**里（网关的
  //    `agents.entries.<id>.workspace`），那与 `<appWorkspace>/<taskId>` 是**兄弟目录**
  //    —— 于是通道外生成的文件从来没进过产物表（真机实测 `COUNT(*)` = 0）。
  //
  //    ⚠️ 默认值 `'workspace'` 就是老行为：既有行、以及所有走 `saveArtifact*` /
  //       `reconcile` 的既有路径**一个字节都不变**。新值 `'agent'` 只由新那条扫描链写。
  migrateAddColumn(sqlite, "ALTER TABLE artifacts ADD COLUMN root TEXT NOT NULL DEFAULT 'workspace'");

  // Legacy releases could persist the same task-relative output more than once.
  // Prefer a row with usable generated-file metadata, then the newest row, before
  // enforcing task-path identity for reconciliation and concurrent runs.
  sqlite.exec(`
    DELETE FROM artifacts
    WHERE rowid NOT IN (
      SELECT rowid FROM (
        SELECT rowid,
          ROW_NUMBER() OVER (
            PARTITION BY task_id, local_path
            ORDER BY
              CASE WHEN size > 0 AND source_key <> '' THEN 1 ELSE 0 END DESC,
              created_at DESC,
              rowid DESC
          ) AS duplicate_rank
        FROM artifacts
      )
      WHERE duplicate_rank = 1
    )
  `);
  sqlite.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS artifacts_task_local_path
    ON artifacts(task_id, local_path)
  `);
  sqlite.exec(`
    DELETE FROM artifacts
    WHERE source_key <> '' AND rowid NOT IN (
      SELECT MAX(rowid) FROM artifacts
      WHERE source_key <> ''
      GROUP BY message_id, source_key
    )
  `);
  sqlite.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS artifacts_source_dedup
    ON artifacts(message_id, source_key)
    WHERE source_key <> ''
  `);

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS teams (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      emoji TEXT DEFAULT '',
      description TEXT DEFAULT '',
      gateway_id TEXT NOT NULL,
      source TEXT DEFAULT 'local',
      version TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  migrateAddColumn(sqlite, "ALTER TABLE teams ADD COLUMN hub_slug TEXT DEFAULT ''");

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS team_agents (
      team_id TEXT NOT NULL REFERENCES teams(id),
      agent_id TEXT NOT NULL,
      role TEXT DEFAULT '',
      is_manager INTEGER DEFAULT 0,
      skills_json TEXT DEFAULT '[]',
      PRIMARY KEY (team_id, agent_id)
    )
  `);

  migrateAddColumn(sqlite, "ALTER TABLE team_agents ADD COLUMN skills_json TEXT DEFAULT '[]'");
  // 团队成员的**讨论职位**（圆桌用）。与已有的 `role`（编排角色）是两回事。
  // 老库这一列不存在 ⇒ 加上，默认空串；读的时候由 `normalizePosition` 兜底成领域专家，
  // 所以老团队升级后不会报错、也不需要回填。
  //
  // ⚠️ **这一句必须待在自己那张表的 `CREATE TABLE` 之后**（就是这个位置）。
  //    2026-09-20：它一度被放进 `tasks` 那一串改造里（文件更靠前处）⇒ 老库上毫无异样，
  //    **全新库直接 `no such table: team_agents`**（新装/换机器/U 盘首启全中）。
  //    那条路径平时看不到：开发机上的库早就建好了。守它的是
  //    `test/db-fresh-init.test.ts`（空目录 init 一遍）与 kb 系列那几个用临时目录的测试。
  migrateAddColumn(sqlite, "ALTER TABLE team_agents ADD COLUMN position TEXT DEFAULT ''");

  initFTS(sqlite);
  // 资料库（T6a）：kb_meta / kb_sources / kb_chunks + kb_chunks_fts。
  // 表与库同生共死（工作区可指向 U 盘），**不落服务器**。
  initKbSchema(sqlite);

  db = drizzle(sqlite, { schema });
}

export function initDatabase(workspacePath: string): void {
  const canonicalPath = canonicalWorkspacePath(workspacePath);
  if (db) {
    if (initializedWorkspacePath !== canonicalPath) {
      throw new Error('initDatabase called with different workspace path; use reinitDatabase to switch');
    }
    return;
  }
  // ⚠️ 顺序：先真的打开，**再**认这个路径。反过来的话，一次失败的 init 会留下
  //    "路径记下了、库其实没开（或不完整）"的状态，后面每一次判断都建立在谎上。
  openDatabaseAt(canonicalPath);
  initializedWorkspacePath = canonicalPath;
}

export function reinitDatabase(workspacePath: string): void {
  const canonicalPath = canonicalWorkspacePath(workspacePath);
  closeDatabase();
  openDatabaseAt(canonicalPath);
  initializedWorkspacePath = canonicalPath;
}

export function getDb(): ReturnType<typeof drizzle> {
  if (!db) throw new Error('Database not initialized. Call initDatabase() first.');
  return db;
}

export function getSqlite(): Database.Database | null {
  return sqlite;
}

export function isDbReady(): boolean {
  return db !== null;
}

export function closeDatabase(): void {
  sqlite?.close();
  sqlite = null;
  db = null;
  initializedWorkspacePath = null;
}
