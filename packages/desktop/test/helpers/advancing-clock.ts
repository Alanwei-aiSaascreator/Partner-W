import { vi } from 'vitest';

/**
 * 注入给 `bootstrapRelayWithRetry` 的**前进时钟**：时间随 sleep 一起走。
 *
 * ⚠️ 别用冻结时钟（`now: () => 0`）+ 空 sleep 那种写法：那让总 deadline **永远
 *    够不到** —— 一旦哪条分支落进 `runtime-not-ready` 轮询，测试就变成真的死循环
 *    （写 `relay-startup.test.ts` 第一版时把 worker 跑到了 OOM），而且它还让
 *    "4 分钟窗口"根本没被跑到。
 *
 * ⚠️ 反过来也不能让 sleep 真的等：`AUTH_RETRY_BACKOFF_MS` 合计 172 秒。
 *
 * 用法：`bootstrapRelayWithRetry(deps, { ...advancingClock(), waitForGatewayMs: 240_000 })`
 * — 断言"退避了几次/退避了多少"用返回的 `sleep` spy。
 */
export function advancingClock(startMs = 0) {
  let t = startMs;
  return {
    now: () => t,
    sleep: vi.fn(async (ms: number) => {
      t += ms;
    }),
  };
}
