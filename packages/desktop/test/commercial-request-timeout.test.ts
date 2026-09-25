import { describe, expect, it, vi } from 'vitest';
import { createTimeoutFetch, logAbandoned, watchAbandoned } from '../src/main/commercial/request-timeout.js';

/**
 * 商业调用的**请求中止**（2026-09-17 实机问题的加固②）。
 *
 * ## 为什么要有它
 *
 * 那天的症状是"商业 Supabase 调用成串 8 秒超时"（17 分钟里 65 次，`auth.getUser` 40 +
 * `licenses.read` 25，**成串爆发**）。当时的结论里有一条一直没做：
 *
 * > 给底层请求加**中止** —— 现在 8 秒只是不再等，**请求还挂着**，后续继续排队。
 *
 * `auth.ts` 的 docblock 自己就写着「⚠️ 超时**不取消**底层请求，只是不再等它」。
 * 一个**被放弃却不取消**的请求是实打实的资源泄漏：连接、fetch 队列、
 * 以及（当日最可疑的）会话刷新锁都会继续被它占着。
 *
 * ## 这一层**不改**任何健康路径的行为
 *
 * 它只做一件事：**给我们已经放弃等待的那些请求补上一个中止**。
 * 正常返回的请求完全不受影响（下面有断言）。**它不试图修那个根因**
 *（根因至今未坐实，当日还有内存换页的强烈干扰）；它只是把"挂着不放"这件事止住。
 */
describe('商业请求的中止', () => {
  /** 一个"永远不返回"的 fetch：只有被中止时才会 reject。 */
  function hangingFetch(): {
    fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
    observed: AbortSignal[];
  } {
    const observed: AbortSignal[] = [];
    return {
      observed,
      fetch: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal ?? null;
          if (!signal) return; // 没有信号 ⇒ 永远挂着，正是我们要防的形态
          observed.push(signal);
          // ⚠️ 桩必须**忠实**：真实 fetch 拿到**已经中止**的 signal 会立刻 reject。
          //    只挂 `addEventListener` 的话，已中止信号上的监听**永远不会触发**
          //    ⇒ 桩会一直挂着（我第一版就写成这样，跑出 35 秒超时）。
          if (signal.aborted) {
            reject(new Error('aborted'));
            return;
          }
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    };
  }

  it('⭐ 没有上限的请求会被中止（而不是挂着不放）', async () => {
    const base = hangingFetch();
    const guarded = createTimeoutFetch({ baseFetch: base.fetch as never, timeoutMs: 30 });

    await expect(guarded('https://example.test/x')).rejects.toThrow();
    expect(base.observed, '必须真的把信号传下去').toHaveLength(1);
    expect(base.observed[0].aborted, '超时之后该请求必须已被中止').toBe(true);
  });

  it('正常返回的请求**完全不受影响**（健康路径零行为改变）', async () => {
    const base = vi.fn(async () => new Response('ok', { status: 200 }));
    const guarded = createTimeoutFetch({ baseFetch: base as never, timeoutMs: 30 });

    const response = await guarded('https://example.test/x');

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('ok');
  });

  it('快请求不会被超时误伤（不是"到点就杀"）', async () => {
    const base = vi.fn(
      (_input: unknown, _init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          // 比 timeoutMs 快得多
          setTimeout(() => resolve(new Response('quick', { status: 200 })), 1);
        }),
    );
    const guarded = createTimeoutFetch({ baseFetch: base as never, timeoutMs: 200 });

    await expect(guarded('https://example.test/x')).resolves.toBeInstanceOf(Response);
  });

  /**
   * ⚠️ 调用方**自己带了 signal** 时不能把它丢掉：supabase-js 有自己的取消语义，
   *    覆盖掉等于替它做决定。两个信号是**并集**（任一触发就中止）。
   */
  it('⭐ 调用方自己的 signal 必须保留：任一触发都要中止', async () => {
    const base = hangingFetch();
    const guarded = createTimeoutFetch({ baseFetch: base.fetch as never, timeoutMs: 10_000 });

    const caller = new AbortController();
    const startedAt = Date.now();
    const pending = guarded('https://example.test/x', { signal: caller.signal });
    caller.abort();

    await expect(pending).rejects.toThrow();
    expect(base.observed[0].aborted, '调用方中止了，请求就得中止').toBe(true);
    // ⚠️ **必须断言"及时"**：只写 `rejects.toThrow()` 是不够的 ——
    //    丢掉调用方的 signal 之后，这个 promise 会在 timeoutMs（这里是 10 秒）到点时
    //    同样 reject，用例照样绿。我第一版就是这么写的，变异验证把它抓出来了
    //    （`merged = null` 那个变异**活了下来**）。
    expect(Date.now() - startedAt, '应当是调用方中止的，而不是等到超时').toBeLessThan(1000);
  });

  it('已经中止的 signal 传进来 ⇒ 不会卡住', async () => {
    const base = hangingFetch();
    const guarded = createTimeoutFetch({ baseFetch: base.fetch as never, timeoutMs: 10_000 });
    const caller = new AbortController();
    caller.abort();

    await expect(guarded('https://example.test/x', { signal: caller.signal })).rejects.toThrow();
  });

  it('非请求参数原样透传（url / method / headers 不能被改写）', async () => {
    const base = vi.fn(async (_input: unknown, _init?: RequestInit) => new Response(null, { status: 204 }));
    const guarded = createTimeoutFetch({ baseFetch: base as never, timeoutMs: 1000 });

    await guarded('https://example.test/y', { method: 'POST', headers: { 'x-a': 'b' } });

    const [input, init] = base.mock.calls[0] as [unknown, RequestInit];
    expect(String(input)).toBe('https://example.test/y');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'x-a': 'b' });
  });
});

/**
 * ⭐⭐ 「我们不等了之后，那条请求**到底怎么样了**」——观测，不是修（2026-09-26）。
 *
 * ## 为什么还缺这一层
 *
 * 8 秒超时的**根因至今没坐实**。已有的证据只到"成串爆发、与内存换页同步、
 * 裸 fetch 很快"（见 `commercial-call-timeouts-and-false-exhaustion`），
 * 而每次复发我们能拿到的日志只有一句
 * `[commercial] <label> timed out after 8000ms` —— 它说的是**我们不等了**，
 * 完全没说那条请求本身怎么了。
 *
 * 这一点恰恰是分出两种根因的关键，而两种根因的修法**完全不同**：
 *
 * | 放弃之后 | 说明 | 该往哪修 |
 * | --- | --- | --- |
 * | 几秒后**成功**返回 | 后端/网络就是慢 | 调超时、加退避、别在启动高峰打 |
 * | 直到被中止（15s）都**没回来** | 请求被卡住/排在锁后面 | 查会话刷新锁、查主进程停摆 |
 *
 * ⚠️ 这一层**只记日志、不改行为**：它不重试、不改超时、不碰返回值。
 *    它唯一的作用是让**下一次复发**留下能分辨这两种情况的证据。
 */
describe('放弃之后的观测（只记日志，不改行为）', () => {
  const t0 = 1_000_000;

  it('⭐ 慢但最终回来 ⇒ 记下"它其实回了"以及真实耗时', async () => {
    let resolveWork: (value: string) => void = () => {};
    const work = new Promise<string>((resolve) => {
      resolveWork = resolve;
    });

    const watching = watchAbandoned(work, 'auth.getUser', t0, () => t0 + 9_400);
    resolveWork('ok');

    expect(await watching).toEqual({ label: 'auth.getUser', elapsedMs: 9_400, outcome: 'settled' });
  });

  it('⭐⭐ 被中止收掉 ⇒ 记成 aborted —— 那才是"它真的卡住了"的证据', async () => {
    const abortError = new Error('This operation was aborted');
    abortError.name = 'AbortError';
    const work = Promise.reject(abortError);
    work.catch(() => {}); // 观测者之外没人接它

    expect(await watchAbandoned(work, 'licenses.read', t0, () => t0 + 15_000)).toEqual({
      label: 'licenses.read',
      elapsedMs: 15_000,
      outcome: 'aborted',
    });
  });

  it('⭐ 对照：`AbortSignal.timeout()` 那种超时也叫 aborted（名字是 TimeoutError）', async () => {
    const timeoutError = new Error('The operation was aborted due to timeout');
    timeoutError.name = 'TimeoutError';

    expect(await watchAbandoned(Promise.reject(timeoutError), 'x', t0, () => t0 + 1)).toMatchObject({
      outcome: 'aborted',
    });
  });

  it('对照：不是中止的失败 ⇒ 记成 failed（不能和"被中止"混为一谈）', async () => {
    const work = Promise.reject(new Error('network down'));
    work.catch(() => {});

    expect(await watchAbandoned(work, 'x', t0, () => t0 + 2_000)).toMatchObject({ outcome: 'failed' });
  });

  it('⭐⭐ 日志里只有标签、耗时、结论 —— 错误原文（可能带手机号/完整 URL）一个字都不许进', async () => {
    // 造一个"原文很脏"的错误：真实世界里这里会出现完整 URL、手机号、甚至验证码。
    const dirty = new Error('POST https://abc.supabase.co/auth/v1/verify?phone=%2B8613800138000 failed code=123456');
    const work = Promise.reject(dirty);
    work.catch(() => {});
    const lines: string[] = [];

    logAbandoned(await watchAbandoned(work, 'otp.verify', t0, () => t0 + 8_100), (line) => lines.push(line));

    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line, '标签要在（否则不知道是哪一路）').toContain('otp.verify');
    expect(line, '耗时要在').toContain('8100');
    expect(line, '结论要在').toContain('failed');
    expect(line, '⚠️ 完整 URL 不许进日志').not.toContain('supabase.co');
    expect(line, '⚠️ 手机号不许进日志').not.toContain('8613800138000');
    expect(line, '⚠️ 验证码不许进日志').not.toContain('123456');
  });
});
