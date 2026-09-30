// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GatewayEvent } from '@clawwork/core';

const h = vi.hoisted(() => {
  const listeners = new Set<(event: GatewayEvent) => void>();
  const sendMessage = vi.fn();
  const sync: { current?: ReturnType<(typeof import('@clawwork/core'))['createSessionSync']> } = {};
  const dispatch: { current?: ReturnType<(typeof import('@clawwork/core'))['createGatewayDispatcher']> } = {};
  const ports = {
    gateway: {
      sendMessage,
      patchSession: vi.fn(async () => ({ ok: true })),
      chatHistory: vi.fn(async () => ({ ok: true, result: { messages: [] } })),
      onGatewayEvent: (listener: (event: GatewayEvent) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    persistence: {
      persistMessage: vi.fn(async () => ({ ok: true })),
      persistTaskUpdate: vi.fn(async () => ({ ok: true })),
      loadMessages: vi.fn(async () => ({ ok: true, messages: [] })),
    },
    settings: { getSettings: vi.fn(async () => ({})) },
    notifications: { sendNotification: vi.fn() },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => null, setItem: () => {} },
  });
  return { listeners, sendMessage, ports, sync, dispatch };
});

vi.mock('../src/platform/index.js', () => ({ ports: h.ports }));
vi.mock('../src/persistence/db.js', () => ({ getIdentity: vi.fn() }));
vi.mock('../src/gateway/client-registry.js', () => ({ getClient: vi.fn() }));
vi.mock('../src/lib/debug.js', () => ({ reportDebugEvent: vi.fn() }));
vi.mock('@clawwork/core', async (importOriginal) => {
  const real = await importOriginal<typeof import('@clawwork/core')>();
  return {
    ...real,
    createGatewayDispatcher: (deps: Parameters<typeof real.createGatewayDispatcher>[0]) => {
      const dispatcher = real.createGatewayDispatcher(deps);
      h.dispatch.current = dispatcher;
      return dispatcher;
    },
    createSessionSync: (deps: Parameters<typeof real.createSessionSync>[0]) => {
      const sync = real.createSessionSync(deps);
      h.sync.current = sync;
      return sync;
    },
  };
});

import { composer, dispatcher, messageStoreApi, taskStoreApi } from '../src/stores/index.js';

const TASK_ID = 'admission-task';
const GATEWAY_ID = 'admission-gateway';
const SESSION_KEY = `agent:main:clawwork:task:${TASK_ID}`;
const RECEIPT = { sessionKey: SESSION_KEY, runId: 'accepted-run' };

function emit(event: string, payload: Record<string, unknown>): void {
  for (const listener of h.listeners) listener({ gatewayId: GATEWAY_ID, event, payload });
}

describe('PWA dispatch admission host', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    h.listeners.clear();
    h.sendMessage.mockReset();
    composer.dispose();
    dispatcher.reset();
    taskStoreApi.setState({
      tasks: [{ id: TASK_ID, gatewayId: GATEWAY_ID, sessionKey: SESSION_KEY, title: 'Admission' }] as never,
      activeTaskId: TASK_ID,
    });
    messageStoreApi.setState({ messagesByTask: {}, activeTurnBySession: {}, processingBySession: new Set() });
  });

  afterEach(() => {
    composer.dispose();
    dispatcher.reset();
    h.listeners.clear();
  });

  it('buffers frames before the receipt and admits only the accepted run', async () => {
    const stop = dispatcher.start();
    const begin = vi.spyOn(h.dispatch.current!, 'beginDispatch');
    const settle = vi.spyOn(h.dispatch.current!, 'settleDispatch');
    h.sendMessage.mockImplementation(async () => {
      emit('chat', { sessionKey: SESSION_KEY, runId: 'stale-run', state: 'delta', deltaText: 'stale' });
      emit('chat', { sessionKey: SESSION_KEY, runId: RECEIPT.runId, state: 'delta', deltaText: 'accepted' });
      expect(messageStoreApi.getState().activeTurnBySession[SESSION_KEY]).toBeUndefined();
      return { ok: true, result: RECEIPT };
    });

    const result = await composer.send(TASK_ID, { content: 'test' });

    expect(result.ok).toBe(true);
    expect(begin).toHaveBeenCalledExactlyOnceWith(GATEWAY_ID, SESSION_KEY);
    expect(settle).toHaveBeenCalledExactlyOnceWith(begin.mock.results[0]?.value, RECEIPT, true);
    expect(messageStoreApi.getState().activeTurnBySession[SESSION_KEY]).toMatchObject({
      runId: RECEIPT.runId,
      streamingText: 'accepted',
    });
    stop();
  });

  it('forwards completed-run tool reconciliation with task, session and late tool identity', async () => {
    const stop = dispatcher.start();
    const sync = vi.spyOn(h.sync.current!, 'syncSessionMessages').mockResolvedValue();
    messageStoreApi.getState().bulkLoad(TASK_ID, [
      {
        id: 'previous-message',
        taskId: TASK_ID,
        sessionKey: SESSION_KEY,
        runId: 'previous-run',
        role: 'assistant',
        content: 'previous answer',
        toolCalls: [],
        artifacts: [],
        timestamp: new Date(1000).toISOString(),
      },
    ]);
    h.sendMessage.mockResolvedValue({ ok: true, result: RECEIPT });
    await composer.send(TASK_ID, { content: 'test' });
    emit('agent', {
      sessionKey: SESSION_KEY,
      runId: 'previous-run',
      stream: 'tool',
      data: { phase: 'result', toolCallId: 'late-tool', name: 'exec', result: 'done' },
    });

    expect(sync).toHaveBeenCalledWith(
      TASK_ID,
      SESSION_KEY,
      expect.objectContaining({
        gatewayId: GATEWAY_ID,
        runId: 'previous-run',
        toolCall: expect.objectContaining({ id: 'late-tool' }),
      }),
    );
    stop();
  });
});
