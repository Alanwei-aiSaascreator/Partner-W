/**
 * 网关的「崩溃循环熔断」（openclaw `gateway.crash_loop_breaker`）—— **只读**侦测 + 人话指引。
 *
 * 现场（2026-10-07 用户盘 pre17）：23:08 起 7 次启动全部 `startup_failed`，23:19:42
 * 网关触发 `gateway.crash_loop_breaker`，从此**拒绝启动**。用户侧的观感是"点了没反应/
 * 一直卡在本机服务"，而这句话（还有要等多久）在任何界面上都没有。
 *
 * 内核的真相（只读实读 `gateway-boot-lifecycle-*.mjs`，2026.9.3 dist）：
 *  - 状态存在 **state sqlite**（`<stateDir>/state/openclaw.sqlite`）的
 *    `gateway_boot_lifecycle` 表里；
 *  - 判据 = **5 分钟窗口内 ≥3 次"不干净启动"**（未收尾的行，或 `startup_failed`）；
 *  - 熔断后写入一行 `gateway.crash_loop_breaker`；**窗口自然排空后会自愈**
 *    （写 `gateway.crash_loop_recovered`）—— 也就是"等 5 分钟"是真的有用。
 *
 * ⚠️ 我们**不去改这张表**：它是内核的安全机制（防的就是反复崩启动），
 *    绕过它 = 把一个保护机制关掉，而且行形状随内核版本漂移。能做且应该做的是
 *    **如实告诉用户**："被自我保护挡下了，等 X 分钟或退出应用再试，别反复点"。
 *    复位交给内核自己的窗口自愈（这也是它的设计）。
 *
 * ⚠️ 全部只读 + 永不抛（读不到 = `available: false`，按"没熔断"处理）：
 *    这条链跑在**失败路径**上，诊断不能把启动流程再掀一次。
 */

import { createRequire } from 'node:module';
import path from 'node:path';

/** 熔断被检测到时 bootstrap 失败码（不在可重试白名单里 —— 反复重试只会延长熔断）。 */
export const GATEWAY_CRASH_LOOP_BREAKER = 'runtime.gateway-crash-loop-breaker';

/** 内核常量（`gateway-boot-lifecycle-*.mjs`）：窗口 5 分钟、阈值 3 次不干净启动。 */
export const GATEWAY_BOOT_LOOP_WINDOW_MS = 5 * 60_000;
export const GATEWAY_BOOT_LOOP_UNCLEAN_THRESHOLD = 3;

const BREAKER_REASON = 'gateway.crash_loop_breaker';
const RECOVERED_REASON = 'gateway.crash_loop_recovered';
/** 内核视为"维护性启动失败"的原因（不算进熔断计数）。 */
const MAINTENANCE_REASONS = new Set(['gateway.maintenance_required', 'gateway.agent_media_migration_required']);

export interface BootLifecycleRow {
  started_at_ms: number;
  completed_at_ms: number | null;
  outcome: string | null;
  startup_reason: string | null;
}

export interface CrashLoopBreakerState {
  /** 读到了生命周期表。（读不到 ⇒ false，判定按"没熔断"。） */
  available: boolean;
  /** 熔断中（内核会拒绝启动）。 */
  tripped: boolean;
  /** 窗口内的"不干净启动"次数。 */
  uncleanBoots: number;
  /** 熔断行写入时刻（可读到时）。 */
  breakerStartedAtMs?: number;
  /** 距离窗口自然排空还有多久（毫秒）；算不出就不给。 */
  retryAfterMs?: number;
}

function isUnclean(row: BootLifecycleRow, windowStartMs: number): boolean {
  if (row.startup_reason !== null && MAINTENANCE_REASONS.has(row.startup_reason)) return false;
  const open = row.completed_at_ms === null && row.started_at_ms >= windowStartMs;
  const failed =
    row.outcome === 'startup_failed' && row.completed_at_ms !== null && row.completed_at_ms >= windowStartMs;
  return open || failed;
}

/**
 * 纯判定（与内核 `inspectGatewayCrashLoopBreaker` 同一套判据）。
 */
export function decideCrashLoopBreaker(rows: readonly BootLifecycleRow[], nowMs: number): CrashLoopBreakerState {
  const windowStartMs = nowMs - GATEWAY_BOOT_LOOP_WINDOW_MS;
  const uncleanBoots = rows.filter((row) => isUnclean(row, windowStartMs)).length;
  const latestBreaker = rows
    .filter((row) => row.startup_reason === BREAKER_REASON)
    .reduce<
      number | undefined
    >((latest, row) => (latest === undefined || row.started_at_ms > latest ? row.started_at_ms : latest), undefined);
  const latestRecovery = rows
    .filter((row) => row.startup_reason === RECOVERED_REASON)
    .reduce<
      number | undefined
    >((latest, row) => (latest === undefined || row.started_at_ms > latest ? row.started_at_ms : latest), undefined);
  const breakerUnrecovered =
    latestBreaker !== undefined && (latestRecovery === undefined || latestRecovery < latestBreaker);
  const tripped = uncleanBoots >= GATEWAY_BOOT_LOOP_UNCLEAN_THRESHOLD || breakerUnrecovered;
  const state: CrashLoopBreakerState = { available: true, tripped, uncleanBoots };
  if (latestBreaker !== undefined) state.breakerStartedAtMs = latestBreaker;
  if (tripped) {
    const basis = latestBreaker ?? nowMs;
    state.retryAfterMs = Math.max(0, basis + GATEWAY_BOOT_LOOP_WINDOW_MS - nowMs);
  }
  return state;
}

const UNAVAILABLE: CrashLoopBreakerState = { available: false, tripped: false, uncleanBoots: 0 };

export interface InspectBreakerOptions {
  now?: () => number;
  /** 注入的行读取（测试用）；返回 `null` = 读不到（表不在/库打不开）。 */
  readRows?: (databasePath: string) => BootLifecycleRow[] | null;
}

/** state sqlite 的路径（内核 `resolveOpenClawStateSqliteDir` 同款：`<stateDir>/state`）。 */
export function stateSqlitePath(stateDir: string): string {
  return path.join(stateDir, 'state', 'openclaw.sqlite');
}

/**
 * 默认读取：**只读**打开 state sqlite，取最近窗口相关的那几十行。
 *
 * 只读 + `fileMustExist`：绝不会因为这个诊断建出一个空库来。
 */
function readRowsFromSqlite(databasePath: string): BootLifecycleRow[] | null {
  try {
    // 惰性 require（better-sqlite3 是原生模块，静态引进来会把它拖进不相关的单测）
    // ——与 `ws/tls-trust.ts` 同款写法。
    const require = createRequire(import.meta.url);
    const Database = require('better-sqlite3') as typeof import('better-sqlite3');
    const database = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
      const rows = database
        .prepare(
          'SELECT started_at_ms, completed_at_ms, outcome, startup_reason FROM gateway_boot_lifecycle ORDER BY started_at_ms DESC LIMIT 64',
        )
        .all() as BootLifecycleRow[];
      return Array.isArray(rows) ? rows : null;
    } finally {
      database.close();
    }
  } catch {
    return null;
  }
}

/** 侦测（只读；读不到 ⇒ `available: false`，按"没熔断"处理）。 */
export function inspectCrashLoopBreaker(stateDir: string, options: InspectBreakerOptions = {}): CrashLoopBreakerState {
  const now = options.now ?? (() => Date.now());
  try {
    const read = options.readRows ?? readRowsFromSqlite;
    const rows = read(stateSqlitePath(stateDir));
    if (!rows) return UNAVAILABLE;
    return decideCrashLoopBreaker(rows, now());
  } catch {
    return UNAVAILABLE;
  }
}

/** 给人看的指引（进 `reason`，日志与排障都看它）。 */
export function crashLoopBreakerGuidance(state: CrashLoopBreakerState): string {
  if (!state.tripped) return '';
  const minutes = state.retryAfterMs !== undefined ? Math.max(1, Math.ceil(state.retryAfterMs / 60_000)) : 5;
  return (
    `网关因连续异常启动触发了自我保护（crash_loop_breaker），约 ${minutes} 分钟内会自行解除。` +
    `请等待约 ${minutes} 分钟后再点「重新准备」，或完全退出应用稍后再试；` +
    '期间不要反复重启（反复启动会延长这段等待）。'
  );
}
