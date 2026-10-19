/**
 * 长期记忆的**落盘那一半**：真实 SQLite 文件（临时目录），不是 mock。
 *
 * 这里每条用例都对着原记忆规格的一条验收：
 *   · 写 → 重启 → 读得到（**真的关库再开**，不是同一个连接读回自己）；
 *   · 删除后确实不再出现在已确认集合里；
 *   · 越权（**别的账号**）读不到；
 *   · 拒绝之后不再重复提同一件（草案轨道的判据）。
 *
 * ⚠️ 用**文件**而不是 `:memory:`：内存库天然"重启就没了"，用它测持久化等于什么都没测。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ⚠️ 仓库里的 `better-sqlite3` 是按 **Electron ABI** 编译的，vitest 跑在纯 node 里
 *    `require` 到它就 `ERR_DLOPEN_FAILED`。用仓库既有的壳（`node:sqlite`，同样是
 *    **完整 SQLite**、同样落**真文件**）换掉驱动 —— DDL / 唯一索引 / 重启持久化
 *    要验的东西全在 SQL 与文件里，拿假库断言"SQL 字符串长什么样"等于什么都没验。
 */
vi.mock('better-sqlite3', async () => ({
  default: (await import('./helpers/node-sqlite-shim.js')).NodeSqliteShim,
}));

import type Database from 'better-sqlite3';
import { NodeSqliteShim } from './helpers/node-sqlite-shim.js';
import {
  MEMORY_ENTRY_MAX_CHARS,
  MEMORY_MAX_CONFIRMED_ENTRIES,
} from '@clawwork/core';
import { createMemoryStore, type MemoryStore } from '../src/main/memory/store.js';
import { ensureMemoryTable } from '../src/main/memory/schema.js';

let dir: string;
let dbPath: string;
let handle: Database.Database;
let store: MemoryStore;

const OWNER_A = 'user-a';
const OWNER_B = 'user-b';

function open(): Database.Database {
  const db = new NodeSqliteShim(dbPath) as unknown as Database.Database;
  db.pragma('journal_mode = WAL');
  ensureMemoryTable(db);
  return db;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'memory-store-'));
  dbPath = join(dir, 'clawwork.db');
  handle = open();
  store = createMemoryStore(handle);
});

afterEach(() => {
  try {
    handle.close();
  } catch {
    // 已关过就算了
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('记忆库：写 / 读 / 重启持久化', () => {
  it('⭐ 写进去的一条，**关库再开**之后还在（真持久化，不是内存里读回自己）', () => {
    const created = store.create({ ownerUserId: OWNER_A, text: '用户希望结论先行。', source: 'user' });
    expect(created.ok).toBe(true);

    handle.close();
    handle = open();
    store = createMemoryStore(handle);

    const entries = store.list({ ownerUserId: OWNER_A, status: 'confirmed' });
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe('用户希望结论先行。');
    expect(entries[0].source).toBe('user');
  });

  it('删除之后已确认集合里真的没有它了（"删除后不再召回"的库侧）', () => {
    const created = store.create({ ownerUserId: OWNER_A, text: '临时记住的一件事', source: 'user' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(store.remove({ ownerUserId: OWNER_A, id: created.entry.id }).ok).toBe(true);
    expect(store.list({ ownerUserId: OWNER_A, status: 'confirmed' })).toEqual([]);
    // 再"重启"一次也不许复活
    handle.close();
    handle = open();
    store = createMemoryStore(handle);
    expect(store.list({ ownerUserId: OWNER_A, status: 'confirmed' })).toEqual([]);
  });

  it('删掉之后可以重新写同一条（删除不是永久的黑名单，拒绝才是）', () => {
    const first = store.create({ ownerUserId: OWNER_A, text: '同一句话', source: 'user' });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    store.remove({ ownerUserId: OWNER_A, id: first.entry.id });
    expect(store.create({ ownerUserId: OWNER_A, text: '同一句话', source: 'user' }).ok).toBe(true);
  });

  it('同一件事写两次 ⇒ 第二次如实说"重复"，不产生第二条', () => {
    expect(store.create({ ownerUserId: OWNER_A, text: 'Use PNPM', source: 'user' }).ok).toBe(true);
    const again = store.create({ ownerUserId: OWNER_A, text: 'use   pnpm', source: 'user' });
    expect(again).toEqual({ ok: false, reason: 'duplicate' });
    expect(store.list({ ownerUserId: OWNER_A, status: 'confirmed' })).toHaveLength(1);
  });

  it('空正文 / 超长 / 控制字符都被拒绝，且**库里一条都没落**', () => {
    expect(store.create({ ownerUserId: OWNER_A, text: '   ', source: 'user' }).ok).toBe(false);
    expect(
      store.create({ ownerUserId: OWNER_A, text: 'x'.repeat(MEMORY_ENTRY_MAX_CHARS + 1), source: 'user' }),
    ).toEqual({ ok: false, reason: 'over-limit', limit: MEMORY_ENTRY_MAX_CHARS });
    expect(store.create({ ownerUserId: OWNER_A, text: `a\u0000b`, source: 'user' }).ok).toBe(false);
    expect(store.list({ ownerUserId: OWNER_A })).toEqual([]);
  });

  it('到条数上限 ⇒ 拒绝并说明原因（不静默丢弃最旧的那条）', () => {
    for (let i = 0; i < MEMORY_MAX_CONFIRMED_ENTRIES; i += 1) {
      expect(store.create({ ownerUserId: OWNER_A, text: `第 ${i} 条`, source: 'user' }).ok).toBe(true);
    }
    const overflow = store.create({ ownerUserId: OWNER_A, text: '第 51 条', source: 'user' });
    expect(overflow).toEqual({ ok: false, reason: 'entry-count-limit' });
    expect(store.list({ ownerUserId: OWNER_A, status: 'confirmed' })).toHaveLength(MEMORY_MAX_CONFIRMED_ENTRIES);
  });
});

describe('记忆库：账号隔离（同一块盘）', () => {
  it('⭐ A 写的记忆，B **读不到**（越权读不到的一条落点）', () => {
    store.create({ ownerUserId: OWNER_A, text: 'A 的偏好：结论先行。', source: 'user' });
    store.create({ ownerUserId: OWNER_B, text: 'B 的偏好：先看数据。', source: 'user' });

    expect(store.list({ ownerUserId: OWNER_A, status: 'confirmed' }).map((e) => e.text)).toEqual([
      'A 的偏好：结论先行。',
    ]);
    expect(store.list({ ownerUserId: OWNER_B, status: 'confirmed' }).map((e) => e.text)).toEqual([
      'B 的偏好：先看数据。',
    ]);
  });

  it('⭐ 换账号不串：A 的条目在 B 的作用域里连 id 都查不到（确认/删除都失败）', () => {
    const created = store.create({ ownerUserId: OWNER_A, text: 'A 的条目', source: 'user' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(store.confirm({ ownerUserId: OWNER_B, id: created.entry.id })).toEqual({ ok: false, reason: 'not-found' });
    expect(store.remove({ ownerUserId: OWNER_B, id: created.entry.id })).toEqual({ ok: false, reason: 'not-found' });
    expect(store.reject({ ownerUserId: OWNER_B, id: created.entry.id })).toEqual({ ok: false, reason: 'not-found' });
    // A 那条**没被动过**
    expect(store.list({ ownerUserId: OWNER_A, status: 'confirmed' })).toHaveLength(1);
  });

  it('匿名（未登录）是**独立作用域**：登录后看不到匿名期写的那条', () => {
    store.create({ ownerUserId: '', text: '匿名期写的一条', source: 'user' });
    expect(store.list({ ownerUserId: 'user-a', status: 'confirmed' })).toEqual([]);
    expect(store.list({ ownerUserId: '', status: 'confirmed' })).toHaveLength(1);
  });

  it('两个"账号"写同一句话互不影响（去重键按账号分作用域）', () => {
    expect(store.create({ ownerUserId: OWNER_A, text: '同一句话', source: 'user' }).ok).toBe(true);
    expect(store.create({ ownerUserId: OWNER_B, text: '同一句话', source: 'user' }).ok).toBe(true);
  });
});

describe('记忆库：草案轨道（助手提的那条）', () => {
  it('⭐ 草案默认是 pending，**不**出现在已确认集合里（未确认 = 没记住）', () => {
    const proposed = store.propose({ ownerUserId: OWNER_A, text: '用户在做电商', sourceTaskId: 't1', sourceMessageId: 'm1' });
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    expect(proposed.entry.status).toBe('pending');
    expect(proposed.entry.source).toBe('assistant');
    expect(proposed.entry.sourceTaskId).toBe('t1');
    expect(proposed.entry.decidedAt).toBeNull();

    expect(store.list({ ownerUserId: OWNER_A, status: 'confirmed' })).toEqual([]);
    expect(store.list({ ownerUserId: OWNER_A, status: 'pending' })).toHaveLength(1);
  });

  it('确认之后才进已确认集合，且**带上决定时刻**', () => {
    const proposed = store.propose({ ownerUserId: OWNER_A, text: '用户在做电商' });
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;

    const confirmed = store.confirm({ ownerUserId: OWNER_A, id: proposed.entry.id });
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.entry.status).toBe('confirmed');
    expect(confirmed.entry.decidedAt).not.toBeNull();
    expect(store.list({ ownerUserId: OWNER_A, status: 'confirmed' })).toHaveLength(1);
    expect(store.list({ ownerUserId: OWNER_A, status: 'pending' })).toEqual([]);
  });

  it('用户可以在确认时**改正文**，落库的是改过的那份', () => {
    const proposed = store.propose({ ownerUserId: OWNER_A, text: '用户在电商' });
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    const confirmed = store.confirm({ ownerUserId: OWNER_A, id: proposed.entry.id, text: '用户在跨境电商行业。' });
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.entry.text).toBe('用户在跨境电商行业。');
  });

  it('⭐ 拒绝之后**不再重复提同一件**（助手下一轮提同一条 ⇒ duplicate，不进待确认栏）', () => {
    const proposed = store.propose({ ownerUserId: OWNER_A, text: '用户在做电商' });
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    expect(store.reject({ ownerUserId: OWNER_A, id: proposed.entry.id }).ok).toBe(true);

    const again = store.propose({ ownerUserId: OWNER_A, text: '用户在做电商' });
    expect(again).toEqual({ ok: false, reason: 'duplicate' });
    expect(store.list({ ownerUserId: OWNER_A, status: 'pending' })).toEqual([]);
    // 拒绝是**留痕**的，不是删掉
    expect(store.list({ ownerUserId: OWNER_A, status: 'rejected' })).toHaveLength(1);
  });

  it('已确认过的同一件事，助手再提也是 duplicate', () => {
    store.create({ ownerUserId: OWNER_A, text: '用户在做电商', source: 'user' });
    expect(store.propose({ ownerUserId: OWNER_A, text: '用户在做电商' })).toEqual({ ok: false, reason: 'duplicate' });
  });

  it('空正文 / 纯标点的草案**不上屏**（不落库）', () => {
    expect(store.propose({ ownerUserId: OWNER_A, text: '   ' })).toEqual({ ok: false, reason: 'empty' });
    expect(store.propose({ ownerUserId: OWNER_A, text: '……' })).toEqual({ ok: false, reason: 'empty' });
    expect(store.list({ ownerUserId: OWNER_A })).toEqual([]);
  });

  it('草案超长**照样能提**（用户编辑时再看长度），但确认那一步按上限拒绝', () => {
    const long = 'x'.repeat(MEMORY_ENTRY_MAX_CHARS + 10);
    const proposed = store.propose({ ownerUserId: OWNER_A, text: long });
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    expect(store.confirm({ ownerUserId: OWNER_A, id: proposed.entry.id })).toEqual({
      ok: false,
      reason: 'over-limit',
      limit: MEMORY_ENTRY_MAX_CHARS,
    });
    // 被拒绝了也没落进已确认集合
    expect(store.list({ ownerUserId: OWNER_A, status: 'confirmed' })).toEqual([]);
  });

  it('别人的草案确认/拒绝都查不到（not-found，不是静默成功）', () => {
    const proposed = store.propose({ ownerUserId: OWNER_A, text: 'A 的草案' });
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    expect(store.confirm({ ownerUserId: OWNER_B, id: proposed.entry.id })).toEqual({ ok: false, reason: 'not-found' });
  });
});
