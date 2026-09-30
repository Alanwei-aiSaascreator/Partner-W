import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSessionKey } from '@clawwork/shared';
import { createMessageStore } from '../src/stores/message-store.js';
import { createGatewayDispatcher } from '../src/services/gateway-dispatcher.js';
import { createSessionSync } from '../src/services/session-sync.js';
import { createChatComposer } from '../src/services/chat-composer.js';
import type { GatewayDispatcherDeps } from '../src/services/gateway-dispatcher.js';
import type { GatewayEvent } from '../src/ports/gateway-transport.js';
import type { RawHistoryMessage } from '../src/protocol/types.js';

const task = { id: 'task-1', title: 'Task', gatewayId: 'gw-1', sessionKey: buildSessionKey('task-1') };
const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

function harness(history: RawHistoryMessage[] = []) {
  const persistMessage = vi.fn(async () => ({ ok: true }));
  const store = createMessageStore({ persistMessage });
  const sessionSync = createSessionSync({
    persistence: { persistMessage, loadMessages: async () => ({ ok: true, rows: [] }) },
    gateway: {
      chatHistory: async () => ({ ok: true, result: { messages: history } }),
      syncSessions: async () => ({ ok: true, discovered: [] }),
    },
    getTaskStore: () => ({
      tasks: [task],
      hydrate: async () => {},
      adoptTasks: () => {},
      updateTaskMetadata: () => {},
    }),
    getMessageStore: () => ({ ...store.getState(), setState: store.setState }),
  });
  const syncSessionMessages = vi.fn(sessionSync.syncSessionMessages);
  const notifyAgentResponse = vi.fn();
  let listener: (event: GatewayEvent) => void = () => {};
  const dispatcher = createGatewayDispatcher({
    gateway: {
      onGatewayEvent: (callback: (event: GatewayEvent) => void) => {
        listener = callback;
        return () => {};
      },
      onGatewayStatus: () => () => {},
      onRuntimeStatus: () => () => {},
    },
    getTaskStore: () => ({ tasks: [task], updateTaskTitle: () => {} }),
    getMessageStore: () => ({ ...store.getState(), setState: store.setState }),
    getActiveTaskId: () => task.id,
    markUnread: vi.fn(),
    getSettings: async () => null,
    sendNotification: async () => {},
    isWindowFocused: () => true,
    translate: (key: string) => key,
    reportDebugEvent: () => {},
    notifyAgentResponse,
    syncSessionMessages,
  } as unknown as GatewayDispatcherDeps);
  const stop = dispatcher.start();
  cleanups.push(() => {
    stop();
    dispatcher.reset();
  });
  const emit = (event: string, payload: Record<string, unknown>) =>
    listener({ event, payload, gatewayId: task.gatewayId });
  const lifecycle = (runId: string, phase: string) =>
    emit('agent', { sessionKey: task.sessionKey, runId, stream: 'lifecycle', data: { phase } });
  const chat = (runId: string, state: string, text: string) =>
    emit('chat', { sessionKey: task.sessionKey, runId, state, deltaText: text, text });
  return { store, persistMessage, syncSessionMessages, notifyAgentResponse, emit, lifecycle, chat, dispatcher };
}

describe('dispatcher run boundaries with the real message store', () => {
  it('preserves the newer turn after stale history reconciliation finishes', async () => {
    const h = harness([
      {
        role: 'assistant',
        timestamp: 1000,
        __openclaw: { runId: 'old' },
        content: [{ type: 'text', text: 'old answer' }],
      },
    ]);
    h.lifecycle('old', 'start');
    h.chat('old', 'final', 'old answer');
    await Promise.all(h.syncSessionMessages.mock.results.map((result) => result.value));
    h.lifecycle('new', 'start');
    h.chat('new', 'delta', 'new answer');
    h.chat('old', 'final', 'late old answer');
    await Promise.all(h.syncSessionMessages.mock.results.map((result) => result.value));
    expect(h.store.getState().activeTurnBySession[task.sessionKey]?.streamingText).toBe('new answer');
    expect(h.store.getState().messagesByTask[task.id]).toHaveLength(1);
  });

  it('requests only one history reconciliation when a pending dispatch buffer overflows', () => {
    const h = harness();
    h.dispatcher.beginDispatch(task.gatewayId, task.sessionKey);
    for (let index = 0; index < 100; index++) h.chat('pending-run', 'delta', `part-${index}`);
    expect(h.syncSessionMessages).toHaveBeenCalledTimes(1);
    expect(h.store.getState().activeTurnBySession[task.sessionKey]).toBeUndefined();
  });

  it.each(['final', 'end'])('accepts an external successor after a confirmed run reaches %s', (terminal) => {
    const h = harness();
    const ticket = h.dispatcher.beginDispatch(task.gatewayId, task.sessionKey);
    h.dispatcher.settleDispatch(ticket, { sessionKey: task.sessionKey, runId: 'confirmed' });
    h.lifecycle('confirmed', 'start');
    h.chat('confirmed', 'delta', 'first answer');
    if (terminal === 'final') h.chat('confirmed', 'final', 'first answer');
    else h.lifecycle('confirmed', 'end');
    h.lifecycle('external-successor', 'start');
    h.chat('external-successor', 'delta', 'external answer');
    h.lifecycle('confirmed', 'start');
    h.chat('confirmed', 'delta', 'stale answer');
    expect(h.store.getState().activeTurnBySession[task.sessionKey]?.streamingText).toBe('external answer');
  });

  it('rejects a dispatch for a gateway that does not own the task', () => {
    const h = harness();
    expect(() => h.dispatcher.beginDispatch('foreign-gateway', task.sessionKey)).toThrow(
      'Dispatch gateway does not own the task',
    );
  });

  it('does not send a 129th owned session when all dispatch buffer slots are occupied', async () => {
    const h = harness();
    for (let index = 0; index < 128; index++)
      h.dispatcher.beginDispatch(task.gatewayId, buildSessionKey(task.id, `worker-${index}`));
    const sendMessage = vi.fn(async () => ({ ok: true }));
    const composer = createChatComposer({
      gateway: { sendMessage, patchSession: async () => ({ ok: true }), abortChat: async () => ({ ok: true }) },
      getTaskStore: () => ({
        tasks: [task],
        commitPendingTask: () => task,
        updateTaskTitle: () => {},
        updateTaskMetadata: () => {},
      }),
      getMessageStore: () => h.store.getState(),
      persistMessage: h.persistMessage,
      markAbortedByUser: () => {},
      beginDispatch: h.dispatcher.beginDispatch,
      settleDispatch: h.dispatcher.settleDispatch,
      compactSession: async () => ({ ok: true }),
      resetSession: async () => ({ ok: true }),
      translate: (key) => key,
    });
    try {
      expect((await composer.send(task.id, { content: 'question' })).ok).toBe(false);
      expect(sendMessage).not.toHaveBeenCalled();
      expect(h.store.getState().processingBySession.has(task.sessionKey)).toBe(false);
    } finally {
      composer.dispose();
    }
  });
  it('buffers early frames and accepts only the acknowledged run', () => {
    const h = harness();
    const ticket = h.dispatcher.beginDispatch(task.gatewayId, task.sessionKey);
    h.lifecycle('unknown-old', 'start');
    h.chat('unknown-old', 'delta', 'old');
    h.lifecycle('confirmed', 'start');
    h.chat('confirmed', 'delta', 'correct');
    expect(h.store.getState().activeTurnBySession[task.sessionKey]).toBeUndefined();
    h.dispatcher.settleDispatch(ticket, { sessionKey: task.sessionKey, runId: 'confirmed' });
    expect(h.store.getState().activeTurnBySession[task.sessionKey]?.streamingText).toBe('correct');
    h.lifecycle('another-unknown-old', 'start');
    h.chat('another-unknown-old', 'delta', 'leaked');
    expect(h.store.getState().activeTurnBySession[task.sessionKey]?.streamingText).toBe('correct');
  });

  it('does not let an older acknowledgement settle a newer dispatch ticket', () => {
    const h = harness();
    const first = h.dispatcher.beginDispatch(task.gatewayId, task.sessionKey);
    const second = h.dispatcher.beginDispatch(task.gatewayId, task.sessionKey);
    h.chat('new', 'delta', 'new answer');
    h.dispatcher.settleDispatch(first, { sessionKey: task.sessionKey, runId: 'old' });
    expect(h.store.getState().activeTurnBySession[task.sessionKey]).toBeUndefined();
    h.dispatcher.settleDispatch(second, { sessionKey: task.sessionKey, runId: 'new' });
    expect(h.store.getState().activeTurnBySession[task.sessionKey]?.streamingText).toBe('new answer');
  });
  it.each(['final', 'end', 'error'])('keeps the current run open after the old run sends %s', (terminal) => {
    const h = harness();
    h.lifecycle('run-old', 'start');
    h.chat('run-old', 'final', 'old answer');
    h.store.getState().clearActiveTurn(task.sessionKey);
    h.lifecycle('run-new', 'start');
    h.chat('run-new', 'delta', 'new answer');
    h.notifyAgentResponse.mockClear();
    if (terminal === 'final') h.chat('run-old', 'final', 'late old answer');
    else h.lifecycle('run-old', terminal);
    h.chat('run-new', 'delta', ' continues');
    expect(h.store.getState().activeTurnBySession[task.sessionKey]).toMatchObject({
      streamingText: 'new answer continues',
      finalized: false,
    });
    expect(h.persistMessage).not.toHaveBeenCalled();
  });

  it('does not reopen an old run after its successor starts', () => {
    const h = harness();
    h.lifecycle('run-old', 'start');
    h.lifecycle('run-old', 'end');
    h.lifecycle('run-new', 'start');
    h.lifecycle('run-old', 'start');
    h.chat('run-old', 'delta', 'old leaked answer');
    h.chat('run-new', 'delta', 'new answer');
    expect(h.store.getState().activeTurnBySession[task.sessionKey]?.streamingText).toBe('new answer');
  });
});
