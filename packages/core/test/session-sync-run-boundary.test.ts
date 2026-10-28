import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createMessageStore, mergeCanonicalMessageWithActiveTurn } from '../src/stores/message-store';
import { createSessionSync } from '../src/services/session-sync';
import type { Message } from '@clawwork/shared';

const history = JSON.parse(readFileSync(new URL('./fixtures/video-async-history.json', import.meta.url), 'utf8'));
const sessionKey = 'agent:main:clawwork:task:task-1';

describe('canonical history run boundaries', () => {
  it.each(['run-old', 'run-new'])(
    'does not clear another known active run on unchanged history: %s',
    async (activeRun) => {
      const persistMessage = vi.fn(async () => ({ ok: true }));
      const store = createMessageStore({ persistMessage });
      const active = {
        id: 'active',
        runId: activeRun,
        timestamp: '2026-09-30T00:00:02Z',
        content: '',
        streamingText: 'working',
        streamingThinking: '',
        finalized: false,
        toolCalls: [],
      };
      store.setState({
        activeTurnBySession: { [sessionKey]: active },
        messagesByTask: {
          'task-1': [
            {
              id: 'old',
              taskId: 'task-1',
              role: 'assistant',
              content: 'old',
              timestamp: new Date(1000).toISOString(),
              sessionKey,
              runId: 'run-old',
              artifacts: [],
              toolCalls: [],
            },
          ],
        },
      });
      const sync = createSessionSync({
        persistence: { loadMessages: async () => ({ ok: true, rows: [] }), persistMessage },
        gateway: {
          chatHistory: async () => ({
            ok: true,
            result: {
              messages: [
                {
                  role: 'assistant',
                  timestamp: 1000,
                  __openclaw: { runId: 'run-old' },
                  content: [{ type: 'text', text: 'old' }],
                },
              ],
            },
          }),
          syncSessions: async () => ({ ok: true, discovered: [] }),
        },
        getTaskStore: () => ({
          tasks: [{ id: 'task-1', gatewayId: 'gateway-1', sessionKey }],
          hydrate: async () => {},
          adoptTasks: () => {},
          updateTaskMetadata: () => {},
        }),
        getMessageStore: () => ({ ...store.getState(), setState: store.setState }),
      });
      await sync.syncSessionMessages('task-1');
      expect(store.getState().activeTurnBySession[sessionKey]).toEqual(activeRun === 'run-new' ? active : undefined);
      expect(persistMessage).not.toHaveBeenCalled();
    },
  );

  it('retains the newer active run when promoting an older canonical run', () => {
    const store = createMessageStore({ persistMessage: vi.fn(async () => ({ ok: true })) });
    const active = {
      id: 'active',
      runId: 'run-new',
      timestamp: '2026-09-30T00:00:02Z',
      content: '',
      streamingText: 'still working',
      streamingThinking: '',
      finalized: false,
      toolCalls: [{ id: 'tool-new', name: 'exec', status: 'running' as const, startedAt: '' }],
    };
    store.setState({ activeTurnBySession: { [sessionKey]: active } });
    store.getState().promoteActiveTurn(sessionKey, 'task-1', {
      id: 'old-message',
      taskId: 'task-1',
      role: 'assistant',
      runId: 'run-old',
      content: 'old complete',
      timestamp: '2026-09-30T00:00:01Z',
      artifacts: [],
      toolCalls: [],
    });
    expect(store.getState().activeTurnBySession[sessionKey]).toEqual(active);
    expect(store.getState().messagesByTask['task-1'][0]).toMatchObject({
      id: 'old-message',
      runId: 'run-old',
      toolCalls: [],
    });
  });

  it('persists actual video history with each tool on its own run and remains idempotent', async () => {
    const persistMessage = vi.fn(async () => ({ ok: true }));
    const store = createMessageStore({ persistMessage });
    const sync = createSessionSync({
      persistence: { loadMessages: async () => ({ ok: true, rows: [] }), persistMessage },
      gateway: {
        getHttpBase: () => 'http://127.0.0.1:18789',
        chatHistory: async () => ({ ok: true, result: { messages: history } }),
        syncSessions: async () => ({ ok: true, discovered: [] }),
      },
      getTaskStore: () => ({
        tasks: [{ id: 'task-1', gatewayId: 'gateway-1', sessionKey }],
        hydrate: async () => {},
        adoptTasks: () => {},
        updateTaskMetadata: () => {},
      }),
      getMessageStore: () => ({ ...store.getState(), setState: store.setState }),
    });
    await sync.syncSessionMessages('task-1');
    await sync.syncSessionMessages('task-1');
    const messages = store.getState().messagesByTask['task-1'];
    expect(messages).toHaveLength(3);
    expect(messages[0].runId).toBe('6c0b1c10-3e13-4d84-aa0b-8db0f6ab60ef');
    expect(messages[0].toolCalls[0]).toMatchObject({ status: 'done' });
    expect(messages[1].runId).toBe('video_generate:eaebdb9c-f6e3-46cb-94a9-fa3e2718eff8:ok:agent-loop');
    expect(messages[1].toolCalls).toEqual([]);
    expect(messages[2].toolCalls).toEqual([]);
    expect(persistMessage).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['run-a', 'run-b', false],
    ['run-a', 'run-a', true],
    ['run-a', undefined, true],
    [undefined, 'run-b', false],
    [undefined, undefined, true],
  ] as const)('merges active tools only for compatible known runs %s / %s', (canonicalRun, activeRun, compatible) => {
    const canonical: Message = {
      id: 'message-1',
      taskId: 'task-1',
      role: 'assistant',
      content: 'canonical',
      timestamp: '2026-09-30T00:00:00Z',
      runId: canonicalRun,
      artifacts: [],
      toolCalls: [],
    };
    const active = {
      id: 'active',
      runId: activeRun,
      timestamp: '2026-09-30T00:00:00Z',
      content: '',
      streamingText: '',
      streamingThinking: '',
      thinkingContent: 'live thinking',
      finalized: true,
      toolCalls: [{ id: 'same-id', name: 'exec', status: 'done' as const, startedAt: '', result: 'live result' }],
    };
    const merged = mergeCanonicalMessageWithActiveTurn(canonical, active);
    expect(merged.toolCalls).toHaveLength(compatible ? 1 : 0);
    expect(merged.runId).toBe(compatible ? (activeRun ?? canonicalRun) : canonicalRun);
    expect(merged.thinkingContent).toBe(compatible ? 'live thinking' : undefined);
  });
});
