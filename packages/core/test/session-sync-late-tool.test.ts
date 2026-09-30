import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSessionKey } from '@clawwork/shared';
import type { Message, ToolCall } from '@clawwork/shared';
import { createMessageStore } from '../src/stores/message-store.js';
import { createSessionSync } from '../src/services/session-sync.js';

const task = { id: 'task-1', gatewayId: 'gw-1', sessionKey: buildSessionKey('task-1') };
afterEach(() => vi.useRealTimers());
const toolCall: ToolCall = { id: 'tool-1', name: 'exec', status: 'done', startedAt: '', result: 'late output' };
const canonical = (sessionKey: string, runId: string, id: string): Message => ({
  id,
  taskId: task.id,
  role: 'assistant',
  content: id,
  sessionKey,
  runId,
  timestamp: new Date(id === 'old' ? 1000 : 2000).toISOString(),
  artifacts: [],
  toolCalls: [],
});

function harness() {
  const persistMessage = vi.fn(async () => ({ ok: true }));
  const store = createMessageStore({ persistMessage });
  let messages: unknown[] = [];
  const sync = createSessionSync({
    persistence: { persistMessage, loadMessages: async () => ({ ok: true, rows: [] }) },
    gateway: {
      chatHistory: async () => ({ ok: true, result: { messages } }),
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
  return {
    store,
    persistMessage,
    sync,
    setHistory: (history: unknown[]) => {
      messages = history;
    },
  };
}

describe('canonical late tools through the sole session-sync writer', () => {
  it('does not consume a new-epoch late update when an old write acknowledgement returns', async () => {
    vi.useFakeTimers();
    const h = harness();
    let acknowledge!: (result: { ok: boolean }) => void;
    h.persistMessage.mockReturnValueOnce(
      new Promise((resolve) => {
        acknowledge = resolve;
      }),
    );
    h.setHistory([
      {
        role: 'assistant',
        timestamp: 1000,
        __openclaw: { runId: 'run-old' },
        content: [{ type: 'text', text: 'old' }],
      },
    ]);
    const oldJob = h.sync.syncSessionMessages(task.id, task.sessionKey, {
      gatewayId: task.gatewayId,
      runId: 'run-old',
      toolCall,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.persistMessage).toHaveBeenCalledTimes(1);
    h.sync.resetHydration();
    h.store.setState({ messagesByTask: {}, activeTurnBySession: {} });
    h.setHistory([]);
    const replacement = { ...toolCall, result: 'new epoch output' };
    await h.sync.syncSessionMessages(task.id, task.sessionKey, {
      gatewayId: task.gatewayId,
      runId: 'run-old',
      toolCall: replacement,
    });
    acknowledge({ ok: true });
    await oldJob;
    h.store.getState().bulkLoad(task.id, [canonical(task.sessionKey, 'run-old', 'old')]);
    await h.sync.syncSessionMessages(task.id);
    expect(h.store.getState().messagesByTask[task.id][0].toolCalls).toEqual([replacement]);
    expect(h.persistMessage).toHaveBeenLastCalledWith(expect.objectContaining({ toolCalls: [replacement] }));
  });

  it('retries the same canonical UUID before consuming a late tool update', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.store.getState().bulkLoad(task.id, [canonical(task.sessionKey, 'run-old', 'old')]);
    h.persistMessage.mockRejectedValueOnce(new Error('disk busy'));
    const job = h.sync.syncSessionMessages(task.id, task.sessionKey, {
      gatewayId: task.gatewayId,
      runId: 'run-old',
      toolCall,
    });
    await vi.runAllTimersAsync();
    await job;
    expect(h.persistMessage).toHaveBeenCalledTimes(2);
    expect(h.persistMessage).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'old', toolCalls: [toolCall] }));
    await h.sync.syncSessionMessages(task.id);
    expect(h.persistMessage).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])('accepts a parse-unknown session only with existing exact ownership: %s', async (owned) => {
    const h = harness();
    const subagent = 'agent:worker:subagent:child';
    if (owned) h.store.getState().bulkLoad(task.id, [canonical(subagent, 'run-old', 'old')]);
    await h.sync.syncSessionMessages(task.id, subagent, { gatewayId: task.gatewayId, runId: 'run-old', toolCall });
    expect(h.persistMessage).toHaveBeenCalledTimes(owned ? 1 : 0);
  });
  it('reports a known same-millisecond run collision without overwriting the persisted run or clearing the new active turn', async () => {
    const h = harness();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      h.store.getState().bulkLoad(task.id, [canonical(task.sessionKey, 'old-run', 'new')]);
      h.store.getState().bindActiveRun(task.sessionKey, 'new-run');
      h.store.getState().appendStreamDelta(task.sessionKey, 'new answer');
      h.setHistory([
        {
          role: 'assistant',
          timestamp: 2000,
          __openclaw: { runId: 'new-run' },
          content: [{ type: 'text', text: 'new answer' }],
        },
      ]);
      await h.sync.syncSessionMessages(task.id);
      expect(h.store.getState().activeTurnBySession[task.sessionKey]?.streamingText).toBe('new answer');
      expect(h.persistMessage).not.toHaveBeenCalled();
      expect(warning).toHaveBeenCalledWith(
        '[sync] canonical timestamp collision between distinct runs',
        expect.any(Object),
      );
    } finally {
      warning.mockRestore();
    }
  });
  it('recovers a missing older canonical reply from history after a newer reply is already persisted', async () => {
    const h = harness();
    h.store.getState().bulkLoad(task.id, [canonical(task.sessionKey, 'run-new', 'new')]);
    h.setHistory([
      {
        role: 'assistant',
        timestamp: 1000,
        __openclaw: { runId: 'run-old' },
        content: [{ type: 'text', text: 'old answer' }],
      },
    ]);
    await h.sync.syncSessionMessages(task.id);
    await h.sync.syncSessionMessages(task.id);
    expect(h.store.getState().messagesByTask[task.id]).toHaveLength(2);
    expect(h.persistMessage).toHaveBeenCalledTimes(1);
  });
  it('recovers a delayed older run without discarding the newer canonical or active run', async () => {
    const h = harness();
    h.store.getState().bulkLoad(task.id, [canonical(task.sessionKey, 'run-new', 'new')]);
    h.store.getState().bindActiveRun(task.sessionKey, 'run-active');
    h.store.getState().appendStreamDelta(task.sessionKey, 'still working');
    await h.sync.syncSessionMessages(task.id, task.sessionKey, {
      gatewayId: task.gatewayId,
      runId: 'run-old',
      toolCall,
    });
    h.setHistory([
      {
        role: 'assistant',
        timestamp: 1000,
        __openclaw: { runId: 'run-old' },
        content: [{ type: 'text', text: 'old answer' }],
      },
    ]);
    await h.sync.syncSessionMessages(task.id);
    expect(h.store.getState().messagesByTask[task.id]).toHaveLength(2);
    expect(
      h.store.getState().messagesByTask[task.id].find((message) => message.runId === 'run-old')?.toolCalls,
    ).toEqual([toolCall]);
    expect(h.store.getState().activeTurnBySession[task.sessionKey]?.streamingText).toBe('still working');
  });

  it.each([1, 2])(
    'accepts a runless canonical only when the tool ID identifies exactly one same-session message: %i',
    async (count) => {
      const h = harness();
      h.store.getState().bulkLoad(
        task.id,
        Array.from({ length: count }, (_, index) => ({
          ...canonical(task.sessionKey, '', `legacy-${index}`),
          runId: undefined,
          toolCalls: [{ ...toolCall, status: 'running' as const, result: undefined }],
        })),
      );
      await h.sync.syncSessionMessages(task.id, task.sessionKey, {
        gatewayId: task.gatewayId,
        runId: 'run-old',
        toolCall,
      });
      expect(h.persistMessage).toHaveBeenCalledTimes(count === 1 ? 1 : 0);
    },
  );

  it('bounds retained runs and reports overflow', async () => {
    const h = harness();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (let index = 0; index < 129; index++)
        await h.sync.syncSessionMessages(task.id, task.sessionKey, {
          gatewayId: task.gatewayId,
          runId: `run-${index}`,
          toolCall,
        });
      h.store
        .getState()
        .bulkLoad(task.id, [canonical(task.sessionKey, 'run-0', 'old'), canonical(task.sessionKey, 'run-128', 'new')]);
      await h.sync.syncSessionMessages(task.id);
      expect(h.store.getState().messagesByTask[task.id][0].toolCalls).toEqual([]);
      expect(h.store.getState().messagesByTask[task.id][1].toolCalls).toEqual([toolCall]);
      expect(warning).toHaveBeenCalledWith('[sync] late tool run buffer reached its limit');
    } finally {
      warning.mockRestore();
    }
  });
  it('persists a late tool only on its exact session and run canonical message', async () => {
    const h = harness();
    const worker = buildSessionKey(task.id, 'worker');
    h.store
      .getState()
      .bulkLoad(task.id, [canonical(task.sessionKey, 'run-old', 'old'), canonical(worker, 'run-worker', 'worker')]);
    await h.sync.syncSessionMessages(task.id, task.sessionKey, {
      gatewayId: task.gatewayId,
      runId: 'run-old',
      toolCall,
    });
    expect(h.store.getState().messagesByTask[task.id][0].toolCalls).toEqual([toolCall]);
    expect(h.store.getState().messagesByTask[task.id][1].toolCalls).toEqual([]);
    expect(h.persistMessage).toHaveBeenCalledTimes(1);
    expect(h.persistMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'old', sessionKey: task.sessionKey, runId: 'run-old', toolCalls: [toolCall] }),
    );
  });

  it('retains a late result until its canonical run appears in history', async () => {
    const h = harness();
    await h.sync.syncSessionMessages(task.id, task.sessionKey, {
      gatewayId: task.gatewayId,
      runId: 'run-old',
      toolCall,
    });
    expect(h.persistMessage).not.toHaveBeenCalled();
    h.setHistory([
      {
        role: 'assistant',
        timestamp: 1000,
        __openclaw: { runId: 'run-old' },
        content: [{ type: 'text', text: 'answer' }],
      },
    ]);
    await h.sync.syncSessionMessages(task.id);
    expect(h.store.getState().messagesByTask[task.id][0].toolCalls).toEqual([toolCall]);
    expect(h.persistMessage).toHaveBeenCalledTimes(1);
  });

  it('does not queue or persist foreign gateway metadata', async () => {
    const h = harness();
    h.store.getState().bulkLoad(task.id, [canonical(task.sessionKey, 'run-old', 'old')]);
    await h.sync.syncSessionMessages(task.id, task.sessionKey, { gatewayId: 'foreign', runId: 'run-old', toolCall });
    expect(h.store.getState().messagesByTask[task.id][0].toolCalls).toEqual([]);
    expect(h.persistMessage).not.toHaveBeenCalled();
  });

  it('clears retained tool metadata when the sync instance resets', async () => {
    const h = harness();
    await h.sync.syncSessionMessages(task.id, task.sessionKey, {
      gatewayId: task.gatewayId,
      runId: 'run-old',
      toolCall,
    });
    h.sync.resetHydration();
    h.setHistory([
      {
        role: 'assistant',
        timestamp: 1000,
        __openclaw: { runId: 'run-old' },
        content: [{ type: 'text', text: 'answer' }],
      },
    ]);
    await h.sync.syncSessionMessages(task.id);
    expect(h.store.getState().messagesByTask[task.id][0].toolCalls).toEqual([]);
  });

  it('never persists an assistant from the message-store tool update path', () => {
    const h = harness();
    h.store.getState().bulkLoad(task.id, [canonical(task.sessionKey, 'run-old', 'old')]);
    h.store.getState().upsertToolCall(task.sessionKey, task.id, toolCall);
    expect(h.persistMessage).not.toHaveBeenCalled();
    expect(h.store.getState().messagesByTask[task.id][0].toolCalls).toEqual([]);
  });
});
