import { describe, expect, it, vi } from 'vitest';
import {
  BOOTSTRAP_MAX_ATTEMPTS,
  BOOTSTRAP_PROCESS_EXITED,
  BOOTSTRAP_READY_TIMEOUT,
  BOOTSTRAP_TOTAL_BUDGET_MS,
  bootstrapWithRetry,
  isReadyTimeoutWorthRetry,
  isTransientBootstrapFailure,
} from '../src/main/runtime/bootstrap-retry';

type Failure =
  | { ok: false; code?: string | undefined; reason: string; deployStatus?: 'deployed' | 'skipped' | undefined }
  | { ok: true };

/**
 * 假时钟，但**按真实墙钟语义**走：`attempt` 自己耗掉的时间也算进预算。
 *
 * ⚠️ 这正是上一版的洞：预算只数 `sleep`，于是"等待就绪 180 秒"这个 attempt
 *    在预算里是 0 —— 三次尝试加起来可以真等约 9 分钟。所以这里的每一条用例
 *    都把 attempt 的耗时喂进时钟，让"总墙钟"成为可证伪的量。
 */
function makeClock() {
  let nowMs = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => nowMs,
    advance: (ms: number) => {
      nowMs += ms;
    },
    sleep: async (ms: number) => {
      sleeps.push(ms);
      nowMs += ms;
    },
    totalSleep: () => sleeps.reduce((sum, ms) => sum + ms, 0),
    elapsed: () => nowMs,
  };
}

describe('运行时 bootstrap 的重试策略（真实墙钟语义）', () => {
  it('早退可有限重试：最多 3 次，总睡眠正好 15 秒', async () => {
    const clock = makeClock();
    let attempts = 0;

    const result = await bootstrapWithRetry<Failure>({
      attempt: async () => {
        attempts += 1;
        clock.advance(1_000); // 子进程很快退出：这次尝试只花 1 秒
        return { ok: false, code: BOOTSTRAP_PROCESS_EXITED, reason: '网关进程在就绪之前就退出了' };
      },
      sleep: clock.sleep,
      now: clock.now,
    });

    expect(attempts).toBe(BOOTSTRAP_MAX_ATTEMPTS);
    // 两个量分开断言 ⇒ 各自可证伪
    expect(clock.sleeps).toEqual([3_000, 12_000]);
    expect(clock.totalSleep()).toBe(15_000);
    expect(result.ok).toBe(false);
  });

  it('⭐ 180 秒就绪超时只许试一次：绝不第二次再等 180 秒', async () => {
    const clock = makeClock();
    let attempts = 0;

    await bootstrapWithRetry<Failure>({
      attempt: async () => {
        attempts += 1;
        clock.advance(180_000); // 等满 180 秒才失败
        return { ok: false, code: BOOTSTRAP_READY_TIMEOUT, reason: '等待网关就绪超时（180s）' };
      },
      sleep: clock.sleep,
      now: clock.now,
    });

    expect(attempts).toBe(1);
    expect(clock.sleeps).toEqual([]);
    expect(clock.elapsed()).toBe(180_000); // 总墙钟就是那一次，不多等
  });

  it('⭐ 终态码与**耗时无关**：就算它只花了 5 秒，也一次即终态', async () => {
    // 这条是**判据**用例：180 秒那次之所以只试一次，必须是因为"码不在白名单里"，
    // 而不是因为"它太慢、把预算吃穿了" —— 两者会互相遮蔽（变异电池实测）。
    const clock = makeClock();
    let attempts = 0;

    await bootstrapWithRetry<Failure>({
      attempt: async () => {
        attempts += 1;
        clock.advance(5_000); // 快得完全放得进预算
        return { ok: false, code: BOOTSTRAP_READY_TIMEOUT, reason: '就说等超时了（哪怕这次很快）' };
      },
      sleep: clock.sleep,
      now: clock.now,
    });

    expect(attempts).toBe(1);
    expect(clock.sleeps).toEqual([]);
  });

  it('外部端口冲突一次即终态（不重试、也不等待）', async () => {
    const clock = makeClock();
    let attempts = 0;

    const result = await bootstrapWithRetry<Failure>({
      attempt: async () => {
        attempts += 1;
        clock.advance(50);
        return { ok: false, code: 'runtime.gateway-port-occupied', reason: '端口被另一个网关占用' };
      },
      sleep: clock.sleep,
      now: clock.now,
    });

    expect(attempts).toBe(1);
    expect(clock.sleeps).toEqual([]);
    expect(result.ok).toBe(false);
  });

  it('未知码不重试（白名单，不是黑名单）', async () => {
    const clock = makeClock();
    let attempts = 0;

    await bootstrapWithRetry<Failure>({
      attempt: async () => {
        attempts += 1;
        clock.advance(10);
        return { ok: false, code: 'runtime.no-usable-node', reason: '没有可用的 node' };
      },
      sleep: clock.sleep,
      now: clock.now,
    });

    expect(attempts).toBe(1);
    expect(isTransientBootstrapFailure({ code: 'runtime.no-usable-node', reason: 'x' })).toBe(false);
  });

  it('⭐ 预算把 attempt 自身耗时算进去：已经吃穿预算的早退，绝不进第二次尝试', async () => {
    const clock = makeClock();
    let attempts = 0;

    await bootstrapWithRetry<Failure>({
      attempt: async () => {
        attempts += 1;
        clock.advance(31_000); // 单次尝试就超过 30 秒预算（真实场景：等就绪那 180 秒）
        return { ok: false, code: BOOTSTRAP_PROCESS_EXITED, reason: '早退（但很慢）' };
      },
      sleep: clock.sleep,
      now: clock.now,
    });

    // 尝试开始前不知道它要多久 ⇒ 预算只能在进下一次之前判：31 秒已经超了 ⇒ 收手
    expect(attempts).toBe(1);
    expect(clock.sleeps).toEqual([]);
    expect(clock.elapsed()).toBe(31_000);
  });

  it('⭐ 就算喂进来更长的等待表，次数也必须封在 3（次数闸说了算）', async () => {
    const clock = makeClock();
    let attempts = 0;

    await bootstrapWithRetry<Failure>({
      attempt: async () => {
        attempts += 1;
        clock.advance(10);
        return { ok: false, code: BOOTSTRAP_PROCESS_EXITED, reason: '早退' };
      },
      sleep: clock.sleep,
      now: clock.now,
      delaysMs: [1_000, 1_000, 1_000, 1_000, 1_000],
    });

    expect(attempts).toBe(BOOTSTRAP_MAX_ATTEMPTS);
  });

  it('判据只认"子进程早退"这一个码', () => {
    expect(isTransientBootstrapFailure({ code: BOOTSTRAP_PROCESS_EXITED, reason: '任意' })).toBe(true);
    expect(isTransientBootstrapFailure({ code: BOOTSTRAP_READY_TIMEOUT, reason: '任意' })).toBe(false);
    expect(isTransientBootstrapFailure({ code: 'runtime.gateway-port-occupied', reason: '任意' })).toBe(false);
    expect(isTransientBootstrapFailure({ code: undefined, reason: '任意' })).toBe(false);
  });

  it('对照：第一次就成功 ⇒ 只有一次，不等待', async () => {
    const clock = makeClock();
    let attempts = 0;

    const result = await bootstrapWithRetry<Failure>({
      attempt: async () => {
        attempts += 1;
        clock.advance(1_200);
        return { ok: true };
      },
      sleep: clock.sleep,
      now: clock.now,
    });

    expect(attempts).toBe(1);
    expect(clock.sleeps).toEqual([]);
    expect(result.ok).toBe(true);
    expect(clock.elapsed()).toBe(1_200);
  });
});

describe('预算常量', () => {
  it('总预算就是 30 秒（写死在这里，改它必须同时改用例）', () => {
    expect(BOOTSTRAP_TOTAL_BUDGET_MS).toBe(30_000);
  });
});

/**
 * BUG-040 · R2 → 2026-10-15 P-B 便携首启硬合同：**ready-timeout 的有界重试不再只认 `deployed`**。
 *
 * 为什么曾破例（首启）：慢的是解压 35k 个文件 + 首次冷读，实测冷启动能顶到 180 秒窗口
 * 边界 —— 而这一份"再来一次"的代价是**用户少点一次「重新准备」**。
 *
 * 为什么现在连 **skipped（缓存命中）** 也放过（2026-10-15 用户事故 + 交付合同 P-B）：
 *  - 便携态的运行时缓存**随盘走**（`cache-scope.ts`：`<盘根>/…/portable-runtime-cache`），
 *    所以"这块盘在新电脑上第一次启动"在部署层**就是 skipped** —— 内容键/凭据都命中，
 *    与"同一台机器第一百次启动"在既有信号上**不可区分**。仅凭 `deployed` 门控 =
 *    换新机（带预部署缓存）遇 ready 超时时一次都不重试，正落在用户"要手点重新准备"的症状类上。
 *  - 判据换成**失败类本身**：等满 180 秒 = 这台机器/这次环境"真的慢"的直接观测，
 *    与"这份运行时是谁部署的"无关。日志数据里带 `deployStatus`（不伪装成首启）。
 *  - 边界没放松：仍然**只重试一次**、仍只在 `attemptIndex === 0`、仍与瞬态白名单分开计；
 *    最坏墙钟 180s + 3s + 180s ≈ 363s，仍在交付合同 600s 截断之内，且**不重叠**（顺序执行）。
 *  - 其它码一个字不变：端口被占/Node/权限/未知码全部照旧终态。
 */
describe('BUG-040 R2：首启的 ready-timeout 允许一次自动重试', () => {
  it('⭐ 首启（deployStatus=deployed）⇒ 自动再试一次，日志明示该事件', async () => {
    const clock = makeClock();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let attempts = 0;
    const retries: Array<{ attempt: number; delayMs: number }> = [];
    const result = await bootstrapWithRetry<Failure>({
      attempt: async () => {
        attempts += 1;
        clock.advance(180_000);
        return {
          ok: false,
          code: BOOTSTRAP_READY_TIMEOUT,
          reason: '等待网关就绪超时（180s）',
          deployStatus: 'deployed',
        };
      },
      sleep: clock.sleep,
      now: clock.now,
      onRetry: (info) => retries.push({ attempt: info.attempt, delayMs: info.delayMs }),
    });

    expect(attempts).toBe(2);
    expect(clock.sleeps).toEqual([3_000]);
    expect(retries).toEqual([{ attempt: 2, delayMs: 3_000 }]);
    expect(result.ok).toBe(false);
    expect(
      warn.mock.calls.some((call) =>
        call.some((value) => typeof value === 'string' && value.includes('runtime.gateway-ready-timeout-retry')),
      ),
    ).toBe(true);
    warn.mockRestore();
  });

  it('⭐ 首启也只重试一次：第二次仍超时 ⇒ 收手', async () => {
    const clock = makeClock();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let attempts = 0;
    await bootstrapWithRetry<Failure>({
      attempt: async () => {
        attempts += 1;
        clock.advance(180_000);
        return {
          ok: false,
          code: BOOTSTRAP_READY_TIMEOUT,
          reason: '等待网关就绪超时（180s）',
          deployStatus: 'deployed',
        };
      },
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(attempts).toBe(2);
    expect(clock.sleeps).toEqual([3_000]);
    vi.restoreAllMocks();
  });

  /**
   * ⚠️ 期望修订（2026-10-15 P-B 硬合同）：原用例名 = "非首启（缓存命中 skipped）⇒ 一次即终态
   * （行为不变）"，断言 `attempts === 1`。它与"带预部署缓存的盘换新机"直接冲突（见上方
   * describe 注释：缓存随盘走 ⇒ 新机冷启在部署层就是 skipped）。硬合同要求覆盖该场景 ⇒
   * 修订为"一次有界重试；第二次仍超时⇒终态"。旧期望与旧输出留档于
   * `D:/backup/portable-firststart-20261015/p-b/red-baseline-pre-change.log`。
   */
  it('⭐ 缓存命中（skipped）+ ready-timeout ⇒ 有界重试一次；第二次仍超时 ⇒ 收手（P-B 修订）', async () => {
    const clock = makeClock();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let attempts = 0;
    await bootstrapWithRetry<Failure>({
      attempt: async () => {
        attempts += 1;
        clock.advance(180_000);
        return {
          ok: false,
          code: BOOTSTRAP_READY_TIMEOUT,
          reason: '等待网关就绪超时（180s）',
          deployStatus: 'skipped',
        };
      },
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(attempts).toBe(2);
    expect(clock.sleeps).toEqual([3_000]);
    vi.restoreAllMocks();
  });

  it('⭐ 首启标记不改变其它码的既有语义（早退仍是 3 次 / 15 秒那套）', async () => {
    const clock = makeClock();
    let attempts = 0;
    await bootstrapWithRetry<Failure>({
      attempt: async () => {
        attempts += 1;
        clock.advance(500);
        return { ok: false, code: BOOTSTRAP_PROCESS_EXITED, reason: '早退', deployStatus: 'deployed' };
      },
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(attempts).toBe(BOOTSTRAP_MAX_ATTEMPTS);
    expect(clock.sleeps).toEqual([3_000, 12_000]);
  });
});

/**
 * 2026-10-15 P-B 便携首启硬合同：**缓存跨新机冷启动**。
 *
 * 场景（可复现的确定缺口，非事故日志推测）：带预部署缓存（`portable-runtime-cache` 随盘走）
 * 的盘插到新电脑，部署走快路径返回 `skipped`；新机首读（冷读 + 杀软首扫）让网关就绪
 * 顶穿 180 秒窗口 ⇒ 旧策略**一次即终态** ⇒ 落到人工「重新准备」。修复 = ready-timeout
 * 的有界重试资格不再只认 `deployed`（见 bootstrap-retry.ts 的判据），**但仍是一次**。
 */
describe('P-B：缓存命中（skipped）的 ready-timeout 同样有界重试一次', () => {
  it('⭐ 首次超时、第二轮成功 ⇒ 同一次调用内自动恢复（瞬时故障恢复覆盖）', async () => {
    const clock = makeClock();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let attempts = 0;
    const retries: Array<{ attempt: number; delayMs: number }> = [];
    const result = await bootstrapWithRetry<Failure>({
      attempt: async () => {
        attempts += 1;
        clock.advance(attempts === 1 ? 180_000 : 12_000);
        if (attempts === 1) {
          return {
            ok: false,
            code: BOOTSTRAP_READY_TIMEOUT,
            reason: '等待网关就绪超时（180s）',
            deployStatus: 'skipped',
          };
        }
        return { ok: true };
      },
      sleep: clock.sleep,
      now: clock.now,
      onRetry: (info) => retries.push({ attempt: info.attempt, delayMs: info.delayMs }),
    });

    expect(result.ok).toBe(true);
    expect(attempts).toBe(2);
    expect(clock.sleeps).toEqual([3_000]);
    expect(retries).toEqual([{ attempt: 2, delayMs: 3_000 }]);
    vi.restoreAllMocks();
  });

  it('⭐ 控制项：端口被占**即使**带 skipped/deployed 标记也一次即终态（不撞墙）', async () => {
    const clock = makeClock();
    let attempts = 0;
    const result = await bootstrapWithRetry<Failure>({
      attempt: async () => {
        attempts += 1;
        clock.advance(2_000);
        return {
          ok: false,
          code: 'runtime.gateway-port-occupied',
          reason: '端口被另一个网关占用',
          deployStatus: 'skipped',
        };
      },
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(attempts).toBe(1);
    expect(clock.sleeps).toEqual([]);
    expect(result.ok).toBe(false);
  });

  it('⭐ 控制项：ready-timeout 但**没有**部署标记 ⇒ 保守终态（判据不靠猜）', async () => {
    const clock = makeClock();
    let attempts = 0;
    await bootstrapWithRetry<Failure>({
      attempt: async () => {
        attempts += 1;
        clock.advance(180_000);
        return { ok: false, code: BOOTSTRAP_READY_TIMEOUT, reason: '等待网关就绪超时（180s）' };
      },
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(attempts).toBe(1);
    expect(clock.sleeps).toEqual([]);
  });

  it('⭐ 控制项：判定资格是**码 + 部署标记**的合取（纯函数可证伪）', () => {
    expect(isReadyTimeoutWorthRetry({ code: BOOTSTRAP_READY_TIMEOUT, reason: 'x', deployStatus: 'skipped' })).toBe(
      true,
    );
    expect(isReadyTimeoutWorthRetry({ code: BOOTSTRAP_READY_TIMEOUT, reason: 'x', deployStatus: 'deployed' })).toBe(
      true,
    );
    expect(isReadyTimeoutWorthRetry({ code: BOOTSTRAP_PROCESS_EXITED, reason: 'x', deployStatus: 'skipped' })).toBe(
      false,
    );
    expect(isReadyTimeoutWorthRetry({ code: BOOTSTRAP_READY_TIMEOUT, reason: 'x' })).toBe(false);
  });
});
