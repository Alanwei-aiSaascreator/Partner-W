/**
 * 拉起本机运行时的**有限重试**策略。
 *
 * 为什么需要它：`main/index.ts` 原来只调一次 `bootstrapLocalGatewayRuntime`，
 * 失败就**再也不试**（2026-09-25 真日志：1.8 秒判定端口被占、2.8 秒连接被拒，
 * 之后 290 秒没有任何就绪相关日志）—— 而其中**有一部分失败是暂时的**，
 * 再试一次就好。
 *
 * ⚠️ 但"哪一类值得再试"必须**分得很细**，两类失败长得像、代价却差两个数量级：
 *
 *   | 失败 | 一次尝试要多久 | 该不该再试 |
 *   | --- | --- | --- |
 *   | 子进程**很快退出**（`BOOTSTRAP_PROCESS_EXITED`） | 毫秒~秒 | ✅ 值得：短退避最多 3 次 |
 *   | **等就绪 180 秒超时**（`BOOTSTRAP_READY_TIMEOUT`） | **180 秒** | ⛔ **一次就是终态** |
 *   | 端口被**别人的**网关占用 | 秒 | ⛔ 终态：重试只会重复撞墙；且**绝不许** force/kill 别人的进程 |
 *   | 不认识的码 | 任意 | ⛔ 终态：宁可说"起不来"，也不拿用户的机器赌一个看不懂的失败 |
 *
 * ⭐ 第二条是上一版的洞：预算**只数 `sleep`**，而"等就绪 180 秒"发生在 attempt
 *    **内部**、在预算里是 0 ⇒ 三次尝试最坏可以真等约 **9 分钟**。
 *    现在预算按**真实墙钟**记账（attempt 自己耗掉的时间也算），
 *    并且"180 秒超时"根本不在白名单里 ⇒ 一次即终态。
 */

/** 我们自己的网关**子进程很快就退出了** —— 唯一可重试的一类。 */
export const BOOTSTRAP_PROCESS_EXITED = 'runtime.gateway-process-exited';

/**
 * 等网关就绪**等满了 180 秒**。⛔ **终态**：再来一次就是再让用户等三分钟，
 * 而它已经说明"这个环境里网关起不来"。
 */
export const BOOTSTRAP_READY_TIMEOUT = 'runtime.gateway-ready-timeout';

/** 最多试几次（含第一次）。 */
export const BOOTSTRAP_MAX_ATTEMPTS = 3;

/**
 * 重试的**总预算**（真实墙钟）。
 *
 * ⚠️ 它的准确含义是：**已经花掉的时间 + 下一次等待会超过它 ⇒ 不再发起下一次尝试**。
 *    它**不是**"单次等待的上限"、更**不能中断正在跑的那一次** ——
 *    单次 `waitForGatewayReady` 等多久由**它自己的** `timeoutMs`（180 秒）决定，
 *    外层只能决定"还要不要再发起一次"。把这两件事混为一谈，
 *    就会以为"外层 30 秒能把 180 秒的等待砍掉"—— 那是错的。
 */
export const BOOTSTRAP_TOTAL_BUDGET_MS = 30_000;

/**
 * 两次等待（在第 1、2 次失败之后），合计 15 秒。
 * 给短的：等的是"整个 bootstrap 从头再来一遍"要隔多久，用户才不会看着界面发呆。
 */
const RETRY_DELAYS_MS = [3_000, 12_000] as const;

export interface BootstrapFailureShape {
  code?: string | undefined;
  reason?: string | undefined;
}

/** 只有"子进程早退"值得再试；其余（含 180 秒超时与不认识的码）一律终态。 */
export function isTransientBootstrapFailure(failure: BootstrapFailureShape): boolean {
  return failure.code === BOOTSTRAP_PROCESS_EXITED;
}

export interface BootstrapRetryInput<T extends { ok: boolean } & BootstrapFailureShape> {
  attempt: () => Promise<T>;
  sleep: (ms: number) => Promise<void>;
  /** 真实墙钟（可注入）。缺省 `Date.now`。 */
  now?: () => number;
  onRetry?: (info: { attempt: number; delayMs: number } & BootstrapFailureShape) => void;
  delaysMs?: readonly number[];
  budgetMs?: number;
}

/**
 * 跑 `attempt`，只在**可重试**的失败上退避重试，直到成功、终态、或用完次数/预算。
 *
 * ⚠️ 预算按**真实墙钟**算：`attempt` 自己耗掉的时间（比如等就绪那 180 秒）计入
 *    `spent` —— 否则"三次尝试"可以在用户看来变成九分钟。
 *
 * ⚠️ 但也**别把预算说成"单次等待的上限"**：它管的是"还要不要再发起一次"。
 *    正在跑的那一次尝试由它自己的超时决定（`waitForGatewayReady` 的 180 秒），
 *    外层**没有**中断它的能力。所以一次 180 秒的尝试只能"之后不再发起"，
 *    不能"被 30 秒砍短"。
 *
 * 返回值永远是最后一次尝试的结果（与单次调用形状相同）。
 */
export async function bootstrapWithRetry<T extends { ok: boolean } & BootstrapFailureShape>(
  input: BootstrapRetryInput<T>,
): Promise<T> {
  const delays = input.delaysMs ?? RETRY_DELAYS_MS;
  const budget = input.budgetMs ?? BOOTSTRAP_TOTAL_BUDGET_MS;
  const now = input.now ?? (() => Date.now());
  let spent = 0;

  for (let attemptIndex = 0; ; attemptIndex += 1) {
    const startedAt = now();
    const result = await input.attempt();
    spent += Math.max(0, now() - startedAt);

    if (result.ok) return result;
    if (!isTransientBootstrapFailure(result)) return result;

    const delay = delays[attemptIndex];
    if (delay === undefined) return result;
    if (attemptIndex + 2 > BOOTSTRAP_MAX_ATTEMPTS) return result;
    // ⚠️ 预算按**真实墙钟**判：`spent` 里已经含了这次 attempt 自己耗掉的时间
    //    （比如等就绪那 180 秒）⇒ 它一次就把预算吃穿，不会有第二次。
    //    ⚠️ 别再加第二道"进下一次之前"的同类判断：变异电池实测它与这一句**互相遮蔽**
    //    （删掉也全绿）—— 不可证伪的守卫只是噪音。
    if (spent + delay > budget) return result;

    spent += delay;
    input.onRetry?.({ attempt: attemptIndex + 2, delayMs: delay, code: result.code, reason: result.reason });
    await input.sleep(delay);
  }
}
