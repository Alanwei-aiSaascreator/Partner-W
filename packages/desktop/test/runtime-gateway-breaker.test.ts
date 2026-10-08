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
  it('窗口内 3 次不干净启动 ⇒ 熔断，并给出还要等多久', () => {
    const state = decideCrashLoopBreaker(
      [
        row({ started_at_ms: NOW - 10_000 }),
        row({ started_at_ms: NOW - 20_000 }),
        row({ started_at_ms: NOW - 30_000 }),
      ],
      NOW,
    );
    expect(state).toMatchObject({ available: true, tripped: true, uncleanBoots: 3 });
    expect(state.retryAfterMs).toBe(GATEWAY_BOOT_LOOP_WINDOW_MS);
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

  it('⭐ 熔断行仍在（未恢复）⇒ 就算窗口计数已排空也算熔断，且剩余时间按熔断行算', () => {
    const breakerAt = NOW - 60_000;
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
    expect(state.tripped).toBe(true);
    expect(state.breakerStartedAtMs).toBe(breakerAt);
    expect(state.retryAfterMs).toBe(GATEWAY_BOOT_LOOP_WINDOW_MS - 60_000);
  });

  it('⭐ 恢复行在熔断行之后 ⇒ 解除（内核自己的窗口自愈）', () => {
    const state = decideCrashLoopBreaker(
      [
        row({ started_at_ms: NOW - 60_000, startup_reason: 'gateway.crash_loop_breaker' }),
        row({ started_at_ms: NOW - 30_000, startup_reason: 'gateway.crash_loop_recovered' }),
      ],
      NOW,
    );
    expect(state.tripped).toBe(false);
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
    expect(stateSqlitePath('E:\\荣盈魔方-运行数据\\state\\abc')).toBe(
      'E:\\荣盈魔方-运行数据\\state\\abc\\state\\openclaw.sqlite',
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
