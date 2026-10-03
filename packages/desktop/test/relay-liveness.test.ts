import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createRelayBootstrapPublicStateStore,
  createRelayLivenessPublicStateStore,
  type RelayBootstrapPublicPhase,
} from '@clawwork/shared';
import {
  RELAY_LIVENESS_INTERVAL_MS,
  createRelayLivenessMonitor,
  probeRelayReachability,
} from '../src/main/commercial/relay-liveness.js';

/**
 * 探活 monitor —— 判据全在纯逻辑里，用假定时器 + 注入探针驱动。
 * 真探针（`probeRelayReachability`）的判据单独一组，注入 fetch 桩。
 */
function harness(initial: RelayBootstrapPublicPhase = { phase: 'ready' }) {
  const bootstrap = createRelayBootstrapPublicStateStore({ now: () => 1_000 });
  bootstrap.set(initial);
  const state = createRelayLivenessPublicStateStore({ now: () => 1_000 });
  const probe = vi.fn(async () => true);
  const logs: string[] = [];
  const monitor = createRelayLivenessMonitor({
    bootstrap,
    state,
    probe,
    baseUrl: () => 'http://127.0.0.1:8791',
    intervalMs: RELAY_LIVENESS_INTERVAL_MS,
    log: (event) => logs.push(event),
  });
  return { bootstrap, state, probe, logs, monitor };
}

describe('relay 探活 monitor', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('bootstrap 没到 ready ⇒ 不探、状态停在 unknown', async () => {
    const h = harness({ phase: 'idle' });
    h.monitor.start();
    await vi.advanceTimersByTimeAsync(RELAY_LIVENESS_INTERVAL_MS * 3);
    expect(h.probe).not.toHaveBeenCalled();
    expect(h.state.get().phase).toBe('unknown');
    h.monitor.stop();
  });

  it('⭐ ready ⇒ 立刻探一次；两连败才 down；一胜即 up', async () => {
    const h = harness();
    h.probe.mockResolvedValue(false);
    h.monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.probe).toHaveBeenCalledTimes(1);
    expect(h.state.get().phase, '一次失败还不够判死').toBe('unknown');
    await vi.advanceTimersByTimeAsync(RELAY_LIVENESS_INTERVAL_MS);
    expect(h.probe).toHaveBeenCalledTimes(2);
    expect(h.state.get().phase).toBe('down');
    h.probe.mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(RELAY_LIVENESS_INTERVAL_MS);
    expect(h.state.get().phase, '一次成功就恢复').toBe('up');
    h.monitor.stop();
  });

  it('⭐ 抖动（一败一胜）判不出 down', async () => {
    const h = harness();
    h.probe.mockResolvedValueOnce(false).mockResolvedValue(true);
    h.monitor.start();
    await vi.advanceTimersByTimeAsync(RELAY_LIVENESS_INTERVAL_MS * 2);
    expect(h.state.get().phase).toBe('up');
    h.monitor.stop();
  });

  it('探针抛错按失败算（不许炸 monitor）', async () => {
    const h = harness();
    h.probe.mockRejectedValue(new Error('boom'));
    h.monitor.start();
    await vi.advanceTimersByTimeAsync(RELAY_LIVENESS_INTERVAL_MS);
    expect(h.state.get().phase).toBe('down');
    expect(h.logs).toContain('relay.liveness.probe-failed');
    h.monitor.stop();
  });

  it('⭐ 离开 ready ⇒ 回 unknown 且停探；再回 ready 恢复探', async () => {
    const h = harness();
    h.monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    h.bootstrap.set({ phase: 'retryable-error', errorCode: 'transport' });
    expect(h.state.get().phase).toBe('unknown');
    const calls = h.probe.mock.calls.length;
    await vi.advanceTimersByTimeAsync(RELAY_LIVENESS_INTERVAL_MS * 3);
    expect(h.probe).toHaveBeenCalledTimes(calls);
    h.bootstrap.set({ phase: 'ready' });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.probe).toHaveBeenCalledTimes(calls + 1);
    h.monitor.stop();
  });

  it('stop() 之后不再探、不再发', async () => {
    const h = harness();
    h.probe.mockResolvedValue(false);
    h.monitor.start();
    await vi.advanceTimersByTimeAsync(RELAY_LIVENESS_INTERVAL_MS);
    h.monitor.stop();
    const snapshot = JSON.stringify(h.state.get());
    await vi.advanceTimersByTimeAsync(RELAY_LIVENESS_INTERVAL_MS * 5);
    expect(JSON.stringify(h.state.get())).toBe(snapshot);
    h.monitor.stop();
  });

  it('probeNow() 立刻探（[立即重试] 的通道）', async () => {
    const h = harness();
    h.monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    const calls = h.probe.mock.calls.length;
    await h.monitor.probeNow();
    expect(h.probe.mock.calls.length).toBe(calls + 1);
    h.monitor.stop();
  });
});

describe('probeRelayReachability 判据', () => {
  const baseUrl = 'http://127.0.0.1:8791';
  it.each([
    [200, true],
    [401, true],
    [404, true],
    [500, false],
    [502, false],
    [503, false],
  ])('HTTP %i ⇒ %s（2xx/4xx=活；5xx=断）', async (status, expected) => {
    const fetchImpl = vi.fn(async () => ({ status }) as Response);
    expect(await probeRelayReachability(baseUrl, { fetchImpl, timeoutMs: 10 })).toBe(expected);
  });

  it('网络错误 / 超时 ⇒ 断', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(await probeRelayReachability(baseUrl, { fetchImpl, timeoutMs: 10 })).toBe(false);
  });

  it('探的是 /v1/catalog、目标就是传入的 baseUrl（末尾斜杠归一）', async () => {
    const fetchImpl = vi.fn(async (_input: unknown, _init?: unknown) => ({ status: 401 }) as Response);
    await probeRelayReachability(`${baseUrl}/`, { fetchImpl, timeoutMs: 10 });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(`${baseUrl}/v1/catalog`);
  });
});
