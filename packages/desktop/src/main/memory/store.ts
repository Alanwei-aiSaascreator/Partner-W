/**
 * 长时记忆的**落盘那一半**（真实 SQLite，随工作区走）。
 *
 * ## 为什么落库而不是落文件
 *
 * 原记忆规格定的是"落盘在工作区、**不进网关 state 目录**"，并且验收要求
 * **删除后不再召回**、**越权（别的账号 / 别的盘）读不到**。这两条用文件很难老实做到：
 * 「一次删除」在文件里通常退化成"再追加一行说它作废了"，而账号维度在文件里没有天然位置。
 * 工作区库本来就是**随盘走**的（`<workspace>/clawwork.db`，换盘即换库），
 * 账号维度就是一行 `owner_user_id` —— 两个需求都落在最自然的地方。
 *
 * ## 读出口是 `MEMORY.md`，不是这个库
 *
 * 助手真正"读到"记忆的通道是运行时每轮全文注入的 `MEMORY.md`（见 `memory-block.ts`）。
 * 库是**真源与账本**，`main/memory/materialize.ts` 负责把它投影进那个文件。
 *
 * ## 账户作用域
 *
 * `ownerUserId === ''` = **未登录（匿名）**，不是"所有人可见"。未登录时写的条目在登录后
 * 读不到（宁可让用户重写一次，也不把匿名内容冒充成某个账号的记忆）；登录后写的条目
 * 在未登录时也读不到。同一块盘换账号 ⇒ 各自只见自己那批。
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  checkMemoryBudget,
  checkMemoryText,
  isPresentableDraft,
  memoryDedupeKey,
  type MemoryEntry,
  type MemoryEntrySource,
  type MemoryEntryStatus,
} from '@clawwork/core';
import { getSqlite } from '../db/index.js';
import { MEMORY_TABLE as TABLE } from './schema.js';

export type MemoryMutationFailure =
  | 'empty'
  | 'over-limit'
  | 'control-characters'
  | 'block-over-limit'
  | 'entry-count-limit'
  | 'not-found'
  | 'duplicate'
  | 'unavailable';

export type MemoryMutation =
  | { ok: true; entry: MemoryEntry }
  | { ok: false; reason: MemoryMutationFailure; limit?: number };

export interface MemoryStore {
  list(input: { ownerUserId: string; status?: MemoryEntryStatus }): MemoryEntry[];
  create(input: {
    ownerUserId: string;
    text: string;
    source: MemoryEntrySource;
    sourceTaskId?: string | null;
    sourceMessageId?: string | null;
  }): MemoryMutation;
  /**
   * 提一条**待确认草案**（助手提的那条轨道）。
   *
   * · **不可见的内容不提**（`isPresentableDraft`）—— 空正文 / 纯标点的草案不上屏；
   * · 已经有同一条（pending / confirmed / rejected）⇒ `duplicate`，调用方**不重复提醒**
   *   （"拒绝之后不再重复提同一件"由数据库唯一索引兜底，不靠调用方自觉）；
   * · **长度/预算不在这里挡**：草案可以超限，用户编辑时当场看到并改；
   *   真正落库那一步（`confirm`）才按上限拒绝。提草案这一侧就砍长度 = 模型写长一点
   *   整条草案凭空消失，用户连"它想记什么"都看不到。
   */
  propose(input: {
    ownerUserId: string;
    text: string;
    sourceTaskId?: string | null;
    sourceMessageId?: string | null;
  }): MemoryMutation;
  confirm(input: { ownerUserId: string; id: string; text?: string }): MemoryMutation;
  reject(input: { ownerUserId: string; id: string }): MemoryMutation;
  remove(input: { ownerUserId: string; id: string }): MemoryMutation;
}

interface Row {
  id: string;
  owner_user_id: string;
  text: string;
  status: string;
  source: string;
  source_task_id: string | null;
  source_message_id: string | null;
  dedupe_key: string;
  created_at: string;
  updated_at: string;
  decided_at: string | null;
}

const STATUSES: readonly MemoryEntryStatus[] = ['pending', 'confirmed', 'rejected'];
const SOURCES: readonly MemoryEntrySource[] = ['user', 'assistant'];

function toEntry(row: Row): MemoryEntry {
  const status = (STATUSES as readonly string[]).includes(row.status)
    ? (row.status as MemoryEntryStatus)
    : 'rejected';
  const source = (SOURCES as readonly string[]).includes(row.source) ? (row.source as MemoryEntrySource) : 'user';
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    text: row.text,
    status,
    source,
    sourceTaskId: row.source_task_id,
    sourceMessageId: row.source_message_id,
    dedupeKey: row.dedupe_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    decidedAt: row.decided_at,
  };
}

/**
 * 一行的插入。`INSERT OR IGNORE` + 唯一索引 `(owner_user_id, dedupe_key)`：
 * **同一件事只可能有一条记录**（不论它现在处于 pending / confirmed / rejected）。
 * 这就是"拒绝之后不再重复提同一件"的机制 —— 落在数据库约束上，不靠调用方自觉。
 */
function insertRow(
  db: Database.Database,
  input: {
    ownerUserId: string;
    text: string;
    status: MemoryEntryStatus;
    source: MemoryEntrySource;
    sourceTaskId: string | null;
    sourceMessageId: string | null;
    dedupeKey: string;
    now: string;
  },
): MemoryEntry | null {
  const id = randomUUID();
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO ${TABLE}
       (id, owner_user_id, text, status, source, source_task_id, source_message_id, dedupe_key, created_at, updated_at, decided_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      input.ownerUserId,
      input.text,
      input.status,
      input.source,
      input.sourceTaskId,
      input.sourceMessageId,
      input.dedupeKey,
      input.now,
      input.now,
      input.status === 'pending' ? null : input.now,
    );
  if (result.changes === 0) return null;
  const row = db.prepare(`SELECT * FROM ${TABLE} WHERE id = ?`).get(id) as Row | undefined;
  return row ? toEntry(row) : null;
}

export function createMemoryStore(db: Database.Database): MemoryStore {
  const confirmedFor = (ownerUserId: string): MemoryEntry[] =>
    (db
      .prepare(`SELECT * FROM ${TABLE} WHERE owner_user_id = ? AND status = 'confirmed' ORDER BY created_at, rowid`)
      .all(ownerUserId) as Row[]).map(toEntry);

  return {
    list(input) {
      const rows = input.status
        ? (db
            .prepare(`SELECT * FROM ${TABLE} WHERE owner_user_id = ? AND status = ? ORDER BY created_at, rowid`)
            .all(input.ownerUserId, input.status) as Row[])
        : (db.prepare(`SELECT * FROM ${TABLE} WHERE owner_user_id = ? ORDER BY created_at, rowid`).all(
            input.ownerUserId,
          ) as Row[]);
      return rows.map(toEntry);
    },

    create(input) {
      const checked = checkMemoryText(input.text);
      if (!checked.ok) return { ok: false, reason: checked.reason, limit: checked.limit };
      const confirmed = confirmedFor(input.ownerUserId);
      const budget = checkMemoryBudget(confirmed, checked.text);
      if (!budget.ok) return { ok: false, reason: budget.reason };

      const now = new Date().toISOString();
      const entry = insertRow(db, {
        ownerUserId: input.ownerUserId,
        text: checked.text,
        status: 'confirmed',
        source: input.source,
        sourceTaskId: input.sourceTaskId ?? null,
        sourceMessageId: input.sourceMessageId ?? null,
        dedupeKey: checked.dedupeKey,
        now,
      });
      // 已经有同一条（不论什么状态）⇒ 如实说"重复"，**不**假装成功。
      if (!entry) return { ok: false, reason: 'duplicate' };
      return { ok: true, entry };
    },

    propose(input) {
      if (!isPresentableDraft(input.text)) return { ok: false, reason: 'empty' };
      const normalized = input.text.replace(/\s+/gu, ' ').trim();
      const now = new Date().toISOString();
      const entry = insertRow(db, {
        ownerUserId: input.ownerUserId,
        text: normalized,
        status: 'pending',
        source: 'assistant',
        sourceTaskId: input.sourceTaskId ?? null,
        sourceMessageId: input.sourceMessageId ?? null,
        dedupeKey: memoryDedupeKey(normalized),
        now,
      });
      if (!entry) return { ok: false, reason: 'duplicate' };
      return { ok: true, entry };
    },

    confirm(input) {
      const row = db
        .prepare(`SELECT * FROM ${TABLE} WHERE id = ? AND owner_user_id = ?`)
        .get(input.id, input.ownerUserId) as Row | undefined;
      if (!row) return { ok: false, reason: 'not-found' };
      if (row.status === 'confirmed') return { ok: true, entry: toEntry(row) };

      const text = input.text === undefined ? row.text : input.text;
      const checked = checkMemoryText(text);
      if (!checked.ok) return { ok: false, reason: checked.reason, limit: checked.limit };
      const confirmed = confirmedFor(input.ownerUserId).filter((entry) => entry.id !== row.id);
      const budget = checkMemoryBudget(confirmed, checked.text);
      if (!budget.ok) return { ok: false, reason: budget.reason };

      // 用户确认时可能**改过正文** ⇒ 去重键跟着改；撞上另一条已存在的 ⇒ 拒绝（不让两条内容
      // 不同的记录共用一个去重键，那会让后续的"不再重复提"判错）。
      const key = checked.dedupeKey;
      if (key !== row.dedupe_key) {
        const clash = db
          .prepare(`SELECT id FROM ${TABLE} WHERE owner_user_id = ? AND dedupe_key = ? AND id <> ?`)
          .get(input.ownerUserId, key, row.id) as { id: string } | undefined;
        if (clash) return { ok: false, reason: 'duplicate' };
      }
      const now = new Date().toISOString();
      db.prepare(
        `UPDATE ${TABLE} SET text = ?, status = 'confirmed', dedupe_key = ?, updated_at = ?, decided_at = ? WHERE id = ?`,
      ).run(checked.text, key, now, now, row.id);
      const updated = db.prepare(`SELECT * FROM ${TABLE} WHERE id = ?`).get(row.id) as Row;
      return { ok: true, entry: toEntry(updated) };
    },

    reject(input) {
      const row = db
        .prepare(`SELECT * FROM ${TABLE} WHERE id = ? AND owner_user_id = ?`)
        .get(input.id, input.ownerUserId) as Row | undefined;
      if (!row) return { ok: false, reason: 'not-found' };
      const now = new Date().toISOString();
      // ⚠️ **留行**（状态改 rejected），不删：删了的话助手下一轮会把同一件事重新提一遍
      //    （原记忆规格的判据就是"拒绝之后不再重复提同一件"）。
      db.prepare(`UPDATE ${TABLE} SET status = 'rejected', updated_at = ?, decided_at = ? WHERE id = ?`).run(
        now,
        now,
        row.id,
      );
      const updated = db.prepare(`SELECT * FROM ${TABLE} WHERE id = ?`).get(row.id) as Row;
      return { ok: true, entry: toEntry(updated) };
    },

    remove(input) {
      const row = db
        .prepare(`SELECT * FROM ${TABLE} WHERE id = ? AND owner_user_id = ?`)
        .get(input.id, input.ownerUserId) as Row | undefined;
      if (!row) return { ok: false, reason: 'not-found' };
      db.prepare(`DELETE FROM ${TABLE} WHERE id = ?`).run(row.id);
      return { ok: true, entry: toEntry(row) };
    },
  };
}

/** 当前工作区的记忆库；库还没打开 ⇒ `null`（调用方如实报"不可用"，不假装成功）。 */
export function currentMemoryStore(): MemoryStore | null {
  const sqlite = getSqlite();
  return sqlite ? createMemoryStore(sqlite) : null;
}
