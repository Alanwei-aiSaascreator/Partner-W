/**
 * 部署进度的**快照 + 节流 + 停滞看门狗**（2026-10-07 体检问题 1/5）。
 *
 * 这个模块是"主进程一直知道在干什么、界面却看不到"这条链上的最后一跳：
 * 它自己不发 IPC、不解释错误，只负责把 `DeployProgress` 收成一份**能过 IPC 的闭集快照**
 * （阶段/计数/开始时间，没有路径没有文本），并保证不因为解压四万条回调把 IPC 打爆。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEPLOY_STALL_TIMEOUT_MS } from '../src/main/runtime/deploy-progress';
import {
  clearDeployProgress,
  createDeployStallWatch,
  getDeployProgress,
  publishDeployProgress,
  publishDeployStalled,
  shouldPublishDeployProgress,
} from '../src/main/runtime/deploy-progress';

beforeEach(() => clearDeployProgress());

describe('节流规则（1% 或 ≥250ms）', () => {
  const previous = { phase: 'extract' as const, done: 10, total: 1000, startedAt: 1 };

  it('第一条必发 / 阶段变化必发 / 这一阶段走完必发', () => {
    expect(
      shouldPublishDeployProgress({ previous: null, next: { phase: 'verify', done: 0, total: 2 }, sinceMs: 0 }),
    ).toBe(true);
    expect(shouldPublishDeployProgress({ previous, next: { phase: 'node', done: 0, total: 1 }, sinceMs: 10 })).toBe(
      true,
    );
    expect(
      shouldPublishDeployProgress({ previous, next: { phase: 'extract', done: 1000, total: 1000 }, sinceMs: 10 }),
    ).toBe(true);
  });

  it('百分比涨 ≥1% 就发；涨不到 1% 且还没到 250ms ⇒ 不发', () => {
    expect(
      shouldPublishDeployProgress({ previous, next: { phase: 'extract', done: 20, total: 1000 }, sinceMs: 10 }),
    ).toBe(true);
    expect(
      shouldPublishDeployProgress({ previous, next: { phase: 'extract', done: 15, total: 1000 }, sinceMs: 10 }),
    ).toBe(false);
    // 攒够 250ms 就发（哪怕百分比没动：它是"还在走"的证据）
    expect(
      shouldPublishDeployProgress({ previous, next: { phase: 'extract', done: 15, total: 1000 }, sinceMs: 250 }),
    ).toBe(true);
  });

  it('⭐ 从 `stalled` 回到真实事件：必发（否则界面继续挂着"这块盘很慢"）', () => {
    expect(
      shouldPublishDeployProgress({
        previous: { phase: 'stalled', done: 10, total: 1000, startedAt: 1 },
        next: { phase: 'extract', done: 15, total: 1000 },
        sinceMs: 0,
      }),
    ).toBe(true);
  });
});

describe('快照', () => {
  it('第一条记下开始时间，之后每一件都沿用（界面据此说"从开始等到现在"）', () => {
    const first = publishDeployProgress({ phase: 'verify', done: 0, total: 2 }, 1_000);
    expect(first).toEqual({ phase: 'verify', done: 0, total: 2, startedAt: 1_000 });
    const next = publishDeployProgress({ phase: 'verify', done: 2, total: 2 }, 5_000);
    expect(next?.startedAt, '开始时间不许被后一条刷掉').toBe(1_000);
    expect(getDeployProgress()).toEqual(next);
  });

  it('被节流的那条**不改快照**（界面还停在上一份真值上）', () => {
    publishDeployProgress({ phase: 'extract', done: 10, total: 1000 }, 1_000);
    const throttled = publishDeployProgress({ phase: 'extract', done: 15, total: 1000 }, 1_100);
    expect(throttled).toBeNull();
    expect(getDeployProgress()?.done).toBe(10);
  });

  it('停滞：保留已走过的阶段与计数，只把相位换成 `stalled`；没有部署在进行就什么都不说', () => {
    expect(publishDeployStalled(2_000), '没有部署在进行 ⇒ 不编一条').toBeNull();
    publishDeployProgress({ phase: 'verify', done: 0, total: 2 }, 1_000);
    const stalled = publishDeployStalled(2_000);
    expect(stalled).toEqual({ phase: 'stalled', done: 0, total: 2, startedAt: 1_000 });
    expect(publishDeployStalled(3_000), '已经在 stalled 就不重发').toBeNull();
  });

  it('清掉之后回到"没有部署在进行"（成功/失败都走这一步）', () => {
    publishDeployProgress({ phase: 'finalize', done: 1, total: 1 }, 1_000);
    clearDeployProgress();
    expect(getDeployProgress()).toBeNull();
    expect(publishDeployStalled(2_000)).toBeNull();
  });

  it('⭐ 快照是**闭集**：只有四个键（多一个字段都要先想清楚它过不过 IPC）', () => {
    const snapshot = publishDeployProgress({ phase: 'extract', done: 1, total: 2 }, 1_000);
    expect(Object.keys(snapshot ?? {}).sort()).toEqual(['done', 'phase', 'startedAt', 'total']);
    expect(JSON.stringify(snapshot)).not.toContain('\\'); // 没有路径这种东西
  });
});

describe('停滞看门狗（只提示，不中止）', () => {
  function fakeTimers() {
    let scheduled: { fn: () => void; ms: number } | null = null;
    return {
      timers: {
        set: (fn: () => void, ms: number) => {
          scheduled = { fn, ms };
          return 1;
        },
        clear: () => {
          scheduled = null;
        },
      },
      fire: () => {
        const current = scheduled;
        scheduled = null;
        current?.fn();
      },
      ms: () => scheduled?.ms,
      pending: () => scheduled !== null,
    };
  }

  it('静默超过阈值才喊一声；期间来事件就重新计时', () => {
    const onStall = vi.fn();
    const clock = fakeTimers();
    const watch = createDeployStallWatch({ onStall, timeoutMs: 90_000, timers: clock.timers });

    watch.touch();
    expect(clock.ms()).toBe(90_000);
    watch.touch(); // 又有事件 ⇒ 重新计时
    expect(clock.ms()).toBe(90_000);
    expect(onStall).not.toHaveBeenCalled();
    clock.fire();
    expect(onStall).toHaveBeenCalledTimes(1);
    expect(clock.pending(), '喊过一声就不再挂着：下一次由真实事件重新计时').toBe(false);
  });

  it('cancel 之后不再喊（部署走完 finalize / 整轮结束）', () => {
    const onStall = vi.fn();
    const clock = fakeTimers();
    const watch = createDeployStallWatch({ onStall, timers: clock.timers });
    watch.touch();
    watch.cancel();
    expect(clock.pending()).toBe(false);
    clock.fire();
    expect(onStall).not.toHaveBeenCalled();
  });

  it('默认阈值是 90 秒（与文案"这块盘读写很慢"对得上；改了要一起想）', () => {
    expect(DEPLOY_STALL_TIMEOUT_MS).toBe(90_000);
  });
});
