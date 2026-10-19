import { describe, expect, it, vi } from 'vitest';
import { probeStartupz, settleAfterReadyTimeout, waitForGatewayReady } from '../src/main/runtime/gateway-process.js';
import type { StartupzProbe } from '../src/main/runtime/gateway-process.js';
import { BOOTSTRAP_PROCESS_EXITED, BOOTSTRAP_READY_TIMEOUT } from '../src/main/runtime/bootstrap-retry.js';

/**
 * 探活与等就绪。
 *
 * 就绪判据是**两条**：`GET /startupz` 返回 `{status:'started'}` **且**本 token
 * 认证通过。不用 stdout 的 ready（无契约）、不把 lock 文件当就绪（崩溃残留的 lock
 * 会让装载器等一个死进程）。
 *
 * ⚠️ 第二条是 2026-09-13 实测补上的：网关报 `started` 之后还要几秒才肯完成 WS
 * 握手，这期间认证探测会**挂住**（不是拒绝）。只认 `started` 会让下一轮启动把
 * 我们自己刚起的网关判成 foreign（E2E 启动 2 的精确成因）。
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
  const alwaysAuthed = async (): Promise<boolean> => true;

  it('第一次就 started 且认证通过 ⇒ 立刻返回，一次都不 sleep', async () => {
    const sleep = vi.fn(async () => {});
    const res = await waitForGatewayReady({
      probe: async () => ({ reachable: true, status: 'started' }),
      authenticate: alwaysAuthed,
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
    const res = await waitForGatewayReady({
      probe: async () => seq[i++],
      authenticate: alwaysAuthed,
      sleep,
      hasExited: never,
    });

    expect(res.status).toBe('started');
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('连不上也算"还没好"，继续等（首次启动有解压窗口）', async () => {
    let i = 0;
    const sleep = vi.fn(async () => {});
    const res = await waitForGatewayReady({
      probe: async () => (i++ < 3 ? { reachable: false } : { reachable: true, status: 'started' }),
      authenticate: alwaysAuthed,
      sleep,
      hasExited: never,
    });
    expect(res.status).toBe('started');
  });

  it('⭐ started 但认证还不上 ⇒ **继续等**，认证通过才返回（E2E 启动 2 的精确回归）', async () => {
    // 实测形状：/startupz 早就 started，但网关还要几秒才肯完成 WS 握手，
    // 这期间认证探测挂住 ⇒ false。这段窗口里唯一正确的动作是接着等。
    let authCalls = 0;
    const sleep = vi.fn(async () => {});
    const res = await waitForGatewayReady({
      probe: async () => ({ reachable: true, status: 'started' }),
      authenticate: async () => {
        authCalls++;
        return authCalls >= 3; // 前两次"还没好"
      },
      sleep,
      hasExited: never,
    });

    expect(res.status).toBe('started');
    expect(authCalls).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('⭐ 认证探测自己抛 ⇒ 当成"还没好"继续等，**不**当成失败', async () => {
    let calls = 0;
    const res = await waitForGatewayReady({
      probe: async () => ({ reachable: true, status: 'started' }),
      authenticate: async () => {
        if (++calls < 3) throw new Error('ECONNRESET');
        return true;
      },
      sleep: async () => {},
      hasExited: never,
    });
    expect(res.status).toBe('started');
    expect(calls).toBe(3);
  });

  it('⭐ 始终认证不上 ⇒ 到点抛错，信息里点明是认证没上去（不是"连不上"）', async () => {
    let t = 0;
    const p = waitForGatewayReady({
      probe: async () => ({ reachable: true, status: 'started' }),
      authenticate: async () => false,
      sleep: async (ms) => {
        t += ms;
      },
      hasExited: never,
      now: () => t,
      timeoutMs: 2000,
      intervalMs: 500,
    });
    await expect(p).rejects.toThrow(/认证/);
  });

  it('⭐ 一直 starting ⇒ 到点抛错，信息里说清是超时', async () => {
    let t = 0;
    const p = waitForGatewayReady({
      probe: async () => ({ reachable: true, status: 'starting' }),
      authenticate: alwaysAuthed,
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
      authenticate: alwaysAuthed,
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
    await expect(
      waitForGatewayReady({ probe, authenticate: alwaysAuthed, sleep: async () => {}, hasExited: () => true }),
    ).rejects.toThrow(/退出/);
    expect(probe).not.toHaveBeenCalled();
  });

  it('probe 自己抛异常 ⇒ 当成连不上继续等，不把等待打断', async () => {
    let i = 0;
    const res = await waitForGatewayReady({
      probe: async () => {
        if (i++ < 2) throw new Error('boom');
        return { reachable: true, status: 'started' };
      },
      authenticate: alwaysAuthed,
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
      authenticate: alwaysAuthed,
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

/**
 * 等就绪的两类失败必须**按码**分开 —— bootstrap 的重试策略就靠这个码做白名单。
 *
 * ⚠️ 为什么单列两条：`runtime-bootstrap-retry.test.ts` 用的是**喂进去的**码，
 *    它证明的是"策略对不对"；**没有任何一条证明运行时真的产出这两个码**。
 *    而这一层是真正的接缝：码写错/写反，策略再对也会把"等满 180 秒"当成可重试。
 */
describe('等就绪的两类失败按码分开（策略的白名单依赖它）', () => {
  it('子进程在就绪前退出 ⇒ runtime.gateway-process-exited（**可重试**的那一类）', async () => {
    await expect(
      waitForGatewayReady({
        probe: async () => ({ reachable: false }),
        authenticate: async () => false,
        sleep: async () => {},
        hasExited: () => true,
      }),
    ).rejects.toMatchObject({ code: 'runtime.gateway-process-exited' });

    // 字面量也要钉住：它是跨模块的契约（策略按它做白名单）
    expect(BOOTSTRAP_PROCESS_EXITED).toBe('runtime.gateway-process-exited');
  });

  it('等满 readiness timeout ⇒ runtime.gateway-ready-timeout（⛔ 终态，不许再试）', async () => {
    let clock = 0;
    await expect(
      waitForGatewayReady({
        probe: async () => ({ reachable: false }),
        authenticate: async () => false,
        sleep: async () => {
          clock += 1_000;
        },
        hasExited: () => false,
        intervalMs: 1_000,
        timeoutMs: 3_000,
        now: () => clock,
      }),
    ).rejects.toMatchObject({ code: 'runtime.gateway-ready-timeout' });

    expect(BOOTSTRAP_READY_TIMEOUT).toBe('runtime.gateway-ready-timeout');
  });
});


/**
 * BUG-153（2026-10-18 实机）：就绪**超时之后**的宽限。
 *
 * 现场：网关 180 秒判超时，约 4 秒后自己 ready；自动重试又起一个网关去抢锁/端口，
 * 第二个秒退被当成终态失败。宽限窗口把这两件事都收在本次尝试里。
 */
describe('settleAfterReadyTimeout', () => {
  const fakeClock = (startMs = 0) => {
    let nowMs = startMs;
    return {
      now: () => nowMs,
      sleep: async (ms: number) => {
        nowMs += ms;
      },
    };
  };

  it('⭐ 宽限期内就绪 ⇒ true，且**不**收掉那个网关', async () => {
    let probes = 0;
    const stop = vi.fn(async () => {});
    const clock = fakeClock();
    const recovered = await settleAfterReadyTimeout({
      probe: async () => {
        probes += 1;
        return probes >= 3 ? { reachable: true, status: 'started' } : { reachable: true, status: 'starting' };
      },
      authenticate: async () => true,
      sleep: async (ms) => {
        clock.sleep(ms);
      },
      hasExited: () => false,
      stop,
      graceMs: 5_000,
    });

    expect(recovered).toBe(true);
    expect(stop).not.toHaveBeenCalled();
  });

  it('⭐ 宽限期也没就绪 ⇒ false，并且**先停掉子进程**（不给下一次重试留竞争者）', async () => {
    const stop = vi.fn(async () => {});
    const recovered = await settleAfterReadyTimeout({
      probe: async () => ({ reachable: false }),
      authenticate: async () => false,
      sleep: async () => {},
      hasExited: () => false,
      stop,
      graceMs: 0,
    });

    expect(recovered).toBe(false);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('宽限期内子进程退出 ⇒ false，同样收尾（收尾本身幂等）', async () => {
    const stop = vi.fn(async () => {});
    const recovered = await settleAfterReadyTimeout({
      probe: async () => ({ reachable: false }),
      authenticate: async () => false,
      sleep: async () => {},
      hasExited: () => true,
      stop,
      graceMs: 5_000,
    });

    expect(recovered).toBe(false);
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
