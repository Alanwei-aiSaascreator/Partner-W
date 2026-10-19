import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  agentDatabasePaths,
  clearProviderBillingCooldowns,
  resolveCooldownStateDirs,
  type SqliteLike,
} from '../src/main/commercial/auth-cooldown.js';

/**
 * ⚠️ 单测**不能**用 better-sqlite3：仓库里那份是随 Electron 重建的（ABI 132），
 * 系统 Node 24 要 137 ⇒ 直接 `NODE_MODULE_VERSION` 报错。生产仍走 better-sqlite3，
 * 测试注入 `node:sqlite`（同一套 SQL 语义）。
 */
const openNodeSqlite = (dbPath: string): SqliteLike => new DatabaseSync(dbPath) as unknown as SqliteLike;

/**
 * BUG-161（2026-10-18 实机）：旧卡欠费 ⇒ 网关给 `clawrouter` 打 10 分钟 billing 冷却，
 * 且按 provider 持久化在 agent 库里 ⇒ 换卡、重启都清不掉。这里钉住"定向清除"语义：
 *   · 只删 `inline-api-key:clawrouter`，其它 provider / usage 字段原样保留；
 *   · 空目录、没有表、坏 JSON 都不抛；
 *   · 多个 agent 库逐个清。
 */

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clawwork-auth-cooldown-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function seedDb(agentId: string, state: unknown | string): string {
  const dir = join(root, 'agents', agentId, 'agent');
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'openclaw-agent.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(
    "CREATE TABLE auth_profile_state (state_key TEXT PRIMARY KEY, state_json TEXT NOT NULL, updated_at INTEGER NOT NULL)",
  );
  db.prepare("INSERT INTO auth_profile_state (state_key, state_json, updated_at) VALUES ('primary', ?, 0)").run(
    typeof state === 'string' ? state : JSON.stringify(state),
  );
  db.close();
  return dbPath;
}

function readState(dbPath: string): Record<string, unknown> {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const row = db.prepare("SELECT state_json FROM auth_profile_state WHERE state_key = 'primary'").get() as {
    state_json: string;
  };
  db.close();
  return JSON.parse(row.state_json) as Record<string, unknown>;
}

describe('agentDatabasePaths', () => {
  it('只返回真实存在的 agent 库', () => {
    seedDb('main', { usageStats: {} });
    mkdirSync(join(root, 'agents', 'ghost', 'agent'), { recursive: true });
    expect(agentDatabasePaths(root)).toEqual([join(root, 'agents', 'main', 'agent', 'openclaw-agent.sqlite')]);
  });

  it('没有 agents 目录 ⇒ 空数组（不抛）', () => {
    expect(agentDatabasePaths(join(root, 'nope'))).toEqual([]);
  });
});

describe('clearProviderBillingCooldowns', () => {
  it('⭐ 只删 clawrouter 的计费冷却，保留其它 provider 与用量字段', () => {
    const dbPath = seedDb('main', {
      version: 1,
      usageStats: {
        'inline-api-key:clawrouter': { disabledUntil: 1792317659046, disabledReason: 'billing', errorCount: 1 },
        'inline-api-key:openrouter': { disabledUntil: 1792317659046, disabledReason: 'billing' },
        'some-profile': { lastUsed: 123 },
      },
    });

    const result = clearProviderBillingCooldowns({ stateDirs: [root], openDatabase: openNodeSqlite });

    expect(result).toMatchObject({ databases: 1, cleared: 1, skipped: 0 });
    const state = readState(dbPath) as { usageStats: Record<string, unknown> };
    expect(state.usageStats['inline-api-key:clawrouter']).toBeUndefined();
    expect(state.usageStats['inline-api-key:openrouter']).toBeDefined();
    expect(state.usageStats['some-profile']).toEqual({ lastUsed: 123 });
  });

  it('没有该条目 ⇒ cleared=0，且不改文件内容', () => {
    const dbPath = seedDb('main', { usageStats: { 'inline-api-key:openrouter': { lastUsed: 1 } } });
    const before = readState(dbPath);
    const result = clearProviderBillingCooldowns({ stateDirs: [root], openDatabase: openNodeSqlite });
    expect(result.cleared).toBe(0);
    expect(readState(dbPath)).toEqual(before);
  });

  it('多个 agent 库逐个清', () => {
    seedDb('main', { usageStats: { 'inline-api-key:clawrouter': { disabledUntil: 1 } } });
    seedDb('writer', { usageStats: { 'inline-api-key:clawrouter': { disabledUntil: 2 } } });
    const result = clearProviderBillingCooldowns({ stateDirs: [root], openDatabase: openNodeSqlite });
    expect(result).toMatchObject({ databases: 2, cleared: 2, skipped: 0 });
  });

  it('坏 JSON / 缺表 ⇒ 不抛（skipped 计数）', () => {
    seedDb('main', '{not json');
    const missingTableDir = join(root, 'agents', 'empty', 'agent');
    mkdirSync(missingTableDir, { recursive: true });
    new DatabaseSync(join(missingTableDir, 'openclaw-agent.sqlite')).close();

    const result = clearProviderBillingCooldowns({ stateDirs: [root], openDatabase: openNodeSqlite });

    // 坏 JSON 是"读到但解析不了" ⇒ 安全 no-op（不清、也不算异常）；
    // 缺表才是真的读不了 ⇒ 计一次 skipped。
    expect(result.cleared).toBe(0);
    expect(result.skipped).toBe(1);
  });
});

describe('resolveCooldownStateDirs（自审 2026-10-18：便携身份目录）', () => {
  it('⭐ 便携形态的 state/<token哈希> 也在候选里（否则启动时清除会静默漏掉）', () => {
    const identity = join(root, 'state', 'f560ba0a094c8527b978bf35');
    mkdirSync(identity, { recursive: true });

    const dirs = resolveCooldownStateDirs(root, undefined);

    expect(dirs).toContain(join(root, 'openclaw-state'));
    expect(dirs).toContain(identity);
  });

  it('env 里的真实 state 目录排在最前且去重', () => {
    const dirs = resolveCooldownStateDirs(root, '  D:/custom/state  ');
    expect(dirs[0]).toBe('D:/custom/state');
    expect(new Set(dirs).size).toBe(dirs.length);
  });

  it('候选目录里的冷却都能被清掉（跨目录扫描）', () => {
    const identity = join(root, 'state', 'abc123');
    const dbPath = join(identity, 'agents', 'main', 'agent');
    mkdirSync(dbPath, { recursive: true });
    const db = new DatabaseSync(join(dbPath, 'openclaw-agent.sqlite'));
    db.exec(
      "CREATE TABLE auth_profile_state (state_key TEXT PRIMARY KEY, state_json TEXT NOT NULL, updated_at INTEGER NOT NULL)",
    );
    db.prepare("INSERT INTO auth_profile_state (state_key, state_json, updated_at) VALUES ('primary', ?, 0)").run(
      JSON.stringify({ usageStats: { 'inline-api-key:clawrouter': { disabledUntil: 1 } } }),
    );
    db.close();

    const result = clearProviderBillingCooldowns({
      stateDirs: resolveCooldownStateDirs(root, undefined),
      openDatabase: openNodeSqlite,
    });
    expect(result.cleared).toBe(1);
  });
});
