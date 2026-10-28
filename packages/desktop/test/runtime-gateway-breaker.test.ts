import { describe, expect, it, vi } from 'vitest';
import {
  GATEWAY_BOOT_LOOP_UNCLEAN_THRESHOLD,
  GATEWAY_BOOT_LOOP_WINDOW_MS,
  GATEWAY_CRASH_LOOP_BREAKER,
  crashLoopBreakerGuidance,
  decideCrashLoopBreaker,
  inspectCrashLoopBreaker,
  stateSqlitePath,
  type BootLifecycleRow,
} from '../src/main/runtime/gateway-breaker.js';

/**
 * BUG-040 ④：崩溃循环熔断（`gateway.crash_loop_breaker`）的**只读**侦测。
 *
 * 现场（2026-10-07 pre17 用户盘）：23:08 起 7 次 `startup_failed`，23:19:42 触发熔断，
 * 网关从此拒启 —— 而用户看到只有"一直卡着"。这一层要能说出"是被自我保护挡下了、
 * 还得等几分钟"，且**绝不碰内核的状态表**（那是防崩溃循环的安全机制）。
 *
 * BUG-059（2026-10-08）：判据必须与内核**逐字对齐**（实读 `gateway-boot-lifecycle-*.mjs`）：
 *   `tripped = uncleanBoots >= 3`（5 分钟窗口）；`gateway.crash_loop_breaker` 标记
 *   **不参与** tripped —— 它是内核自愈的触发条件（`recovered = !tripped && marker`）：
 *   窗口排空后，下一次内核启动会写 `gateway.crash_loop_recovered` 收掉标记。
 *   旧实现把"标记未恢复"并进 tripped ⇒ **曾熔断的盘被永久挡在启动前**（自愈行永远等不到）。
 */

const NOW = 1_800_000_000_000;
const row = (over: Partial<BootLifecycleRow>): BootLifecycleRow => ({
  started_at_ms: NOW - 60_000,
  completed_at_ms: null,
  outcome: null,
  startup_reason: null,
  ...over,
});

describe('decideCrashLoopBreaker（内核判据的对照实现）', () => {
  it('窗口内 3 次不干净启动 ⇒ 熔断，并给出"计数降到阈值以下"的等待时间', () => {
    const state = decideCrashLoopBreaker(
      [
        row({ started_at_ms: NOW - 10_000 }),
        row({ started_at_ms: NOW - 20_000 }),
        row({ started_at_ms: NOW - 30_000 }),
      ],
      NOW,
    );
    expect(state).toMatchObject({ available: true, tripped: true, uncleanBoots: 3 });
    // BUG-059 新语义：retryAfterMs = 窗口内计数**降到阈值以下**的时刻 − now。
    // 每条 open 行的滑出时刻 = started_at + 窗口 ⇒ NOW+290s / NOW+280s / NOW+270s，
    // 第 3 新（= 计数落到 2 的那一刻）是 NOW+270s ⇒ 270_000。
    // （旧实现按"熔断行时刻 + 窗口"算、恒等于 300_000 —— 语义错误，已随本修法替换。）
    expect(state.retryAfterMs).toBe(270_000);
    expect(GATEWAY_BOOT_LOOP_UNCLEAN_THRESHOLD).toBe(3);
  });

  it('只有 2 次 ⇒ 不熔断（阈值不是"一有失败就熔断"）', () => {
    expect(
      decideCrashLoopBreaker([row({ started_at_ms: NOW - 10_000 }), row({ started_at_ms: NOW - 20_000 })], NOW),
    ).toMatchObject({ tripped: false, uncleanBoots: 2 });
  });

  it('窗口外的旧失败不算（5 分钟是滑动窗口）', () => {
    const state = decideCrashLoopBreaker(
      [
        row({ started_at_ms: NOW - 10_000 }),
        row({ started_at_ms: NOW - GATEWAY_BOOT_LOOP_WINDOW_MS - 1 }),
        row({ started_at_ms: NOW - GATEWAY_BOOT_LOOP_WINDOW_MS - 2 }),
      ],
      NOW,
    );
    expect(state.uncleanBoots).toBe(1);
    expect(state.tripped).toBe(false);
  });

  it('已收尾的成功启动不算"不干净"；维护性失败也不算', () => {
    const state = decideCrashLoopBreaker(
      [
        row({ started_at_ms: NOW - 1_000, completed_at_ms: NOW - 500, outcome: 'ok' }),
        row({
          started_at_ms: NOW - 2_000,
          completed_at_ms: NOW - 1_500,
          outcome: 'startup_failed',
          startup_reason: 'gateway.maintenance_required',
        }),
        // 旧内核口径的另一种维护原因（照抄内核常量）
        row({
          started_at_ms: NOW - 3_000,
          completed_at_ms: NOW - 2_500,
          outcome: 'startup_failed',
          startup_reason: 'gateway.agent_media_migration_required',
        }),
      ],
      NOW,
    );
    expect(state.uncleanBoots).toBe(0);
    expect(state.tripped).toBe(false);
  });

  it('窗口外的 completed 失败也不算（判据看的是收尾时刻）', () => {
    const state = decideCrashLoopBreaker(
      [
        row({
          started_at_ms: NOW - GATEWAY_BOOT_LOOP_WINDOW_MS - 5_000,
          completed_at_ms: NOW - GATEWAY_BOOT_LOOP_WINDOW_MS - 1,
          outcome: 'startup_failed',
        }),
      ],
      NOW,
    );
    expect(state.uncleanBoots).toBe(0);
  });

  it('⭐（BUG-059）熔断行仍在（未恢复）+ 窗口已排空 ⇒ **不熔断**：标记只是诊断，内核会自愈', () => {
    // 旧实现：tripped = uncleanBoots>=3 || breakerUnrecovered ⇒ 这盘被永久挡在启动前，
    // 而内核的自愈恰恰需要"下一次启动"（recovered = !tripped && marker）——永远等不到。
    // 场景 = 熔断已过去 >5 分钟（窗口自然排空），熔断行还在表里。
    const breakerAt = NOW - GATEWAY_BOOT_LOOP_WINDOW_MS - 60_000;
    const state = decideCrashLoopBreaker(
      [
        row({
          started_at_ms: breakerAt,
          completed_at_ms: null,
          outcome: null,
          startup_reason: 'gateway.crash_loop_breaker',
        }),
      ],
      NOW,
    );
    expect(state.tripped).toBe(false);
    expect(state.uncleanBoots).toBe(0);
    // 现场证据仍要留着（诊断/日志看得见），但**不参与** tripped。
    expect(state.breakerStartedAtMs).toBe(breakerAt);
    expect(state.breakerUnrecovered).toBe(true);
    expect(state.retryAfterMs).toBeUndefined();
  });

  it('⭐（BUG-059）未恢复熔断行（窗口外）+ 窗口内不干净 <3 ⇒ 不熔断（放行让内核写 recovered 行）', () => {
    const state = decideCrashLoopBreaker(
      [
        row({
          started_at_ms: NOW - GATEWAY_BOOT_LOOP_WINDOW_MS - 60_000,
          startup_reason: 'gateway.crash_loop_breaker',
        }),
        row({ started_at_ms: NOW - 10_000 }),
        row({ started_at_ms: NOW - 20_000 }),
      ],
      NOW,
    );
    expect(state.uncleanBoots).toBe(2);
    expect(state.tripped).toBe(false);
    expect(state.breakerUnrecovered).toBe(true);
  });

  it('⭐（BUG-059）熔断行（窗口外）+ 窗口内仍 3 次不干净 ⇒ 仍熔断（判据是计数，不是标记）', () => {
    const state = decideCrashLoopBreaker(
      [
        row({
          started_at_ms: NOW - GATEWAY_BOOT_LOOP_WINDOW_MS - 60_000,
          startup_reason: 'gateway.crash_loop_breaker',
        }),
        row({ started_at_ms: NOW - 10_000 }),
        row({ started_at_ms: NOW - 20_000 }),
        row({ started_at_ms: NOW - 30_000 }),
      ],
      NOW,
    );
    expect(state.tripped).toBe(true);
    expect(state.uncleanBoots).toBe(3);
    expect(state.breakerUnrecovered).toBe(true);
    expect(state.retryAfterMs).toBe(270_000);
  });

  it('⭐ 内核逐字对齐：open 的熔断/恢复标记行**也算**不干净（内核 SQL 只排除维护性原因）', () => {
    // 内核查询：startup_reason IS NULL OR NOT IN (维护原因)，再叠 open-in-window / failed-in-window。
    // 熔断行与恢复行都是 open 行且不是维护原因 ⇒ 窗口内照样计入计数（与内核一致，别"好心"排除）。
    const state = decideCrashLoopBreaker(
      [
        row({ started_at_ms: NOW - 60_000, startup_reason: 'gateway.crash_loop_breaker' }),
        row({ started_at_ms: NOW - 120_000, startup_reason: 'gateway.crash_loop_recovered' }),
        row({ started_at_ms: NOW - 10_000 }),
      ],
      NOW,
    );
    expect(state.uncleanBoots).toBe(3);
    expect(state.tripped).toBe(true);
  });

  it('⭐ retryAfterMs 按每条行自己的滑出时刻算：failed 行看 completed_at、open 行看 started_at', () => {
    const state = decideCrashLoopBreaker(
      [
        row({ started_at_ms: NOW - 100_000, completed_at_ms: NOW - 5_000, outcome: 'startup_failed' }),
        row({ started_at_ms: NOW - 200_000, completed_at_ms: NOW - 40_000, outcome: 'startup_failed' }),
        row({ started_at_ms: NOW - 50_000 }),
      ],
      NOW,
    );
    expect(state.uncleanBoots).toBe(3);
    expect(state.tripped).toBe(true);
    // 滑出时刻（新→旧）：NOW+295s（completed-5s）/ NOW+260s（completed-40s）/ NOW+250s（open-50s）
    // ⇒ 第 3 新 = NOW+250s
    expect(state.retryAfterMs).toBe(250_000);
  });

  it('⭐ 恢复行在熔断行之后 ⇒ 标记已被收掉（内核自己的窗口自愈）', () => {
    const state = decideCrashLoopBreaker(
      [
        row({ started_at_ms: NOW - 60_000, startup_reason: 'gateway.crash_loop_breaker' }),
        row({ started_at_ms: NOW - 30_000, startup_reason: 'gateway.crash_loop_recovered' }),
      ],
      NOW,
    );
    expect(state.tripped).toBe(false);
    expect(state.breakerUnrecovered).toBe(false);
  });

  it('⭐（BUG-059）恢复行**不清计数**：窗口内计数够 3 就仍熔断（判据只有计数）', () => {
    const state = decideCrashLoopBreaker(
      [
        row({ started_at_ms: NOW - 90_000, startup_reason: 'gateway.crash_loop_recovered' }),
        row({ started_at_ms: NOW - 10_000 }),
        row({ started_at_ms: NOW - 20_000 }),
      ],
      NOW,
    );
    expect(state.uncleanBoots).toBe(3);
    expect(state.tripped).toBe(true);
  });
});

describe('inspectCrashLoopBreaker（只读 + 永不抛）', () => {
  it('读得到 ⇒ 给判定；用注入的读取器（单测不碰真 sqlite）', () => {
    const readRows = vi.fn(() => [row({ started_at_ms: NOW - 1_000 })]);
    const state = inspectCrashLoopBreaker('C:\\state', { readRows, now: () => NOW });
    expect(readRows).toHaveBeenCalledWith(stateSqlitePath('C:\\state'));
    expect(state.available).toBe(true);
  });

  it('⭐ 读不到（库不在/表不在/原生模块问题）⇒ available:false 且不熔断（诊断不许掀翻启动）', () => {
    expect(inspectCrashLoopBreaker('C:\\state', { readRows: () => null, now: () => NOW })).toMatchObject({
      available: false,
      tripped: false,
    });
    expect(
      inspectCrashLoopBreaker('C:\\state', {
        readRows: () => {
          throw new Error('SQLITE_CANTOPEN');
        },
        now: () => NOW,
      }),
    ).toMatchObject({ available: false, tripped: false });
  });

  it('sqlite 路径 = <stateDir>/state/openclaw.sqlite（与内核 resolveOpenClawStateSqlitePath 一致）', () => {
    expect(stateSqlitePath('E:\\Partner-W-运行数据\\state\\abc')).toBe(
      'E:\\Partner-W-运行数据\\state\\abc\\state\\openclaw.sqlite',
    );
  });
});

describe('指引文案（进 reason，用户/客服都要能照做）', () => {
  it('熔断时给出"等几分钟/退出应用再试"的指引', () => {
    const guidance = crashLoopBreakerGuidance({
      available: true,
      tripped: true,
      uncleanBoots: 3,
      retryAfterMs: 120_000,
    });
    expect(guidance).toContain('2 分钟');
    expect(guidance).toMatch(/退出应用/u);
    expect(guidance).toMatch(/反复/u);
  });

  it('没熔断 ⇒ 空串（不乱说话）', () => {
    expect(crashLoopBreakerGuidance({ available: true, tripped: false, uncleanBoots: 1 })).toBe('');
  });

  it('失败码是独立的、**不在** bootstrap 重试白名单里（反复重试只会延长那 5 分钟）', async () => {
    expect(GATEWAY_CRASH_LOOP_BREAKER).toBe('runtime.gateway-crash-loop-breaker');
    const { isTransientBootstrapFailure } = await import('../src/main/runtime/bootstrap-retry.js');
    expect(isTransientBootstrapFailure({ code: GATEWAY_CRASH_LOOP_BREAKER })).toBe(false);
  });
});
