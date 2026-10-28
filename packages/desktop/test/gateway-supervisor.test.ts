import { describe, expect, it, vi } from 'vitest';
import { createGatewaySupervisor } from '../src/main/runtime/gateway-supervisor.js';

/**
 * 网关监督者（2026-10-18 实机：接飞书后网关永久断开）。
 *
 * 内核 external 模式的"重启" = **自己退出、等外部拉起**；桌面端此前只清引用不重启
 * ⇒ WS 在死端口上按退避无限重连。这一组钉住监督语义：退避、成功清零、熔断停手、
 * 退出时取消。
 */
function harness(results: Array<{ ok: boolean; code?: string }> = [{ ok: true }], over: { maxAttempts?: number } = {}) {
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  const bootstrap = vi.fn(async () => results.shift() ?? { ok: true });
  const respawns: Array<[number, number]> = [];
  const giveUps: string[] = [];
  const supervisor = createGatewaySupervisor({
    bootstrap,
    schedule: (fn, ms) => {
      const timer = { fn, ms, cancelled: false };
      timers.push(timer);
      return timer;
    },
    cancel: (handle) => {
      (handle as { cancelled: boolean }).cancelled = true;
    },
    onRespawn: (attempt, delayMs) => respawns.push([attempt, delayMs]),
    onGiveUp: (reason) => giveUps.push(reason),
    delaysMs: [100, 200],
    ...over,
  });
  const runNext = async () => {
    const timer = timers.shift();
    if (!timer || timer.cancelled) return;
    timer.fn();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { supervisor, bootstrap, timers, respawns, giveUps, runNext };
}

describe('gateway-supervisor', () => {
  it('⭐ 网关退出 ⇒ 按第一档退避排一次重启', async () => {
    const h = harness();
    h.supervisor.onGatewayExit();

    expect(h.respawns).toEqual([[1, 100]]);
    expect(h.bootstrap).not.toHaveBeenCalled();

    await h.runNext();
    expect(h.bootstrap).toHaveBeenCalledTimes(1);
  });

  it('⭐ 重启成功 ⇒ 连续计数清零（下一次退出仍从第一档开始）', async () => {
    const h = harness([{ ok: true }, { ok: true }]);
    h.supervisor.onGatewayExit();
    await h.runNext();
    expect(h.supervisor.attempts()).toBe(0);

    h.supervisor.onGatewayExit();
    expect(h.respawns.at(-1)).toEqual([1, 100]);
  });

  it('重启失败 ⇒ 继续按下一档退避重试', async () => {
    const h = harness([{ ok: false, code: 'runtime.gateway-ready-timeout' }, { ok: true }]);
    h.supervisor.onGatewayExit();
    await h.runNext();
    expect(h.respawns).toEqual([
      [1, 100],
      [2, 200],
    ]);

    await h.runNext();
    expect(h.bootstrap).toHaveBeenCalledTimes(2);
    expect(h.supervisor.attempts()).toBe(0);
  });

  it('⭐ 撞上内核 crash-loop 熔断 ⇒ 立刻停手（继续撞只会延长窗口）', async () => {
    const h = harness([{ ok: false, code: 'gateway-crash-loop-breaker' }]);
    h.supervisor.onGatewayExit();
    await h.runNext();

    expect(h.giveUps).toEqual(['crash-loop-breaker']);
    expect(h.respawns).toHaveLength(1);
  });

  it('次数用尽 ⇒ 放弃（不留无限定时器）', async () => {
    const h = harness(
      [
        { ok: false, code: 'x' },
        { ok: false, code: 'x' },
      ],
      { maxAttempts: 2 },
    );
    h.supervisor.onGatewayExit();
    await h.runNext();
    await h.runNext();

    expect(h.giveUps).toEqual(['max-attempts']);
    expect(h.respawns).toHaveLength(2);
  });

  it('⭐ stop() ⇒ 取消未执行的定时器，之后不再重拉（应用退出的纪律）', async () => {
    const h = harness();
    h.supervisor.onGatewayExit();
    h.supervisor.stop();

    expect(h.timers[0]?.cancelled).toBe(true);
    await h.runNext();
    expect(h.bootstrap).not.toHaveBeenCalled();

    h.supervisor.onGatewayExit();
    expect(h.respawns).toHaveLength(1);
  });

  it('重复调用 onGatewayExit（同一退避窗口内）只排一次', () => {
    const h = harness();
    h.supervisor.onGatewayExit();
    h.supervisor.onGatewayExit();
    h.supervisor.onGatewayExit();
    expect(h.respawns).toHaveLength(1);
  });

  it('⭐ reset() ⇒ 主动重启后可再次监督（否则 restart 会永久废掉监督者）', async () => {
    const h = harness([{ ok: true }, { ok: true }]);
    h.supervisor.onGatewayExit();
    h.supervisor.stop();
    // 停用后：退出不再重拉（应用退出语义）
    h.supervisor.onGatewayExit();
    expect(h.respawns).toHaveLength(1);

    // 主动重启（restartLocalGatewayRuntime 会先 stop 再 reset）
    h.supervisor.reset();
    expect(h.supervisor.attempts()).toBe(0);
    h.supervisor.onGatewayExit();
    expect(h.respawns).toHaveLength(2);
    expect(h.respawns.at(-1)).toEqual([1, 100]);
  });

  it('reset() 会取消 stop 之前尚未执行的定时器（不重复拉起）', () => {
    const h = harness();
    h.supervisor.onGatewayExit();
    h.supervisor.stop();
    h.supervisor.reset();
    expect(h.timers[0]?.cancelled).toBe(true);
  });
});
