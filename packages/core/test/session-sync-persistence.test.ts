import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSessionKey, type IpcResult, type Message } from '@clawwork/shared';
import { createSessionSync, type SessionSyncDeps } from '../src/services/session-sync.js';
import { createMessageStore } from '../src/stores/message-store.js';
import type { RawHistoryMessage } from '../src/protocol/types.js';

const sessionKey = buildSessionKey('task-1');
const timestamp = new Date(1000).toISOString();
const attachment = { fileName: 'image.png', dataUrl: 'file:///image.png', mimeType: 'image/png' };

function harness() {
  const persist = vi.fn<SessionSyncDeps['persistence']['persistMessage']>().mockResolvedValue({ ok: true });
  const store = createMessageStore({ persistMessage: persist });
  const task = { id: 'task-1', gatewayId: 'gw-1', sessionKey };
  const tasks = [task];
  const history: RawHistoryMessage[] = [
    { role: 'assistant', timestamp: 1000, content: [{ type: 'text', text: 'answer' }] },
  ];
  const discovered = [
    {
      ...task,
      taskId: task.id,
      title: 'Task',
      updatedAt: timestamp,
      agentId: 'main',
      messages: [{ role: 'assistant', content: 'answer', timestamp, attachments: [attachment] }],
    },
  ];
  const sync = createSessionSync({
    persistence: { persistMessage: persist, loadMessages: async () => ({ ok: true, rows: [] }) },
    gateway: {
      chatHistory: async () => ({
        ok: true,
        result: { messages: history },
      }),
      syncSessions: async () => ({ ok: true, discovered }),
    },
    getTaskStore: () => ({
      tasks,
      hydrate: async () => {},
      adoptTasks: () => {},
      updateTaskMetadata: () => {},
    }),
    getMessageStore: () => ({ ...store.getState(), setState: store.setState }),
  });
  return { sync, persist, store, task, tasks, history, discovered };
}

function deferred() {
  let resolve!: (value: IpcResult) => void;
  const promise = new Promise<IpcResult>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('canonical persistence acknowledgement', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each(['session', 'discovery'] as const)('waits for the %s write acknowledgement', async (path) => {
    const h = harness();
    const ack = deferred();
    h.persist.mockReturnValueOnce(ack.promise);
    let settled = false;
    const job = (path === 'session' ? h.sync.syncSessionMessages('task-1') : h.sync.syncFromGateway()).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.persist).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    ack.resolve({ ok: true });
    await job;
    expect(settled).toBe(true);
  });

  it.each(['reject', 'not-ok'] as const)(
    'retries %s writes with the same ID and no duplicate memory',
    async (failure) => {
      const h = harness();
      if (failure === 'reject') h.persist.mockRejectedValueOnce(new Error('disk unavailable'));
      else h.persist.mockResolvedValueOnce({ ok: false, error: 'disk unavailable' });
      const job = h.sync.syncSessionMessages('task-1');
      await vi.advanceTimersByTimeAsync(1999);
      expect(h.persist).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await job;
      expect(h.persist).toHaveBeenCalledTimes(2);
      expect(h.persist.mock.calls[1][0].id).toBe(h.persist.mock.calls[0][0].id);
      expect(h.store.getState().messagesByTask['task-1']).toHaveLength(1);
    },
  );

  it.each(['explicit', 'reconnect'] as const)(
    'retains exhausted writes for a later %s retry after promotion',
    async (path) => {
      const h = harness();
      h.persist.mockResolvedValue({ ok: false, error: 'disk unavailable' });
      const failed = h.sync.syncSessionMessages('task-1').catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      for (const [index, delay] of [2000, 4000, 8000].entries()) {
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(h.persist).toHaveBeenCalledTimes(index + 1);
        await vi.advanceTimersByTimeAsync(1);
      }
      expect(await failed).toBeInstanceOf(Error);
      expect(h.persist).toHaveBeenCalledTimes(4);
      expect(h.store.getState().activeTurnBySession[sessionKey]).toBeUndefined();
      const id = h.persist.mock.calls[0][0].id;
      h.persist.mockResolvedValue({ ok: true });
      if (path === 'explicit') await h.sync.syncSessionMessages('task-1');
      else {
        h.sync.retrySyncPending();
        await vi.runAllTimersAsync();
      }
      expect(h.persist).toHaveBeenCalledTimes(5);
      expect(h.persist.mock.calls[4][0].id).toBe(id);
      expect(h.store.getState().messagesByTask['task-1']).toHaveLength(1);
    },
  );

  it('retries attachment updates even after attachments have merged in memory', async () => {
    const h = harness();
    await h.sync.syncSessionMessages('task-1');
    h.persist.mockResolvedValue({ ok: false, error: 'disk unavailable' });
    const failed = h.sync.syncFromGateway().catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    expect(await failed).toBeInstanceOf(Error);
    expect(h.store.getState().messagesByTask['task-1'][0].attachments).toEqual([attachment]);
    h.persist.mockResolvedValue({ ok: true });
    await h.sync.syncFromGateway();
    expect(h.persist).toHaveBeenCalledTimes(6);
    expect(h.persist.mock.calls[5][0]).toMatchObject({ id: h.persist.mock.calls[0][0].id, attachments: [attachment] });
  });

  it('retains every discovered message if the first write fails', async () => {
    const h = harness();
    h.discovered[0].messages.unshift({
      role: 'user',
      content: 'question',
      timestamp: new Date(0).toISOString(),
      attachments: [],
    });
    h.persist.mockResolvedValue({ ok: false });
    const failed = h.sync.syncFromGateway().catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    expect(await failed).toBeInstanceOf(Error);
    const ids = h.store.getState().messagesByTask['task-1'].map((m) => m.id);
    h.persist.mockResolvedValue({ ok: true });
    await h.sync.syncFromGateway();
    expect(h.persist.mock.calls.slice(4).map(([message]) => message.id)).toEqual(ids);
    expect(h.store.getState().messagesByTask['task-1']).toHaveLength(2);
  });

  it.each(['taskId', 'sessionKey', 'gatewayId'] as const)('does not flush another discovered %s', async (field) => {
    const h = harness();
    h.persist.mockResolvedValue({ ok: false });
    const failed = h.sync.syncSessionMessages('task-1').catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    expect(await failed).toBeInstanceOf(Error);
    const id = h.persist.mock.calls[0][0].id;
    h.persist.mockResolvedValue({ ok: true });
    h.discovered[0][field] = field === 'sessionKey' ? buildSessionKey('other') : 'other';
    h.discovered[0].messages[0].attachments = [];
    await h.sync.syncFromGateway();
    expect(h.persist.mock.calls.slice(4).every(([message]) => message.id !== id)).toBe(true);
    await h.sync.syncSessionMessages('task-1');
    expect(h.persist.mock.calls.at(-1)?.[0].id).toBe(id);
  });

  it.each(['session', 'discovery'] as const)(
    'serializes %s and discovery writes so the richer attachment survives',
    async (firstPath) => {
      const h = harness();
      const firstAck = deferred();
      let disk: Parameters<SessionSyncDeps['persistence']['persistMessage']>[0] | undefined;
      h.persist.mockImplementation(async (message) => {
        if (h.persist.mock.calls.length === 1) await firstAck.promise;
        disk = message;
        return { ok: true };
      });
      h.discovered[0].messages[0].attachments = [];
      const first = firstPath === 'session' ? h.sync.syncSessionMessages('task-1') : h.sync.syncFromGateway();
      await vi.advanceTimersByTimeAsync(0);
      h.discovered[0].messages[0].attachments = [attachment];
      const second = h.sync.syncFromGateway();
      await vi.advanceTimersByTimeAsync(0);
      firstAck.resolve({ ok: true });
      await Promise.all([first, second]);
      expect(disk?.attachments).toEqual([attachment]);
      expect(h.persist).toHaveBeenCalledTimes(2);
      expect(h.store.getState().messagesByTask['task-1']).toHaveLength(1);
    },
  );

  it('reads discovered local messages after other sessions finish while its queue was waiting', async () => {
    const h = harness();
    h.discovered[0].messages[0].attachments = [];
    const secondTask = { id: 'task-2', gatewayId: 'gw-1', sessionKey: buildSessionKey('task-2') };
    h.tasks.push(secondTask);
    h.discovered.push({ ...h.discovered[0], ...secondTask, taskId: secondTask.id });
    const firstAck = deferred();
    h.persist.mockReturnValueOnce(firstAck.promise);
    const discovery = h.sync.syncFromGateway();
    await vi.advanceTimersByTimeAsync(0);
    await h.sync.syncSessionMessages('task-2');
    const id = h.store.getState().messagesByTask['task-2'][0].id;
    firstAck.resolve({ ok: true });
    await discovery;
    expect(
      h.persist.mock.calls.filter(([message]) => message.taskId === 'task-2').map(([message]) => message.id),
    ).toEqual([id]);
    expect(h.store.getState().messagesByTask['task-2'][0].id).toBe(id);
  });

  it('keeps backfilled attachments when appending later discovered messages', async () => {
    const h = harness();
    await h.sync.syncSessionMessages('task-1');
    h.discovered[0].messages.push(
      { role: 'user', content: 'next question', timestamp: new Date(2000).toISOString(), attachments: [] },
      { role: 'assistant', content: 'next answer', timestamp: new Date(3000).toISOString(), attachments: [] },
    );
    await h.sync.syncFromGateway();
    expect(h.store.getState().messagesByTask['task-1'][0].attachments).toEqual([attachment]);
  });

  it('preserves a new active run started while old history attachments are awaiting acknowledgement', async () => {
    const h = harness();
    h.history[0].__openclaw = { runId: 'run-old' };
    await h.sync.syncSessionMessages('task-1');
    h.store.getState().appendStreamDelta(sessionKey, 'old answer');
    h.store.getState().finalizeStream(sessionKey, { runId: 'run-old' });
    h.history[0].content?.push({ type: 'image', url: attachment.dataUrl });
    const ack = deferred();
    h.persist.mockReturnValueOnce(ack.promise);
    const sync = h.sync.syncSessionMessages('task-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.persist).toHaveBeenCalledTimes(2);
    const active = { ...h.store.getState().activeTurnBySession[sessionKey], runId: 'run-new', finalized: false };
    h.store.setState({ activeTurnBySession: { [sessionKey]: active } });
    ack.resolve({ ok: true });
    await sync;
    expect(h.store.getState().activeTurnBySession[sessionKey]).toEqual(active);
  });

  it.each(['empty', 'unattributed'] as const)(
    'preserves a known active run when history is %s',
    async (historyKind) => {
      const h = harness();
      await h.sync.syncSessionMessages('task-1');
      h.store.getState().appendStreamDelta(sessionKey, 'still working');
      h.store.getState().finalizeStream(sessionKey, { runId: 'run-new' });
      const active = h.store.getState().activeTurnBySession[sessionKey];
      if (historyKind === 'empty') h.history.length = 0;
      await h.sync.syncSessionMessages('task-1');
      expect(h.store.getState().activeTurnBySession[sessionKey]).toEqual(active);
    },
  );

  it.each([true, false])(
    'ignores an old workspace acknowledgement (%s) without clearing new pending writes',
    async (ok) => {
      const h = harness();
      const message: Message = {
        id: 'stable-id',
        taskId: 'task-1',
        sessionKey,
        role: 'assistant',
        content: 'answer',
        timestamp,
        artifacts: [],
        toolCalls: [],
      };
      h.store.getState().bulkLoad('task-1', [message]);
      const oldAck = deferred();
      h.persist.mockReturnValueOnce(oldAck.promise);
      const oldJob = h.sync.syncFromGateway();
      await vi.advanceTimersByTimeAsync(0);
      const oldQueued = h.sync.syncFromGateway();
      await vi.advanceTimersByTimeAsync(0);
      h.sync.resetHydration();
      h.store.setState({ messagesByTask: { 'task-1': [message] } });
      h.persist.mockResolvedValue({ ok: false });
      const newJob = h.sync.syncFromGateway().catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.persist).toHaveBeenCalledTimes(2);
      oldAck.resolve({ ok });
      await Promise.all([oldJob, oldQueued]);
      await vi.runAllTimersAsync();
      expect(await newJob).toBeInstanceOf(Error);
      expect(h.persist).toHaveBeenCalledTimes(5);
      h.persist.mockResolvedValue({ ok: true });
      await h.sync.syncFromGateway();
      expect(h.persist).toHaveBeenCalledTimes(6);
    },
  );
});
