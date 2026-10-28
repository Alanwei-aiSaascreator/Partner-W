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

/** 一条被放弃的请求最终怎么了。 */
export interface AbandonedOutcome {
  /** 调用点标签（`auth.getUser` / `licenses.read` …）—— 用来认出是哪一路。 */
  label: string;
  /** 从**发起**到最终落定的毫秒数（含我们已经不等的那段）。 */
  elapsedMs: number;
  /**
   * - `settled`：它其实回来了（后端/网络就是慢）；
   * - `aborted`：直到被中止都没回来（被卡住、或排在某个锁后面）；
   * - `failed`：回来了，但是个错（网络断、服务端拒绝…）。
   */
  outcome: 'settled' | 'aborted' | 'failed';
}

/**
 * 记下"我们不等了之后，那条请求**到底怎么样了**"。
 *
 * ## 为什么单独有这一层
 *
 * 8 秒超时的**根因至今没坐实**。已有的日志只有
 * `[commercial] <label> timed out after 8000ms` —— 它说的是**我们不等了**，
 * 完全没说那条请求本身怎么了。而这正是分出两种根因的关键，两者的修法完全不同：
 *
 * | 放弃之后 | 说明 | 该往哪修 |
 * | --- | --- | --- |
 * | 几秒后**成功**返回 | 后端/网络就是慢 | 调超时、加退避、别在启动高峰打 |
 * | 直到被中止都**没回来** | 请求被卡住/排在锁后面 | 查会话刷新锁、查主进程停摆 |
 *
 * ⚠️ **只观测，不改行为**：不重试、不改超时、不碰调用方的返回值。
 *    它唯一的作用是让**下一次复发**留下能分辨这两种情况的证据。
 * ⚠️ 不 `await` 它，调用方照旧立刻拿到自己的 fallback（观测绝不能拖慢路径）。
 *
 * @param startedAt 请求**发起**的时刻（`Date.now()`），用来算真实总耗时。
 * @param now 取当前时间（测试注入；默认 `Date.now`）。
 */
export function watchAbandoned<T>(
  work: PromiseLike<T>,
  label: string,
  startedAt: number,
  now: () => number = Date.now,
): Promise<AbandonedOutcome> {
  return Promise.resolve(work).then(
    () => ({ label, elapsedMs: Math.max(0, now() - startedAt), outcome: 'settled' as const }),
    (error: unknown) => ({
      label,
      elapsedMs: Math.max(0, now() - startedAt),
      outcome: isAbort(error) ? ('aborted' as const) : ('failed' as const),
    }),
  );
}

/**
 * 中止的两种名字都要认。
 *
 * ⚠️ 我们自己用的是 `AbortSignal.timeout()`，它抛的是 **`TimeoutError`**；
 *    调用方自己 `controller.abort()` 抛的才是 `AbortError`。只认一个就会把
 *    "收尸收掉的"记成"它自己失败了" —— 那正好把要分辨的两件事记反。
 */
function isAbort(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === 'AbortError' || name === 'TimeoutError';
}

/**
 * 把观测写进日志。
 *
 * ⚠️⚠️ **只写标签、耗时、结论三样** —— 一个字的错误原文都不许进。
 *    实机里这些错误的 `message` 会带上**完整私有 URL**（`https://<ref>.supabase.co/…`）、
 *    查询串里的**手机号**、甚至验证码。这条日志是给人看/给客服要的，
 *    不能成为泄漏面（客户端日志本来就是交出去排障的东西）。
 */
export function logAbandoned(outcome: AbandonedOutcome, write: (line: string) => void = console.error): void {
  write(`[commercial] ${outcome.label} we gave up, then: ${outcome.outcome} at ${outcome.elapsedMs}ms`);
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
