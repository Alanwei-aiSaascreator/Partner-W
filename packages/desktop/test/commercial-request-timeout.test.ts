import { describe, expect, it, vi } from 'vitest';
import { createTimeoutFetch } from '../src/main/commercial/request-timeout.js';

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
