import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { PORTABLE_STATE_DIR_NAME, stateDirFor } from '../runtime/state-config.js';

/**
 * 「计费失败冷却」的**定向清除**（BUG-161，2026-10-18 实机）。
 *
 * ## 现场
 *
 * 用户旧卡余额不足 → relay 返回 `402 insufficient balance` → 网关把 provider
 * `clawrouter` 的内联 key 标记为 `billing` 冷却 **10 分钟**。用户换了一张 10 万积分
 * 的新卡，**仍然不能发消息**：
 *
 * - 冷却存的是 `usageStats["inline-api-key:clawrouter"]` —— **按 provider 记，不区分卡**；
 * - 它持久化在 `agents/<id>/agent/openclaw-agent.sqlite` 的 `auth_profile_state` 表里
 *   ⇒ **重启客户端也不会清**，只能干等 10 分钟。
 *
 * ## 这里做什么
 *
 * 只删除 `inline-api-key:<provider>` 这一条 usage 记录（保留其它 provider / 其它
 * usage 字段），在**激活/恢复授权成功**与**应用启动**时各尝试一次。
 *
 * ⚠️ 真实生效依赖"网关重新读那份 store"：网关在 worker 里对 auth store 有缓存，
 *    所以激活后的清除是**尽力而为**；应用启动时（网关尚未拉起）清除则是**可靠**的。
 *    两者都需要，缺一不可。
 *
 * ⚠️ 全函数**不抛**：这是收尾动作，绝不能把"换卡"本身搞失败。
 */

const INLINE_PREFIX = 'inline-api-key:';

export interface ClearCooldownResult {
  /** 扫到的 agent 数据库数。 */
  databases: number;
  /** 删掉的冷却条目数。 */
  cleared: number;
  /** 打不开/被锁/结构不符的库数（不算失败，只用于日志）。 */
  skipped: number;
}

/**
 * 需要检查的 state 目录（去重）。
 *
 * ⚠️ **不能只用 `stateDirFor(userDataDir)`**（自审 2026-10-18 抓到）：便携形态下
 * 真正在用的是 `<userData>/state/<token哈希>`（`portableStateDirFor`），
 * `stateDirFor` 指向的 `<userData>/openclaw-state` **根本不存在** ⇒ 启动时那次清除会
 * 静默漏掉，用户的 10 分钟冷却依旧。
 *
 * 因此把所有可能的位置都列出来：env（网关运行期的真值）→ 安装形态目录 → 便携身份目录们。
 * 只读目录名，不碰文件内容；不存在就跳过。
 */
export function resolveCooldownStateDirs(userDataDir: string, fromEnv: string | undefined): string[] {
  const dirs = new Set<string>();
  const env = typeof fromEnv === 'string' ? fromEnv.trim() : '';
  if (env) dirs.add(env);
  dirs.add(stateDirFor(userDataDir));
  const portableRoot = path.join(userDataDir, PORTABLE_STATE_DIR_NAME);
  try {
    for (const name of readdirSync(portableRoot)) {
      const candidate = path.join(portableRoot, name);
      try {
        if (statSync(candidate).isDirectory()) dirs.add(candidate);
      } catch {
        // 单个目录读不到不影响其它候选。
      }
    }
  } catch {
    // 没有便携 identity 目录（安装形态/首次启动）。
  }
  return [...dirs];
}

/** `agents/<agent>/agent/openclaw-agent.sqlite`（只认真实存在的）。 */
export function agentDatabasePaths(stateDir: string): string[] {
  const agentsRoot = path.join(stateDir, 'agents');
  if (!existsSync(agentsRoot)) return [];
  const out: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(agentsRoot);
  } catch {
    return [];
  }
  for (const entry of entries) {
    const db = path.join(agentsRoot, entry, 'agent', 'openclaw-agent.sqlite');
    if (existsSync(db)) out.push(db);
  }
  return out;
}

/** 最小 SQLite 面：better-sqlite3（生产）与 node:sqlite（单测）都满足。 */
export interface SqliteLike {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): unknown;
  };
  exec(sql: string): void;
  close(): void;
}

export type OpenDatabase = (dbPath: string) => SqliteLike;

/**
 * 生产实现：better-sqlite3（随 Electron 重建，ABI 与系统 Node 不同 ⇒ 单测不能用它，
 * 否则会报 NODE_MODULE_VERSION 132 vs 137）。
 */
const openBetterSqlite: OpenDatabase = (dbPath) => {
  const db = new Database(dbPath, { timeout: 1500 });
  return {
    prepare: (sql) => db.prepare(sql) as unknown as ReturnType<SqliteLike['prepare']>,
    exec: (sql) => {
      db.exec(sql);
    },
    close: () => db.close(),
  };
};

function clearInDatabase(dbPath: string, providerIds: readonly string[], open: OpenDatabase): number {
  const db = open(dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 1500');
    // ⚠️ 事务必须**包住读**：先 SELECT 再 BEGIN 的写法在两步之间会被网关写入抢进来，
    //    我们随后用旧快照 UPDATE，会把别人的 usageStats 一起写回去（真丢数据）。
    db.exec('BEGIN IMMEDIATE');
    let finished = false;
    const rollback = () => {
      if (finished) return;
      finished = true;
      try {
        db.exec('ROLLBACK');
      } catch {
        // 回滚失败按原错误上抛 / 或按无动作返回，交给调用方处理。
      }
    };
    try {
      const row = db.prepare("SELECT state_json FROM auth_profile_state WHERE state_key = 'primary'").get() as
        | { state_json?: unknown }
        | undefined;
      if (!row || typeof row.state_json !== 'string') {
        rollback();
        return 0;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.state_json);
      } catch {
        rollback();
        return 0;
      }
      if (!parsed || typeof parsed !== 'object') {
        rollback();
        return 0;
      }
      const state = parsed as { usageStats?: Record<string, unknown> };
      const stats = state.usageStats;
      if (!stats || typeof stats !== 'object') {
        rollback();
        return 0;
      }
      let removed = 0;
      for (const providerId of providerIds) {
        const key = `${INLINE_PREFIX}${providerId}`;
        if (Object.prototype.hasOwnProperty.call(stats, key)) {
          delete stats[key];
          removed += 1;
        }
      }
      if (removed === 0) {
        rollback();
        return 0;
      }
      const next = JSON.stringify(state);
      db.prepare("UPDATE auth_profile_state SET state_json = ?, updated_at = ? WHERE state_key = 'primary'").run(
        next,
        Date.now(),
      );
      db.exec('COMMIT');
      finished = true;
      return removed;
    } catch (error) {
      rollback();
      throw error;
    }
  } finally {
    db.close();
  }
}

/**
 * 清掉指定 provider 的计费冷却。默认只清 `clawrouter`。
 * 不改其它 provider、不改 profile store、不碰用户数据。
 */
export function clearProviderBillingCooldowns(input: {
  /** 候选 state 根（见 `resolveCooldownStateDirs`）。 */
  stateDirs: readonly string[];
  providerIds?: readonly string[];
  /** 单测注入（生产默认 better-sqlite3）。 */
  openDatabase?: OpenDatabase;
}): ClearCooldownResult {
  const providerIds = input.providerIds ?? (['clawrouter'] as const);
  const open = input.openDatabase ?? openBetterSqlite;
  const result: ClearCooldownResult = { databases: 0, cleared: 0, skipped: 0 };
  const seen = new Set<string>();
  for (const stateDir of input.stateDirs) {
    for (const dbPath of agentDatabasePaths(stateDir)) {
      if (seen.has(dbPath)) continue;
      seen.add(dbPath);
      result.databases += 1;
      try {
        result.cleared += clearInDatabase(dbPath, providerIds, open);
      } catch {
        // 被锁/结构不符：跳过这一份，不阻塞其它 agent。调用方按 `skipped` 记日志。
        result.skipped += 1;
      }
    }
  }
  return result;
}
