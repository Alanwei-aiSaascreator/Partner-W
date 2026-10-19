/**
 * 记忆表的 DDL。**故意独立成模块**，不依赖 `db/index.ts`：
 *
 * · `db/index.ts` 在打开库时调它建表；
 * · 测试用**真实的临时 sqlite 文件**调它建表。
 *
 * 两处共用同一句 SQL —— 各写一遍的漂移表现是"测试全绿、真机 `no such table`"。
 * 放在这里还能避免 `db → memory/store → db` 的循环导入。
 */

import type Database from 'better-sqlite3';

export const MEMORY_TABLE = 'memory_entries';

/**
 * `owner_user_id` = 归属账号（`''` = 未登录匿名，**不是**"所有人可见"）。
 * `dedupe_key` 上的唯一索引是"同一件事只可能有一条记录"的落点（不论 pending/confirmed/rejected），
 * 也就是"拒绝之后不再重复提同一件"的机制 —— 靠数据库约束，不靠调用方自觉。
 */
export const CREATE_MEMORY_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS ${MEMORY_TABLE} (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  status TEXT NOT NULL,
  source TEXT NOT NULL,
  source_task_id TEXT,
  source_message_id TEXT,
  dedupe_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS memory_entries_owner_status ON ${MEMORY_TABLE}(owner_user_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS memory_entries_owner_dedupe ON ${MEMORY_TABLE}(owner_user_id, dedupe_key);
`;

export function ensureMemoryTable(db: Database.Database): void {
  db.exec(CREATE_MEMORY_TABLE_SQL);
}
