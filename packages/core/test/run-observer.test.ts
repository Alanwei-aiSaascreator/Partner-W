import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GatewayEvent, GatewayStatusEvent } from '../src/ports/gateway-transport.js';
import { observeChatRun } from '../src/services/run-observer.js';

function fixture(signal?: AbortSignal) {
  let event: (value: GatewayEvent) => void = () => {};
  let status: (value: GatewayStatusEvent) => void = () => {};
  const removeEvent = vi.fn();
  const removeStatus = vi.fn();
  const observer = observeChatRun({
    gatewayId: 'gateway',
    sessionKey: 'session',
    signal,
    timeoutMs: 1000,
    gateway: {
      onGatewayEvent: (callback) => {
        event = callback;
        return removeEvent;
      },
      onGatewayStatus: (callback) => {
        status = callback;
        return removeStatus;
      },
    },
  });
  const emit = (payload: Record<string, unknown>, gatewayId = 'gateway') =>
    event({ gatewayId, event: 'chat', payload: { sessionKey: 'session', runId: 'accepted', ...payload } });
  return { observer, emit, status, removeEvent, removeStatus };
}

describe('accepted chat run observation', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('buffers a fast terminal before the send acknowledgement', async () => {
    const h = fixture();
    h.emit({ state: 'final' });
    h.observer.bind({ sessionKey: 'session', runId: 'accepted' });
    expect(await h.observer.terminal).toEqual({ kind: 'final', runId: 'accepted' });
    expect(h.removeEvent).toHaveBeenCalledTimes(1);
    expect(h.removeStatus).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not settle from another gateway, session, run or yielded final', async () => {
    const h = fixture();
    let settled = false;
    void h.observer.terminal.then(() => {
      settled = true;
    });
    h.observer.bind({ sessionKey: 'session', runId: 'accepted' });
    h.emit({ state: 'final' }, 'other-gateway');
    h.emit({ state: 'final', sessionKey: 'other-session' });
    h.emit({ state: 'final', runId: 'old', text: 'same answer' });
    h.emit({ state: 'final', yielded: true, text: 'same answer' });
    h.emit({ state: 'delta', text: 'same answer' });
    await Promise.resolve();
    expect(settled).toBe(false);
    h.emit({ state: 'final', text: 'same answer' });
    expect(await h.observer.terminal).toEqual({ kind: 'final', runId: 'accepted' });
  });

  it.each(['error', 'aborted'] as const)('keeps %s distinct from completion', async (kind) => {
    const h = fixture();
    h.observer.bind({ sessionKey: 'session', runId: 'accepted' });
    h.emit({ state: kind });
    h.emit({ state: 'final' });
    expect(await h.observer.terminal).toEqual({ kind, runId: 'accepted' });
  });

  it('does not treat a truncated reply as a complete result', async () => {
    const h = fixture();
    h.observer.bind({ sessionKey: 'session', runId: 'accepted' });
    h.emit({ state: 'final', stopReason: 'length' });
    expect(await h.observer.terminal).toEqual({ kind: 'unconfirmed', reason: 'truncated', runId: 'accepted' });
  });

  it('times out without guessing identity from a missing run ID', async () => {
    const h = fixture();
    h.observer.bind({ sessionKey: 'session', runId: 'accepted' });
    h.emit({ state: 'final', runId: undefined });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await h.observer.terminal).toMatchObject({ kind: 'unconfirmed', reason: 'timeout' });
    expect(h.removeEvent).toHaveBeenCalledTimes(1);
  });

  it.each(['wrong-session', 'empty-run'] as const)('rejects an invalid receipt: %s', async (value) => {
    const h = fixture();
    h.observer.bind({
      sessionKey: value === 'wrong-session' ? 'wrong' : 'session',
      runId: value === 'empty-run' ? ' ' : 'accepted',
    });
    expect(await h.observer.terminal).toMatchObject({ kind: 'unconfirmed', reason: 'invalid-receipt' });
  });

  it.each(['before', 'during', 'dispose'] as const)('settles and cleans up cancellation %s', async (when) => {
    const controller = new AbortController();
    if (when === 'before') controller.abort();
    const h = fixture(controller.signal);
    if (when === 'during') controller.abort();
    if (when === 'dispose') h.observer.dispose();
    expect(await h.observer.terminal).toEqual({ kind: 'cancelled' });
    expect(vi.getTimerCount()).toBe(0);
    h.emit({ state: 'final' });
    expect(await h.observer.terminal).toEqual({ kind: 'cancelled' });
  });

  it('settles as unconfirmed on target gateway disconnect', async () => {
    const h = fixture();
    h.observer.bind({ sessionKey: 'session', runId: 'accepted' });
    h.status({ gatewayId: 'other', connected: false });
    h.status({ gatewayId: 'gateway', connected: false });
    expect(await h.observer.terminal).toEqual({ kind: 'unconfirmed', reason: 'disconnected', runId: 'accepted' });
  });
});
