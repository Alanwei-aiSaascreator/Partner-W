import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSessionKey } from '@clawwork/shared';
import { createMessageStore } from '../src/stores/message-store.js';
import { createChatComposer } from '../src/services/chat-composer.js';
import type { ChatComposerDeps } from '../src/services/chat-composer.js';

const task = { id: 'task-1', title: 'Task', gatewayId: 'gw-1', sessionKey: buildSessionKey('task-1') };
afterEach(() => vi.useRealTimers());

function responseHarness(overrides: Partial<ChatComposerDeps>) {
  const persistMessage = vi.fn(async () => ({ ok: true }));
  const store = createMessageStore({ persistMessage });
  const composer = createChatComposer({
    gateway: {
      patchSession: async () => ({ ok: true }),
      abortChat: async () => ({ ok: true }),
      sendMessage: async () => ({ ok: true }),
    },
    getTaskStore: () => ({
      tasks: [task],
      commitPendingTask: () => task,
      updateTaskTitle: () => {},
      updateTaskMetadata: () => {},
    }),
    getMessageStore: () => store.getState(),
    persistMessage,
    markAbortedByUser: () => {},
    compactSession: async () => ({ ok: true }),
    resetSession: async () => ({ ok: true }),
    translate: (key) => key,
    ...overrides,
  });
  return { store, composer };
}

describe('send acknowledgement response boundary', () => {
  it.each(['model', 'thinking'])('preserves newer processing after delayed %s patch failure', async (patch) => {
    vi.useFakeTimers();
    let finishPatch!: (result: { ok: boolean }) => void;
    const h = responseHarness({
      gateway: {
        patchSession: () =>
          new Promise((resolve) => {
            finishPatch = resolve;
          }),
        abortChat: async () => ({ ok: true }),
        sendMessage: async () => ({ ok: true }),
      },
    });
    try {
      const first = h.composer.send(task.id, {
        content: 'first',
        ...(patch === 'model' ? { presetModel: 'model' } : { presetThinking: 'high' }),
      });
      await h.composer.send(task.id, { content: 'second' });
      finishPatch({ ok: false });
      await first;
      expect(h.store.getState().processingBySession.has(task.sessionKey)).toBe(true);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(h.store.getState().processingBySession.has(task.sessionKey)).toBe(false);
      expect(h.store.getState().messagesByTask[task.id].filter((message) => message.role === 'system')).toHaveLength(2);
    } finally {
      h.composer.dispose();
    }
  });

  it.each(['missing', 'response', 'abort'])('keeps disjoint A/B watches independent with %s', async (outcome) => {
    vi.useFakeTimers();
    const sessionA = buildSessionKey(task.id, 'worker-a');
    const sessionB = buildSessionKey(task.id, 'worker-b');
    let finishA!: (result: { ok: boolean }) => void;
    const h = responseHarness({
      getTaskStore: () => ({
        tasks: [{ ...task, ensemble: true }],
        commitPendingTask: () => task,
        updateTaskTitle: () => {},
        updateTaskMetadata: () => {},
      }),
      getRoomState: () =>
        ({
          conductorSessionKey: task.sessionKey,
          performers: [
            { agentId: 'a', sessionKey: sessionA },
            { agentId: 'b', sessionKey: sessionB },
          ],
        }) as ReturnType<NonNullable<ChatComposerDeps['getRoomState']>>,
      gateway: {
        patchSession: async () => ({ ok: true }),
        abortChat: async () => ({ ok: true }),
        sendMessage: (_gateway, session) =>
          session === sessionA
            ? new Promise((resolve) => {
                finishA = resolve;
              })
            : Promise.resolve({ ok: true }),
      },
    });
    try {
      const first = h.composer.send(task.id, { content: 'first', mentions: ['a'] });
      await h.composer.send(task.id, { content: 'second', mentions: ['b'] });
      finishA({ ok: true });
      await first;
      if (outcome === 'response') h.composer.notifyResponse(sessionB);
      if (outcome === 'abort') await h.composer.abort(task.id);
      await vi.advanceTimersByTimeAsync(30_000);
      if (outcome === 'abort') {
        expect(h.store.getState().messagesByTask[task.id].filter((message) => message.role === 'system')).toHaveLength(
          0,
        );
        return;
      }
      expect(h.store.getState().processingBySession.has(sessionA)).toBe(false);
      expect(h.store.getState().processingBySession.has(sessionB)).toBe(false);
      const errors = h.store.getState().messagesByTask[task.id].filter((message) => message.role === 'system');
      expect(errors.map((message) => message.sessionKey).sort()).toEqual(
        (outcome === 'response' ? [sessionA] : [sessionA, sessionB]).sort(),
      );
    } finally {
      h.composer.dispose();
    }
  });
  it.each(['success', 'failure', 'reject'])(
    'keeps the newer send processing and timeout after older %s',
    async (outcome) => {
      vi.useFakeTimers();
      const persistMessage = vi.fn(async () => ({ ok: true }));
      const store = createMessageStore({ persistMessage });
      let finishFirst!: (result: { ok: boolean }) => void;
      let rejectFirst!: (error: Error) => void;
      let calls = 0;
      const composer = createChatComposer({
        gateway: {
          patchSession: async () => ({ ok: true }),
          abortChat: async () => ({ ok: true }),
          sendMessage: () =>
            ++calls === 1
              ? new Promise((resolve, reject) => {
                  finishFirst = resolve;
                  rejectFirst = reject;
                })
              : Promise.resolve({ ok: true }),
        },
        getTaskStore: () => ({
          tasks: [task],
          commitPendingTask: () => task,
          updateTaskTitle: () => {},
          updateTaskMetadata: () => {},
        }),
        getMessageStore: () => store.getState(),
        persistMessage,
        markAbortedByUser: () => {},
        compactSession: async () => ({ ok: true }),
        resetSession: async () => ({ ok: true }),
        translate: (key) => key,
      });
      try {
        const first = composer.send(task.id, { content: 'first' });
        composer.notifyResponse(task.sessionKey);
        await composer.send(task.id, { content: 'second' });
        if (outcome === 'reject') rejectFirst(new Error('old send rejected'));
        else finishFirst({ ok: outcome === 'success' });
        await first;
        expect(store.getState().processingBySession.has(task.sessionKey)).toBe(true);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(store.getState().messagesByTask[task.id].filter((message) => message.role === 'system')).toHaveLength(
          outcome === 'success' ? 1 : 2,
        );
      } finally {
        composer.dispose();
      }
    },
  );
  it('opens and settles the host dispatch ticket around the actual transport call', async () => {
    const persistMessage = vi.fn(async () => ({ ok: true }));
    const store = createMessageStore({ persistMessage });
    const ticket = Symbol();
    const beginDispatch = vi.fn(() => ticket);
    const settleDispatch = vi.fn();
    const receipt = { sessionKey: task.sessionKey, runId: 'confirmed-run' };
    const sendMessage = vi.fn(async () => ({ ok: true, result: receipt }));
    const composer = createChatComposer({
      gateway: { patchSession: async () => ({ ok: true }), abortChat: async () => ({ ok: true }), sendMessage },
      getTaskStore: () => ({
        tasks: [task],
        commitPendingTask: () => task,
        updateTaskTitle: () => {},
        updateTaskMetadata: () => {},
      }),
      getMessageStore: () => store.getState(),
      persistMessage,
      markAbortedByUser: () => {},
      beginDispatch,
      settleDispatch,
      compactSession: async () => ({ ok: true }),
      resetSession: async () => ({ ok: true }),
      translate: (key) => key,
    });
    try {
      await composer.send(task.id, { content: 'question' });
      expect(beginDispatch).toHaveBeenCalledWith(task.gatewayId, task.sessionKey);
      expect(beginDispatch.mock.invocationCallOrder[0]).toBeLessThan(sendMessage.mock.invocationCallOrder[0]);
      expect(settleDispatch).toHaveBeenCalledWith(ticket, receipt, true);
      expect(sendMessage.mock.invocationCallOrder[0]).toBeLessThan(settleDispatch.mock.invocationCallOrder[0]);
    } finally {
      composer.dispose();
    }
  });
  it.each(['before', 'after', 'missing'])(
    'tracks a response %s acknowledgement using the real store',
    async (timing) => {
      vi.useFakeTimers();
      const persistMessage = vi.fn(async () => ({ ok: true }));
      const store = createMessageStore({ persistMessage });
      const composer = createChatComposer({
        gateway: {
          patchSession: async () => ({ ok: true }),
          abortChat: async () => ({ ok: true }),
          sendMessage: async () => {
            if (timing === 'before') composer.notifyResponse(task.sessionKey);
            return { ok: true, result: { sessionKey: task.sessionKey, runId: 'run-1' } };
          },
        },
        getTaskStore: () => ({
          tasks: [task],
          commitPendingTask: () => task,
          updateTaskTitle: () => {},
          updateTaskMetadata: () => {},
        }),
        getMessageStore: () => store.getState(),
        persistMessage,
        markAbortedByUser: () => {},
        compactSession: async () => ({ ok: true }),
        resetSession: async () => ({ ok: true }),
        translate: (key) => key,
      });
      try {
        expect((await composer.send(task.id, { content: 'question' })).ok).toBe(true);
        if (timing === 'after') composer.notifyResponse(task.sessionKey);
        await vi.advanceTimersByTimeAsync(30_000);
        const systemMessages = store.getState().messagesByTask[task.id].filter((message) => message.role === 'system');
        expect(systemMessages).toHaveLength(timing === 'missing' ? 1 : 0);
      } finally {
        composer.dispose();
      }
    },
  );
});
