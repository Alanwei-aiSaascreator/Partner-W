import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSessionKey, type IpcResult } from '@clawwork/shared';
import { createSessionSync, type SessionSyncDeps } from '../src/services/session-sync.js';
import { createMessageStore } from '../src/stores/message-store.js';
import type { RawHistoryMessage } from '../src/protocol/types.js';

function fixture() {
  const sessionKey = buildSessionKey('task-1');
  const receipt = { sessionKey, runId: 'expected-run' };
  const history: Array<RawHistoryMessage & { stopReason?: string }> = [
    {
      role: 'assistant',
      timestamp: 2000,
      __openclaw: { runId: receipt.runId },
      stopReason: 'stop',
      content: [{ type: 'text', text: 'Final answer' }],
    },
  ];
  const persist = vi.fn<SessionSyncDeps['persistence']['persistMessage']>().mockResolvedValue({ ok: true });
  const store = createMessageStore({ persistMessage: persist });
  const chatHistory = vi.fn(async () => ({ ok: true, result: { messages: history } }));
  const sync = createSessionSync({
    persistence: { persistMessage: persist, loadMessages: async () => ({ ok: true, rows: [] }) },
    gateway: { chatHistory, syncSessions: async () => ({ ok: true, discovered: [] }) },
    getTaskStore: () => ({
      tasks: [{ id: 'task-1', gatewayId: 'gw-1', sessionKey }],
      hydrate: async () => {},
      adoptTasks: () => {},
      updateTaskMetadata: () => {},
    }),
    getMessageStore: () => ({ ...store.getState(), setState: store.setState }),
  });
  return { receipt, history, persist, store, chatHistory, sync };
}

function acknowledgement() {
  let resolve!: (result: IpcResult) => void;
  const promise = new Promise<IpcResult>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('expected run canonical settlement', () => {
  it('confirms an existing legacy canonical row only after attaching proven run ownership', async () => {
    const h = fixture();
    h.store.getState().bulkLoad('task-1', [
      {
        id: 'legacy-id',
        taskId: 'task-1',
        role: 'assistant',
        content: 'Earlier import',
        timestamp: new Date(2000).toISOString(),
        sessionKey: h.receipt.sessionKey,
        artifacts: [],
        toolCalls: [],
      },
    ]);
    expect(await h.sync.syncRun('task-1', h.receipt)).toMatchObject({ kind: 'completed', messageIds: ['legacy-id'] });
    expect(h.persist).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'legacy-id', runId: h.receipt.runId, content: 'Final answer' }),
    );
  });

  it('does not confirm colliding distinct runs from the same history snapshot', async () => {
    const h = fixture();
    h.history.unshift({ ...h.history[0], __openclaw: { runId: 'other-run' } });
    expect(await h.sync.syncRun('task-1', h.receipt)).toEqual({ kind: 'pending' });
    expect(h.persist).not.toHaveBeenCalled();
    expect(h.store.getState().messagesByTask['task-1']).toBeUndefined();
  });

  it('does not merge unowned history with a newer identified active run', async () => {
    const h = fixture();
    delete h.history[0].__openclaw;
    h.store.getState().bindActiveRun(h.receipt.sessionKey, 'newer-run');
    h.store.getState().appendStreamDelta(h.receipt.sessionKey, 'newer answer');
    const active = h.store.getState().activeTurnBySession[h.receipt.sessionKey];
    await h.sync.syncSessionMessages('task-1');
    expect(h.store.getState().activeTurnBySession[h.receipt.sessionKey]).toEqual(active);
    expect(h.persist.mock.calls[0][0].runId).toBeUndefined();
  });

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each(['wrong-run', 'no-run', 'toolUse', 'length', 'unknown', 'empty', 'silent', 'later-wrong-run'] as const)(
    'keeps %s history pending without clearing the active turn',
    async (kind) => {
      const h = fixture();
      h.store.getState().appendStreamDelta(h.receipt.sessionKey, 'still working');
      h.store.getState().finalizeStream(h.receipt.sessionKey, { runId: 'new-active-run' });
      const active = h.store.getState().activeTurnBySession[h.receipt.sessionKey];
      if (kind === 'wrong-run') h.history[0].__openclaw = { runId: 'old-run' };
      else if (kind === 'no-run') delete h.history[0].__openclaw;
      else if (kind === 'empty') h.history.length = 0;
      else if (kind === 'silent') h.history[0].content = [{ type: 'text', text: 'NO_REPLY' }];
      else if (kind === 'later-wrong-run')
        h.history.push({ ...h.history[0], timestamp: 3000, __openclaw: { runId: 'other' } });
      else h.history[0].stopReason = kind;
      expect(await h.sync.syncRun('task-1', h.receipt)).toEqual({ kind: 'pending' });
      expect(h.store.getState().activeTurnBySession[h.receipt.sessionKey]).toEqual(active);
      expect(h.persist).not.toHaveBeenCalled();
    },
  );

  it('returns the final canonical answer only after its acknowledgement, using one history snapshot', async () => {
    const h = fixture();
    h.history.unshift({
      role: 'assistant',
      timestamp: 1000,
      __openclaw: { runId: h.receipt.runId },
      stopReason: 'toolUse',
      content: [
        { type: 'text', text: 'Checking first' },
        { type: 'toolCall', id: 'tool', name: 'read' },
      ],
    });
    const ack = acknowledgement();
    h.persist.mockReturnValueOnce(ack.promise);
    let settled = false;
    const job = h.sync.syncRun('task-1', h.receipt).then((result) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    ack.resolve({ ok: true });
    const canonical = h.store.getState().messagesByTask['task-1'][0];
    expect(await job).toEqual({ kind: 'completed', messageIds: [canonical.id], content: canonical.content });
    expect(canonical.content).toContain('Final answer');
    expect(h.persist).toHaveBeenCalledTimes(1);
    expect(h.chatHistory).toHaveBeenCalledTimes(1);
  });

  it('returns failed for exhausted persistence and retries the same canonical UUID', async () => {
    const h = fixture();
    h.persist.mockResolvedValue({ ok: false, error: 'disk unavailable' });
    const failed = h.sync.syncRun('task-1', h.receipt);
    await vi.runAllTimersAsync();
    expect(await failed).toEqual({ kind: 'failed', reason: 'persistence' });
    expect(h.persist).toHaveBeenCalledTimes(4);
    const id = h.persist.mock.calls[0][0].id;
    h.persist.mockResolvedValue({ ok: true });
    expect(await h.sync.syncRun('task-1', h.receipt)).toMatchObject({ kind: 'completed', messageIds: [id] });
    expect(h.persist.mock.calls.every(([message]) => message.id === id)).toBe(true);
    expect(h.store.getState().messagesByTask['task-1']).toHaveLength(1);
  });

  it('updates a previously canonical preamble to the final snapshot without changing its UUID', async () => {
    const h = fixture();
    h.history[0].stopReason = 'toolUse';
    h.history[0].content = [{ type: 'text', text: 'Checking first' }];
    await h.sync.syncSessionMessages('task-1');
    const id = h.store.getState().messagesByTask['task-1'][0].id;
    h.history[0].stopReason = 'stop';
    h.history[0].content = [{ type: 'text', text: 'Final answer' }];
    expect(await h.sync.syncRun('task-1', h.receipt)).toEqual({
      kind: 'completed',
      messageIds: [id],
      content: 'Final answer',
    });
    expect(h.persist.mock.calls.at(-1)?.[0]).toMatchObject({ id, content: 'Final answer' });
    expect(h.store.getState().messagesByTask['task-1']).toHaveLength(1);
  });

  it('waits behind an ordinary pending write and preserves a newer active run', async () => {
    const h = fixture();
    const ack = acknowledgement();
    h.persist.mockReturnValueOnce(ack.promise);
    const ordinary = h.sync.syncSessionMessages('task-1');
    await vi.advanceTimersByTimeAsync(0);
    h.store.getState().appendStreamDelta(h.receipt.sessionKey, 'next run');
    h.store.getState().finalizeStream(h.receipt.sessionKey, { runId: 'new-run' });
    const active = h.store.getState().activeTurnBySession[h.receipt.sessionKey];
    let settled = false;
    const job = h.sync.syncRun('task-1', h.receipt).then((result) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    expect(h.chatHistory).toHaveBeenCalledTimes(1);
    ack.resolve({ ok: false });
    await vi.runAllTimersAsync();
    await ordinary;
    expect(await job).toMatchObject({ kind: 'completed' });
    expect(h.store.getState().activeTurnBySession[h.receipt.sessionKey]).toEqual(active);
  });

  it('cannot complete or retry old writes after a workspace reset during acknowledgement', async () => {
    const h = fixture();
    const ack = acknowledgement();
    h.persist.mockReturnValueOnce(ack.promise);
    const job = h.sync.syncRun('task-1', h.receipt);
    await vi.advanceTimersByTimeAsync(0);
    h.sync.resetHydration();
    h.store.setState({ messagesByTask: {}, activeTurnBySession: {} });
    ack.resolve({ ok: false });
    expect(await job).toEqual({ kind: 'pending' });
    await vi.runAllTimersAsync();
    expect(h.persist).toHaveBeenCalledTimes(1);
    expect(h.store.getState().messagesByTask).toEqual({});
  });

  it('rejects a receipt for another session before reading history', async () => {
    const h = fixture();
    expect(await h.sync.syncRun('task-1', { ...h.receipt, sessionKey: buildSessionKey('other') })).toEqual({
      kind: 'failed',
      reason: 'invalid-receipt',
    });
    expect(h.chatHistory).not.toHaveBeenCalled();
  });
});
