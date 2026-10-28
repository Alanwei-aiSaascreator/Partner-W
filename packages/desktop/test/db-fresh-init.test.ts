/**
 * 全新工作区（第一次安装 / 换 U 盘 / 换机器）：`initDatabase` 必须**一把建齐**。
 *
 * ## 为什么单独钉这一条（2026-09-20 发现）
 *
 * `openAndMigrate` 里既有一串 `migrateAddColumn(... ALTER TABLE ...)`，也有若干
 * `CREATE TABLE IF NOT EXISTS`。**改造语句必须排在自己那张表的 CREATE 之后** ——
 * 老库上表已存在，写反了也看不出来；**只有全新库会炸**：
 * `SqliteError: no such table: team_agents`（实测）。
 *
 * 这个错误 2026-09-20 由 `144507f7`（圆桌「职位」字段）引入：`ALTER TABLE team_agents
 * ADD COLUMN position` 被放进了 `tasks` 那一串改造里（第 135 行），而 `team_agents` 的
 * CREATE TABLE 在第 257 行。开发机上库早就建好了 ⇒ 一直没露头；**换台机器/新装就是打不开**。
 *
 * ⚠️ 这里驱动用 `node-sqlite-shim`（同 kb 系列）：仓库里的 better-sqlite3 是按
 * **Electron ABI** 编译的，vitest 跑在纯 node 里加载不了。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('better-sqlite3', async () => ({
  default: (await import('./helpers/node-sqlite-shim.js')).NodeSqliteShim,
}));

import { closeDatabase, getSqlite, initDatabase } from '../src/main/db/index.js';

describe('全新工作区：initDatabase 必须一次建齐', () => {
  let dir = '';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'clawwork-db-fresh-'));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  it('⭐ 空目录 init 不抛，且 `team_agents.position` 真的加上了（它曾写在 CREATE TABLE 之前）', () => {
    expect(() => initDatabase(dir)).not.toThrow();

    const sqlite = getSqlite();
    expect(sqlite).not.toBeNull();
    const columns = sqlite!.prepare('PRAGMA table_info(team_agents)').all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain('position');
  });

  it('tasks.mode 在全新库上一把建齐（任务模式：快速/智能/深度）', () => {
    expect(() => initDatabase(dir)).not.toThrow();

    const sqlite = getSqlite();
    const columns = sqlite!.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain('mode');
  });

  it('⭐ messages.duration_ms：全新库建齐，老库补上（整轮用时落库，2026-10-18）', () => {
    expect(() => initDatabase(dir)).not.toThrow();
    const sqlite = getSqlite()!;
    const columns = () =>
      (sqlite.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns()).toContain('duration_ms');

    // 老库（升级前装过的）没有这一列：模拟成"删掉再用同一份工作区 init 一次"。
    sqlite.prepare('ALTER TABLE messages DROP COLUMN duration_ms').run();
    expect(columns()).not.toContain('duration_ms');

    closeDatabase();
    expect(() => initDatabase(dir)).not.toThrow();
    expect(
      (getSqlite()!.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>).map((c) => c.name),
    ).toContain('duration_ms');
  });
});
