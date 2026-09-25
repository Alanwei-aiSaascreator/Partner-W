import { describe, expect, it } from 'vitest';
import {
  BOOTSTRAP_MAX_ATTEMPTS,
  BOOTSTRAP_TOTAL_BUDGET_MS,
  bootstrapWithRetry,
  isTransientBootstrapFailure,
} from '../src/main/runtime/bootstrap-retry';

type Failure = { ok: false; code?: string | undefined; reason: string } | { ok: true };

/** 假时钟：把 sleep 记下来并累加，测试里一次真等待都没有。 */
function makeClock() {
  const sleeps: number[] = [];
  return {
    sleeps,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    total: () => sleeps.reduce((sum, ms) => sum + ms, 0),
  };
}

describe('运行时 bootstrap 的重试策略', () => {
  it('② 外部端口冲突不重试：一次就是终态，也不许去动别人的进程', async () => {
    const clock = makeClock();
    let attempts = 0;

    const result = await bootstrapWithRetry<Failure>({
      attempt: async () => {
        attempts += 1;
        return {
          ok: false,
          code: 'runtime.gateway-port-occupied',
          reason: '端口 18789 被另一个 OpenClaw 网关占用',
        };
      },
      sleep: clock.sleep,
    });

    expect(attempts).toBe(1);
    expect(clock.sleeps).toEqual([]);
    expect(result.ok).toBe(false);
  });

  it('③ 瞬时拒连有限重试：最多 3 次，且总等待不超过 30 秒', async () => {
    const clock = makeClock();
    let attempts = 0;

    const result = await bootstrapWithRetry<Failure>({
      attempt: async () => {
        attempts += 1;
        return { ok: false, code: 'runtime.gateway-not-ready', reason: '等待网关就绪超时' };
      },
      sleep: clock.sleep,
    });

    expect(attempts).toBe(BOOTSTRAP_MAX_ATTEMPTS);
    expect(clock.total()).toBeLessThanOrEqual(BOOTSTRAP_TOTAL_BUDGET_MS);
    expect(result.ok).toBe(false);
  });

  it('③b 中途好了就停手：第二次成功 ⇒ 只试两次', async () => {
    const clock = makeClock();
    let attempts = 0;

    const result = await bootstrapWithRetry<Failure>({
      attempt: async () => {
        attempts += 1;
        if (attempts === 1) return { ok: false, code: 'runtime.gateway-not-ready', reason: '网关还没起来' };
        return { ok: true };
      },
      sleep: clock.sleep,
    });

    expect(attempts).toBe(2);
    expect(result.ok).toBe(true);
  });

  it('③c 就算喂进来更长的等待表，次数也必须封在 3（次数闸说了算）', async () => {
    const clock = makeClock();
    let attempts = 0;

    await bootstrapWithRetry<Failure>({
      attempt: async () => {
        attempts += 1;
        return { ok: false, code: 'runtime.gateway-not-ready', reason: '一直没就绪' };
      },
      sleep: clock.sleep,
      // 断言"契约是 3 次"，而不是"等待表恰好两行" —— 没有这条，次数闸删掉也全绿。
      delaysMs: [1_000, 1_000, 1_000, 1_000, 1_000],
    });

    expect(attempts).toBe(BOOTSTRAP_MAX_ATTEMPTS);
  });

  it('对照：第一次就成功 ⇒ 只有一次，不等待', async () => {
    const clock = makeClock();
    let attempts = 0;

    const result = await bootstrapWithRetry<Failure>({
      attempt: async () => {
        attempts += 1;
        return { ok: true };
      },
      sleep: clock.sleep,
    });

    expect(attempts).toBe(1);
    expect(clock.sleeps).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('对照：不认识的失败码**不重试**（白名单，不是黑名单）', async () => {
    const clock = makeClock();
    let attempts = 0;

    await bootstrapWithRetry<Failure>({
      attempt: async () => {
        attempts += 1;
        return { ok: false, code: 'runtime.no-usable-node', reason: '没有可用的 node' };
      },
      sleep: clock.sleep,
    });

    expect(attempts).toBe(1);
    expect(isTransientBootstrapFailure({ code: 'runtime.no-usable-node', reason: 'x' })).toBe(false);
  });

  it('判据只认"没就绪"这一个码', () => {
    expect(isTransientBootstrapFailure({ code: 'runtime.gateway-not-ready', reason: '任意' })).toBe(true);
    expect(isTransientBootstrapFailure({ code: 'runtime.gateway-port-occupied', reason: '任意' })).toBe(false);
    expect(isTransientBootstrapFailure({ code: undefined, reason: '任意' })).toBe(false);
  });
});
