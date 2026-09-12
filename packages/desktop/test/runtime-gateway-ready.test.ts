import { describe, expect, it, vi } from 'vitest';
import { probeStartupz, waitForGatewayReady } from '../src/main/runtime/gateway-process.js';
import type { StartupzProbe } from '../src/main/runtime/gateway-process.js';

/**
 * 探活与等就绪。
 *
 * 就绪判据**只有** `GET /startupz` 返回 `{status:'started'}`——
 * 不用 stdout 的 ready（无契约）、不把 lock 文件当就绪（崩溃残留的 lock 会让装载器
 * 等一个死进程）。这里把这两条边界钉死。
 */

const PORT = 18789;

function fakeFetch(response: { ok?: boolean; body?: unknown; throws?: Error }) {
  return vi.fn(async (url: string) => {
    if (response.throws) throw response.throws;
    return {
      ok: response.ok ?? true,
      json: async () => {
        if (response.body === undefined) throw new SyntaxError('Unexpected token');
        return response.body;
      },
      _url: url,
    };
  });
}

describe('probeStartupz', () => {
  it('started ⇒ {reachable:true, status:started}', async () => {
    const res = await probeStartupz({ port: PORT, fetchImpl: fakeFetch({ body: { status: 'started' } }) as never });
    expect(res).toEqual({ reachable: true, status: 'started' });
  });

  it('starting ⇒ 原样带出来（交给上层判断"还没好"）', async () => {
    const res = await probeStartupz({ port: PORT, fetchImpl: fakeFetch({ body: { status: 'starting' } }) as never });
    expect(res).toEqual({ reachable: true, status: 'starting' });
  });

  it('⭐ ECONNREFUSED ⇒ {reachable:false}，**不抛**（"还没起"是正常状态）', async () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:18789'), { code: 'ECONNREFUSED' });
    const res = await probeStartupz({ port: PORT, fetchImpl: fakeFetch({ throws: refused }) as never });
    expect(res).toEqual({ reachable: false });
  });

  it('⭐ 超时 ⇒ 也当连不上（AbortSignal 抛的是 AbortError）', async () => {
    const abort = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    const res = await probeStartupz({ port: PORT, fetchImpl: fakeFetch({ throws: abort }) as never });
    expect(res).toEqual({ reachable: false });
  });

  it('⭐ 答了 HTTP 但不是我们的（404）⇒ reachable:true、status 未知（端口确实被占）', async () => {
    const res = await probeStartupz({ port: PORT, fetchImpl: fakeFetch({ ok: false }) as never });
    expect(res).toEqual({ reachable: true });
  });

  it('答了 200 但 body 不是 JSON ⇒ 同上（有人，但不像我们的网关）', async () => {
    const res = await probeStartupz({ port: PORT, fetchImpl: fakeFetch({ body: undefined }) as never });
    expect(res).toEqual({ reachable: true });
  });

  it('探的是 127.0.0.1 上的 /startupz（不是 0.0.0.0、不发到外网）', async () => {
    const f = fakeFetch({ body: { status: 'started' } });
    await probeStartupz({ port: PORT, fetchImpl: f as never });
    expect(f.mock.calls[0][0]).toBe(`http://127.0.0.1:${PORT}/startupz`);
  });
});

describe('waitForGatewayReady', () => {
  const never = (): boolean => false;

  it('第一次就 started ⇒ 立刻返回，一次都不 sleep', async () => {
    const sleep = vi.fn(async () => {});
    const res = await waitForGatewayReady({
      probe: async () => ({ reachable: true, status: 'started' }),
      sleep,
      hasExited: never,
    });
    expect(res).toEqual({ status: 'started' });
    expect(sleep).not.toHaveBeenCalled();
  });

  it('starting → starting → started ⇒ 继续轮询直到 started', async () => {
    const seq: StartupzProbe[] = [
      { reachable: true, status: 'starting' },
      { reachable: true, status: 'starting' },
      { reachable: true, status: 'started' },
    ];
    let i = 0;
    const sleep = vi.fn(async () => {});
    const res = await waitForGatewayReady({ probe: async () => seq[i++], sleep, hasExited: never });

    expect(res.status).toBe('started');
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('连不上也算"还没好"，继续等（首次启动有解压窗口）', async () => {
    let i = 0;
    const sleep = vi.fn(async () => {});
    const res = await waitForGatewayReady({
      probe: async () => (i++ < 3 ? { reachable: false } : { reachable: true, status: 'started' }),
      sleep,
      hasExited: never,
    });
    expect(res.status).toBe('started');
  });

  it('⭐ 一直 starting ⇒ 到点抛错，信息里说清是超时', async () => {
    let t = 0;
    const p = waitForGatewayReady({
      probe: async () => ({ reachable: true, status: 'starting' }),
      sleep: async (ms) => {
        t += ms;
      },
      hasExited: never,
      now: () => t,
      timeoutMs: 2000,
      intervalMs: 500,
    });
    await expect(p).rejects.toThrow(/超时/);
  });

  it('⭐ 子进程退出 ⇒ **立即**中止，不等满超时', async () => {
    let exited = false;
    let probes = 0;
    const p = waitForGatewayReady({
      probe: async () => {
        probes++;
        return { reachable: false };
      },
      sleep: async () => {
        exited = true;
      },
      hasExited: () => exited,
      now: () => 0, // 时钟不前进 ⇒ 永远不会因超时而结束
      timeoutMs: 999_999,
    });

    await expect(p).rejects.toThrow(/退出/);
    // 关键断言：没有一直转到超时（否则就是"转 180s 再报一个含糊的超时"）
    expect(probes).toBeLessThanOrEqual(2);
  });

  it('一开始就发现子进程已退出 ⇒ 立刻抛（不做无谓探测）', async () => {
    const probe = vi.fn(async () => ({ reachable: true, status: 'started' }));
    await expect(waitForGatewayReady({ probe, sleep: async () => {}, hasExited: () => true })).rejects.toThrow(/退出/);
    expect(probe).not.toHaveBeenCalled();
  });

  it('probe 自己抛异常 ⇒ 当成连不上继续等，不把等待打断', async () => {
    let i = 0;
    const res = await waitForGatewayReady({
      probe: async () => {
        if (i++ < 2) throw new Error('boom');
        return { reachable: true, status: 'started' };
      },
      sleep: async () => {},
      hasExited: never,
    });
    expect(res.status).toBe('started');
  });

  it('默认间隔 500ms、总超时 180s（首次启动要留够冷启动 + 解压窗口）', async () => {
    let t = 0;
    const sleeps: number[] = [];
    const p = waitForGatewayReady({
      probe: async () => ({ reachable: false }),
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
      hasExited: never,
      now: () => t,
    });
    await expect(p).rejects.toThrow();
    expect(sleeps[0]).toBe(500);
    expect(t).toBeGreaterThanOrEqual(180_000);
  });
});
