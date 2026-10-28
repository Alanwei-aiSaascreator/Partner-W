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
 * ⚠️ BUG-059（2026-10-08）—— 与内核**逐字对齐**的关键一条：
 *    内核的 tripped **只有** `uncleanBoots >= 阈值`（5 分钟窗口烘进 unclean 查询）；
 *    `gateway.crash_loop_breaker` 标记**不参与** tripped —— 它是内核**自愈**的触发条件
 *    （`recovered: !tripped && hasUnrecoveredBreakerMarker`）：窗口排空后，下一次内核启动
 *    才会写 `gateway.crash_loop_recovered` 把标记收掉。旧实现把"标记未恢复"并进 tripped
 *    ⇒ **曾熔断的盘被永久挡在启动前**（自愈行需要的正是那次启动，永远等不到）。
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
  /** 熔断中（内核会拒绝启动）。判据 = 5 分钟窗口内不干净启动 ≥ 阈值（与内核一致）。 */
  tripped: boolean;
  /** 窗口内的"不干净启动"次数。 */
  uncleanBoots: number;
  /**
   * `gateway.crash_loop_breaker` 标记存在且其后没有恢复行（**诊断用**——内核自愈的触发
   * 条件；**绝不参与** tripped，见文件头 BUG-059 注记）。
   */
  breakerUnrecovered?: boolean;
  /** 熔断行写入时刻（可读到时；诊断用）。 */
  breakerStartedAtMs?: number;
  /** 距离窗口排空（不干净计数降到阈值以下）还有多久（毫秒）；算不出就不给。 */
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
 * "窗口自然排空"的等待时间（BUG-059 新语义）：**窗口内不干净计数降到阈值以下**的时刻 − now。
 *
 * 每条不干净行各自滑出窗口：open 行 = `started_at + 窗口`（内核查询是 `started_at >=
 * windowStart`），failed 行 = `completed_at + 窗口`。计数落到 2（< 阈值 3）发生在**第 3 新**
 * 一条滑出的时刻 —— 即"第 threshold 大的滑出时刻"。
 *
 * 边界说明：内核 `>=` 取等 ⇒ 该时刻本身仍算在窗口内（毫秒级差一瞬）；指引按分钟向上取整
 * （`crashLoopBreakerGuidance`），对用户无感。
 */
function uncleanWindowRetryAfterMs(unclean: readonly BootLifecycleRow[], nowMs: number): number {
  const slideOutMs = unclean
    .map((row) => (row.completed_at_ms ?? row.started_at_ms) + GATEWAY_BOOT_LOOP_WINDOW_MS)
    .sort((a, b) => b - a);
  const clearedMs = slideOutMs[GATEWAY_BOOT_LOOP_UNCLEAN_THRESHOLD - 1];
  // 算不出（理论上 tripped 时必有 ≥ threshold 条）⇒ 保守回退一个窗口，绝不给出偏短的等待。
  if (clearedMs === undefined) return GATEWAY_BOOT_LOOP_WINDOW_MS;
  return Math.max(0, clearedMs - nowMs);
}

/**
 * 纯判定（与内核 `buildGatewayCrashLoopBreakerDecision` 同一套判据）。
 *
 * ⚠️ BUG-059：`tripped` **只看**窗口内不干净计数（内核判据）；`breakerUnrecovered` 只是
 *    诊断字段，绝不参与 tripped（它对应内核的 `recovered: !tripped && marker` 自愈触发）。
 */
export function decideCrashLoopBreaker(rows: readonly BootLifecycleRow[], nowMs: number): CrashLoopBreakerState {
  const windowStartMs = nowMs - GATEWAY_BOOT_LOOP_WINDOW_MS;
  const unclean = rows.filter((row) => isUnclean(row, windowStartMs));
  const uncleanBoots = unclean.length;
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
  const tripped = uncleanBoots >= GATEWAY_BOOT_LOOP_UNCLEAN_THRESHOLD;
  const state: CrashLoopBreakerState = { available: true, tripped, uncleanBoots, breakerUnrecovered };
  if (latestBreaker !== undefined) state.breakerStartedAtMs = latestBreaker;
  if (tripped) state.retryAfterMs = uncleanWindowRetryAfterMs(unclean, nowMs);
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
