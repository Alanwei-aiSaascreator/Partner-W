/**
 * r7-1 / F4（BUG-026 跨重开残余）：交付成功的**最小持久化标记** `messages.delivery_succeeded`。
 *
 * 为什么必须真的落库、且必须成对加 DDL（新库 CREATE + 老库 ALTER）：
 * 失败去重周期的边界（`useClaimGuardToast`）重开时只能从既有持久化证据恢复 —— 交付活动表
 * 只留最近 256 条、没走到 phase 的操作可能没有活动记录（"查不到"≠"未成功"），
 * 这一列是**不设窗口**的那份证据。老用户升级时少了 ALTER，标记永远存不住，
 * 跨重开边界就永远恢复不了（本文件同时钉住这两条 DDL）。
 *
 * 用 `node-sqlite-shim` 真跑 SQL（同 db-fresh-init / kb 系列）：
 * 仓库里的 better-sqlite3 按 Electron ABI 编译，vitest 纯 node 加载不了。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('better-sqlite3', async () => ({
  default: (await import('./helpers/node-sqlite-shim.js')).NodeSqliteShim,
}));

import { DB_FILE_NAME } from '@clawwork/shared';
import { closeDatabase, getDb, getSqlite, initDatabase } from '../src/main/db/index.js';
import { messages } from '../src/main/db/schema.js';
import { markMessageDeliverySucceeded } from '../src/main/artifact/delivery-settlement.js';

const timestamp = '2026-10-15T00:00:00.000Z';

function columnsOf(table: string): string[] {
  const sqlite = getSqlite();
  expect(sqlite).not.toBeNull();
  return (sqlite!.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
}

function flagOf(messageId: string): unknown {
  const row = getSqlite()!.prepare('SELECT delivery_succeeded FROM messages WHERE id=?').get(messageId) as
    | { delivery_succeeded: unknown }
    | undefined;
  return row?.delivery_succeeded;
}

function seed(): void {
  const sqlite = getSqlite()!;
  sqlite
    .prepare('INSERT INTO tasks (id, session_key, created_at, updated_at) VALUES (?,?,?,?)')
    .run('task-1', 's-1', timestamp, timestamp);
  sqlite
    .prepare('INSERT INTO tasks (id, session_key, created_at, updated_at) VALUES (?,?,?,?)')
    .run('task-2', 's-2', timestamp, timestamp);
  const insert = sqlite.prepare(
    'INSERT INTO messages (id, task_id, role, content, timestamp, session_key) VALUES (?,?,?,?,?,?)',
  );
  insert.run('msg-ok', 'task-1', 'assistant', '已保存 report.docx', timestamp, 's-1');
  insert.run('msg-other', 'task-2', 'assistant', '另一个任务的回复', timestamp, 's-2');
}

describe('r7-1 交付成功最小持久化标记（messages.delivery_succeeded）', () => {
  let dir = '';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'clawwork-delivery-marker-'));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  it('全新库：CREATE TABLE 一把建齐这一列', () => {
    initDatabase(dir);
    expect(columnsOf('messages')).toContain('delivery_succeeded');
  });

  it('老库升级：ALTER 补列，且历史行原样保留（NULL = 没有可恢复的成功证据，不 backfill）', () => {
    // 造一个"加这一列之前"的库：老 DDL + 一行历史消息。
    const legacy = new DatabaseSync(join(dir, DB_FILE_NAME));
    legacy.exec(`
      CREATE TABLE tasks (id TEXT PRIMARY KEY, session_key TEXT NOT NULL, session_id TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', artifact_dir TEXT NOT NULL DEFAULT '');
      CREATE TABLE messages (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), role TEXT NOT NULL,
        content TEXT NOT NULL, timestamp TEXT NOT NULL, session_key TEXT);
    `);
    legacy
      .prepare('INSERT INTO tasks (id, session_key, created_at, updated_at) VALUES (?,?,?,?)')
      .run('task-1', 's-1', timestamp, timestamp);
    legacy
      .prepare('INSERT INTO messages (id, task_id, role, content, timestamp, session_key) VALUES (?,?,?,?,?,?)')
      .run('legacy-msg', 'task-1', 'assistant', '老库里的回复', timestamp, 's-1');
    legacy.close();

    initDatabase(dir);

    expect(columnsOf('messages')).toContain('delivery_succeeded');
    expect(flagOf('legacy-msg')).toBeNull();
  });

  it('标记只落在被结算的那一条消息上（task 绑定），且重复调用幂等', () => {
    initDatabase(dir);
    seed();
    expect(flagOf('msg-ok')).toBeNull();
    expect(flagOf('msg-other')).toBeNull();

    expect(markMessageDeliverySucceeded('task-1', 'msg-ok')).toBe(true);
    expect(flagOf('msg-ok')).toBe(1);
    // 另一条任务的消息不动。
    expect(flagOf('msg-other')).toBeNull();

    // 幂等：媒体补发等重复成功回执再写一次，还是同一条 UPDATE、同一个值。
    expect(markMessageDeliverySucceeded('task-1', 'msg-ok')).toBe(true);
    expect(flagOf('msg-ok')).toBe(1);

    // task 绑定：拿 task-2 去标记 task-1 的消息必须打不中（不许跨任务污染）。
    expect(markMessageDeliverySucceeded('task-2', 'msg-ok')).toBe(true);
    expect(flagOf('msg-ok')).toBe(1);
    expect(flagOf('msg-other')).toBeNull();
  });

  it('消息行不存在/库未就绪 ⇒ 什么都不发生（"查不到"≠"没成功"）', () => {
    initDatabase(dir);
    seed();
    expect(markMessageDeliverySucceeded('task-1', 'not-there')).toBe(true);
    expect(flagOf('msg-ok')).toBeNull();
    closeDatabase();
    expect(markMessageDeliverySucceeded('task-1', 'msg-ok')).toBe(false);
  });

  it('渲染层读侧形状：`data:list-messages` 走的 drizzle 投影把标记读成布尔 `deliverySucceeded`', () => {
    // 重开边界由渲染层判：`session-sync.hydrateFromLocal` 按 `r.deliverySucceeded === true` 带进
    // Message，所以这里钉住"库里的 1 到这个形状就是 true"（老行的 NULL 读成 null ⇒ 不带标记）。
    initDatabase(dir);
    seed();
    markMessageDeliverySucceeded('task-1', 'msg-ok');

    const rows = getDb().select().from(messages).all() as Array<{ id: string; deliverySucceeded: boolean | null }>;
    const byId = new Map(rows.map((row) => [row.id, row.deliverySucceeded]));
    expect(byId.get('msg-ok')).toBe(true);
    expect(byId.get('msg-other')).toBeNull();
  });
});
