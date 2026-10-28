import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSessionKey } from '@clawwork/shared';
import { createMessageStore } from '../src/stores/message-store.js';
import { createSessionSync } from '../src/services/session-sync.js';
import { createGatewayDispatcher } from '../src/services/gateway-dispatcher.js';
import type { GatewayDispatcherDeps } from '../src/services/gateway-dispatcher.js';
import type { GatewayEvent } from '../src/ports/gateway-transport.js';

const task = { id: 'task-1', title: 'Task', gatewayId: 'gw-1', sessionKey: buildSessionKey('task-1', 'main') };
const workerKey = buildSessionKey(task.id, 'worker');
const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

function harness() {
  const persistMessage = vi.fn(async () => ({ ok: true }));
  const store = createMessageStore({ persistMessage });
  const getMessageStore = () => ({ ...store.getState(), setState: store.setState });
  const seed = (sessionKey: string, timestamp: number) =>
    store.getState().bulkLoad(task.id, [
      {
        id: 'existing',
        taskId: task.id,
        role: 'assistant',
        content: 'existing',
        sessionKey,
        timestamp: new Date(timestamp).toISOString(),
        artifacts: [],
        toolCalls: [],
      },
    ]);
  return { store, persistMessage, getMessageStore, seed };
}

describe('gateway and session ownership boundaries', () => {
  it.each(['chat', 'agent'])('rejects foreign gateway %s frames before mutating the real store', (event) => {
    const h = harness();
    let listener: (event: GatewayEvent) => void = () => {};
    const notifyAgentResponse = vi.fn();
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
      getMessageStore: h.getMessageStore,
      getActiveTaskId: () => task.id,
      markUnread: vi.fn(),
      getSettings: async () => null,
      sendNotification: async () => {},
      isWindowFocused: () => true,
      translate: (key: string) => key,
      reportDebugEvent: () => {},
      notifyAgentResponse,
      syncSessionMessages: vi.fn(async () => {}),
    } as unknown as GatewayDispatcherDeps);
    const stop = dispatcher.start();
    cleanups.push(() => {
      stop();
      dispatcher.reset();
    });
    const payload =
      event === 'chat'
        ? { sessionKey: task.sessionKey, runId: 'run-1', state: 'delta', deltaText: 'answer' }
        : { sessionKey: task.sessionKey, runId: 'run-1', stream: 'thinking', data: { text: 'thinking' } };
    listener({ event, payload, gatewayId: 'gw-foreign' });
    expect(h.store.getState().activeTurnBySession[task.sessionKey]).toBeUndefined();
    expect(notifyAgentResponse).not.toHaveBeenCalled();
    expect(h.persistMessage).not.toHaveBeenCalled();
    listener({ event, payload, gatewayId: task.gatewayId });
    expect(h.store.getState().activeTurnBySession[task.sessionKey]).toBeDefined();
  });

  it.each(['runtime', 'discovered'])('keeps equal or earlier worker history in its own session: %s', async (source) => {
    const h = harness();
    h.seed(task.sessionKey, source === 'runtime' ? 3000 : 2000);
    const sync = createSessionSync({
      persistence: { persistMessage: h.persistMessage, loadMessages: async () => ({ ok: true, rows: [] }) },
      gateway: {
        chatHistory: async () => ({
          ok: true,
          result: {
            messages: [{ role: 'assistant', timestamp: 2000, content: [{ type: 'text', text: 'worker answer' }] }],
          },
        }),
        syncSessions: async () => ({
          ok: true,
          discovered: [
            {
              ...task,
              taskId: task.id,
              sessionKey: workerKey,
              agentId: 'worker',
              updatedAt: new Date(2000).toISOString(),
              messages: [{ role: 'assistant', timestamp: new Date(2000).toISOString(), content: 'worker answer' }],
            },
          ],
        }),
      },
      getTaskStore: () => ({
        tasks: [task],
        hydrate: async () => {},
        adoptTasks: () => {},
        updateTaskMetadata: () => {},
      }),
      getMessageStore: h.getMessageStore,
    });
    for (let replay = 0; replay < 2; replay++) {
      if (source === 'runtime') await sync.syncSessionMessages(task.id, workerKey);
      else await sync.syncFromGateway();
    }
    expect(h.store.getState().messagesByTask[task.id]).toHaveLength(2);
    expect(h.persistMessage).toHaveBeenCalledTimes(1);
    expect(h.persistMessage).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: workerKey, content: 'worker answer' }),
    );
  });
});
