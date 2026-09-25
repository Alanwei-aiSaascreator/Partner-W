/**
 * 拉起本机运行时的**有限重试**策略。
 *
 * 为什么需要它：`main/index.ts` 原来只调一次 `bootstrapLocalGatewayRuntime`，
 * 失败就**再也不试**（2026-09-25 真日志：1.8 秒判定端口被占、2.8 秒连接被拒，
 * 之后 290 秒没有任何就绪相关日志）—— 而其中**有一部分失败是暂时的**
 * （网关进程还没冷启动完、端口还没监听），再试一次就好。
 *
 * ⚠️ 但**不是所有失败都值得再试**，判据必须是**白名单**：
 *   - `runtime.gateway-port-occupied`（端口被**别人的**网关占用）是**终态**：
 *     马上重试只会重复撞同一堵墙，而且**绝不许**去 force/kill 别人的进程
 *     （见 `gateway-process.ts` 的 AI/foreign 判定）；
 *   - 不认识的失败码一律**当作终态**：宁可让界面说"起不来"，也不要拿用户的机器
 *     去赌一个我们看不懂的失败。
 */

/** 唯一可重试的失败：**我们自己的**网关还没就绪（进程没起来 / 端口还没监听）。 */
export const BOOTSTRAP_NOT_READY = 'runtime.gateway-not-ready';

/** 最多试几次（含第一次）。 */
export const BOOTSTRAP_MAX_ATTEMPTS = 3;

/** 重试等待的**总预算**：三次加起来也不许超过它。 */
export const BOOTSTRAP_TOTAL_BUDGET_MS = 30_000;

/**
 * 两次等待（在第 1、2 次失败之后）。合计 15 秒 —— 网关冷启动约 38 秒，
 * 但那是**里面那个 180 秒的等待**在扛（见 `gateway-process.ts`）；
 * 这里等的是"整个 bootstrap 从头再来一遍"要隔多久，给短一点，
 * 用户才不会看着界面发呆三十秒。
 */
const RETRY_DELAYS_MS = [3_000, 12_000] as const;

export interface BootstrapFailureShape {
  code?: string | undefined;
  reason?: string | undefined;
}

/** 只有"我们自己的网关还没就绪"值得再试；其余（含不认识的码）一律终态。 */
export function isTransientBootstrapFailure(failure: BootstrapFailureShape): boolean {
  return failure.code === BOOTSTRAP_NOT_READY;
}

export interface BootstrapRetryInput<T extends { ok: boolean } & BootstrapFailureShape> {
  attempt: () => Promise<T>;
  sleep: (ms: number) => Promise<void>;
  onRetry?: (info: { attempt: number; delayMs: number } & BootstrapFailureShape) => void;
  delaysMs?: readonly number[];
  budgetMs?: number;
}

/**
 * 跑 `attempt`，只在**可重试**的失败上退避重试，直到成功、终态、或用完次数/预算。
 * 返回值永远是最后一次尝试的结果（与单次调用形状相同）。
 */
export async function bootstrapWithRetry<T extends { ok: boolean } & BootstrapFailureShape>(
  input: BootstrapRetryInput<T>,
): Promise<T> {
  const delays = input.delaysMs ?? RETRY_DELAYS_MS;
  const budget = input.budgetMs ?? BOOTSTRAP_TOTAL_BUDGET_MS;
  let spent = 0;

  for (let attemptIndex = 0; ; attemptIndex += 1) {
    const result = await input.attempt();
    if (result.ok) return result;
    if (!isTransientBootstrapFailure(result)) return result;

    const delay = delays[attemptIndex];
    if (delay === undefined) return result;
    if (attemptIndex + 2 > BOOTSTRAP_MAX_ATTEMPTS) return result;
    if (spent + delay > budget) return result;

    spent += delay;
    input.onRetry?.({ attempt: attemptIndex + 2, delayMs: delay, code: result.code, reason: result.reason });
    await input.sleep(delay);
  }
}
