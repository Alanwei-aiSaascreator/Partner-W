/**
 * 给商业层的出站请求补上**中止**（2026-09-17 实机问题的加固②）。
 *
 * ## 问题
 *
 * `auth.ts` 的 docblock 自己写着：「⚠️ 超时**不取消**底层请求，只是不再等它」。
 * 那些调用点（`probeAuth` / `readSessionState` / 目录拉取…）都是
 * `Promise.race([请求, 定时器])` —— 到点我们就走了，**请求还挂在网络上**。
 *
 * 当日实机症状是 17 分钟里 65 次 8 秒超时、`auth.getUser` 与 `licenses.read` **成串爆发**，
 * 形态最像"第一路卡住、后面每个需要会话的调用都排在它后面"。一个被放弃却不取消的请求，
 * 会继续占着连接、fetch 队列，以及（当日最可疑的）会话刷新锁。
 *
 * ## 这一层做什么、不做什么
 *
 * - **做**：请求带上传给 `fetch` 的中止信号；超时后**真的取消**，而不是不再等。
 * - **不做**：不试图修根因。根因至今**未坐实**（当日还有内存严重换页的干扰，见
 *   `commercial-call-timeouts-and-false-exhaustion` 的剂量-反应表），这里只是把
 *   "挂着不放"这件事止住。
 * - **不改健康路径**：正常返回的请求行为完全一样（有测试钉）。
 *
 * ## 上限怎么定
 *
 * 取**明显大于调用方自己的等待上限**（那些地方是 8 秒）：我们**绝不**去切一个
 * 调用方还在等的请求 —— 只在它已经放弃之后，把那条请求收掉。
 * 所以这个值不是"性能取舍"，是"收尸延迟"。
 *
 * ⚠️ 调用方**自带 signal** 时不覆盖，取**并集**（任一触发就中止）：
 *    supabase-js 有自己的取消语义，替它做决定会把它的意图吃掉。
 */

/** 收尸延迟：调用方最长等 8 秒（`auth.ts` 的 `NETWORK_TIMEOUT_MS`），这里给足余量。 */
export const COMMERCIAL_REQUEST_TIMEOUT_MS = 15_000;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * 把两个中止信号并成一个：任一触发，合成信号就中止。
 *
 * ⚠️ 不用 `AbortSignal.any`：那是 Node 20.3+ 才有的，而这里没必要依赖运行时版本 ——
 *    十行手写版在任何 Electron/Node 上都成立，也更好测。
 * ⚠️ 触发后要把监听摘掉，否则长命 signal 上会积监听器（泄漏）。
 */
function anySignal(signals: readonly AbortSignal[]): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const disposers: Array<() => void> = [];

  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    const onAbort = (): void => controller.abort(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    disposers.push(() => signal.removeEventListener('abort', onAbort));
  }

  return {
    signal: controller.signal,
    dispose: () => {
      for (const dispose of disposers) dispose();
    },
  };
}

export interface CreateTimeoutFetchOptions {
  /** 真正发请求的那个 fetch（测试注入；默认全局 `fetch`）。 */
  baseFetch?: FetchLike;
  /** 收尸延迟；默认 {@link COMMERCIAL_REQUEST_TIMEOUT_MS}。 */
  timeoutMs?: number;
}

/**
 * 造一个"会自我了断"的 fetch：超时后**中止**请求，而不是留着它挂在那里。
 *
 * 只动 `init.signal` 这一个字段，其余参数原样透传。
 */
export function createTimeoutFetch(options: CreateTimeoutFetchOptions = {}): FetchLike {
  const baseFetch = options.baseFetch ?? ((input, init) => fetch(input as never, init));
  const timeoutMs = options.timeoutMs ?? COMMERCIAL_REQUEST_TIMEOUT_MS;

  return async (input, init) => {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const callerSignal = init?.signal ?? null;
    // 调用方带了就并集；没带就只用超时信号（原行为是**完全没有信号**）
    const merged = callerSignal ? anySignal([callerSignal, timeoutSignal]) : null;

    try {
      return await baseFetch(input, { ...init, signal: merged ? merged.signal : timeoutSignal });
    } finally {
      merged?.dispose();
    }
  };
}
