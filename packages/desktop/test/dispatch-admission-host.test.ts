// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GatewayEvent } from '@clawwork/core';

const h = vi.hoisted(() => {
  const listeners = new Set<(event: GatewayEvent) => void>();
  const sendMessage = vi.fn();
  const api: Record<string, unknown> = {
    sendMessage,
    patchSession: vi.fn(async () => ({ ok: true })),
    persistMessage: vi.fn(async () => ({ ok: true })),
    chatHistory: vi.fn(async () => ({ ok: true, result: { messages: [] } })),
    loadMessages: vi.fn(async () => ({ ok: true, messages: [] })),
    onGatewayEvent: (listener: (event: GatewayEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  (globalThis as unknown as { window: { clawwork: unknown } }).window.clawwork = new Proxy(api, {
    get: (target, prop) => target[prop as string] ?? vi.fn(async () => ({ ok: true })),
  });
  return { listeners, sendMessage };
});

vi.mock('../src/renderer/features/team-meeting/instance', () => ({
  teamMeetingController: { load: vi.fn(async () => {}) },
}));

import { composer, composerBridge, useMessageStore, useTaskStore } from '../src/renderer/platform';
import { useGatewayDispatcherSetup } from '../src/renderer/hooks/useGatewayDispatcherSetup';

const TASK_ID = 'admission-task';
const GATEWAY_ID = 'admission-gateway';
const SESSION_KEY = `agent:main:clawwork:task:${TASK_ID}`;
const RECEIPT = { sessionKey: SESSION_KEY, runId: 'accepted-run' };
const uninitializedBeginDispatch = composerBridge.beginDispatch;

function emit(runId: string, text: string): void {
  for (const listener of h.listeners) {
    listener({
      gatewayId: GATEWAY_ID,
      event: 'chat',
      payload: { sessionKey: SESSION_KEY, runId, state: 'delta', deltaText: text },
    });
  }
}

describe('desktop dispatch admission host', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    h.listeners.clear();
    h.sendMessage.mockReset();
    useTaskStore.setState({
      tasks: [{ id: TASK_ID, gatewayId: GATEWAY_ID, sessionKey: SESSION_KEY, title: 'Admission' }] as never,
      activeTaskId: TASK_ID,
    });
    useMessageStore.setState({ messagesByTask: {}, activeTurnBySession: {}, processingBySession: new Set() });
    composer.dispose();
  });

  afterEach(() => {
    composer.dispose();
    h.listeners.clear();
  });

  it('rejects an uninitialized bridge without sending or retaining pending user state', async () => {
    composerBridge.beginDispatch = uninitializedBeginDispatch;
    h.sendMessage.mockResolvedValue({ ok: true, result: RECEIPT });

    const result = await composer.send(TASK_ID, { content: 'test', deferUserMessageUntilSent: true });

    expect(result.ok).toBe(false);
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(useMessageStore.getState().processingBySession.has(SESSION_KEY)).toBe(false);
    expect(useMessageStore.getState().activeTurnBySession[SESSION_KEY]).toBeUndefined();
    expect(useMessageStore.getState().messagesByTask[TASK_ID]?.some((message) => message.role === 'user')).toBe(false);
  });

  it('buffers pre-receipt frames and admits only the accepted run through the real composer and dispatcher', async () => {
    const dispatcher = useGatewayDispatcherSetup();
    dispatcher.reset();
    const stop = dispatcher.start();
    const begin = vi.spyOn(dispatcher, 'beginDispatch');
    const settle = vi.spyOn(dispatcher, 'settleDispatch');
    h.sendMessage.mockImplementation(async () => {
      emit('stale-run', 'stale');
      emit(RECEIPT.runId, 'accepted');
      expect(useMessageStore.getState().activeTurnBySession[SESSION_KEY]).toBeUndefined();
      return { ok: true, result: RECEIPT };
    });

    const result = await composer.send(TASK_ID, { content: 'test' });

    expect(result.ok).toBe(true);
    expect(begin).toHaveBeenCalledExactlyOnceWith(GATEWAY_ID, SESSION_KEY);
    expect(settle).toHaveBeenCalledExactlyOnceWith(begin.mock.results[0]?.value, RECEIPT, true);
    expect(useMessageStore.getState().activeTurnBySession[SESSION_KEY]).toMatchObject({
      runId: RECEIPT.runId,
      streamingText: 'accepted',
    });
    stop();
  });

  it('settles a refused send without allowing buffered content into the active turn', async () => {
    const dispatcher = useGatewayDispatcherSetup();
    dispatcher.reset();
    const stop = dispatcher.start();
    const settle = vi.spyOn(dispatcher, 'settleDispatch');
    h.sendMessage.mockImplementation(async () => {
      emit('refused-run', 'must not appear');
      return { ok: false, error: 'refused' };
    });

    const result = await composer.send(TASK_ID, { content: 'test', deferUserMessageUntilSent: true });

    expect(result.ok).toBe(false);
    expect(settle).toHaveBeenCalledExactlyOnceWith(expect.any(Symbol), undefined, false);
    expect(useMessageStore.getState().activeTurnBySession[SESSION_KEY]).toBeUndefined();
    expect(useMessageStore.getState().processingBySession.has(SESSION_KEY)).toBe(false);
    stop();
  });
});
