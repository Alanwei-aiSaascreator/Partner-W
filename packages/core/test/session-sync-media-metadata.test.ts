import { describe, expect, it, vi } from 'vitest';
import { buildSessionKey, type IpcResult } from '@clawwork/shared';
import { createSessionSync, type SessionSyncDeps } from '../src/services/session-sync.js';
import { createMessageStore } from '../src/stores/message-store.js';

describe('canonical media metadata enrichment', () => {
  it.each([undefined, 'run-old', 'run-new'])(
    'accepts only compatible discovered media ownership: %s',
    async (runId) => {
      const sessionKey = buildSessionKey('task-1');
      const task = { id: 'task-1', gatewayId: 'gw-1', sessionKey };
      const original = { fileName: 'clip.mp4', dataUrl: 'https://example.com/clip.mp4', mimeType: 'video/mp4' };
      const incoming = { ...original, artifactId: 'artifact_managed_media_fixture' };
      const persist = vi.fn<SessionSyncDeps['persistence']['persistMessage']>().mockResolvedValue({ ok: true });
      const store = createMessageStore({ persistMessage: persist });
      store.getState().bulkLoad(task.id, [
        {
          id: 'canonical-id',
          taskId: task.id,
          role: 'assistant',
          content: '',
          timestamp: new Date(1000).toISOString(),
          sessionKey,
          runId: 'run-old',
          attachments: [original],
          artifacts: [],
          toolCalls: [],
        },
      ]);
      const sync = createSessionSync({
        persistence: { persistMessage: persist, loadMessages: async () => ({ ok: true, rows: [] }) },
        gateway: {
          chatHistory: async () => ({ ok: true, result: { messages: [] } }),
          syncSessions: async () => ({
            ok: true,
            discovered: [
              {
                ...task,
                taskId: task.id,
                title: 'QA',
                updatedAt: new Date(1000).toISOString(),
                agentId: 'main',
                messages: [
                  {
                    role: 'assistant',
                    content: '',
                    timestamp: new Date(1000).toISOString(),
                    runId,
                    attachments: [incoming],
                  },
                ],
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
        getMessageStore: () => ({ ...store.getState(), setState: store.setState }),
      });
      await sync.syncFromGateway();
      expect(persist).toHaveBeenCalledTimes(runId === 'run-new' ? 0 : 1);
      expect(store.getState().messagesByTask[task.id][0]).toMatchObject({
        id: 'canonical-id',
        runId: 'run-old',
        attachments: [runId === 'run-new' ? original : incoming],
      });
    },
  );

  it.each(['session', 'discovery'] as const)('acknowledges %s same-URL metadata on the existing UUID', async (path) => {
    const sessionKey = buildSessionKey('task-1');
    const task = { id: 'task-1', gatewayId: 'gw-1', sessionKey };
    const original = {
      fileName: 'clip.mp4',
      dataUrl: 'https://example.com/clip.mp4',
      mimeType: 'video/mp4',
      localPath: 'qa/clip.mp4',
    };
    const incoming = { ...original, artifactId: 'artifact_managed_media_fixture' };
    const persist = vi.fn<SessionSyncDeps['persistence']['persistMessage']>().mockResolvedValue({ ok: true });
    const store = createMessageStore({ persistMessage: persist });
    store.getState().bulkLoad(task.id, [
      {
        id: 'canonical-id',
        taskId: task.id,
        role: 'assistant',
        content: '',
        timestamp: new Date(1000).toISOString(),
        sessionKey,
        runId: 'run-old',
        attachments: [original],
        artifacts: [],
        toolCalls: [],
      },
    ]);
    store.getState().bindActiveRun(sessionKey, 'run-new');
    store.getState().appendStreamDelta(sessionKey, 'new answer');
    const active = store.getState().activeTurnBySession[sessionKey];
    let acknowledge!: (result: IpcResult) => void;
    persist.mockReturnValueOnce(
      new Promise((resolve) => {
        acknowledge = resolve;
      }),
    );
    const sync = createSessionSync({
      persistence: { persistMessage: persist, loadMessages: async () => ({ ok: true, rows: [] }) },
      gateway: {
        chatHistory: async () => ({
          ok: true,
          result: {
            messages: [
              {
                role: 'assistant',
                timestamp: 1000,
                __openclaw: { runId: 'run-old' },
                content: [
                  {
                    type: 'video',
                    url: incoming.dataUrl,
                    fileName: incoming.fileName,
                    mimeType: incoming.mimeType,
                    artifactId: incoming.artifactId,
                  },
                ],
              },
            ],
          },
        }),
        syncSessions: async () => ({
          ok: true,
          discovered: [
            {
              ...task,
              taskId: task.id,
              title: 'QA',
              updatedAt: new Date(1000).toISOString(),
              agentId: 'main',
              messages: [
                { role: 'assistant', content: '', timestamp: new Date(1000).toISOString(), attachments: [incoming] },
              ],
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
      getMessageStore: () => ({ ...store.getState(), setState: store.setState }),
    });
    const refresh = () => (path === 'session' ? sync.syncSessionMessages(task.id) : sync.syncFromGateway());
    let settled = false;
    const job = refresh().then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1));
    expect(settled).toBe(false);
    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'canonical-id', runId: 'run-old', attachments: [incoming] }),
    );
    acknowledge({ ok: true });
    await job;
    await refresh();
    expect(persist).toHaveBeenCalledTimes(1);
    expect(store.getState().messagesByTask[task.id]).toHaveLength(1);
    expect(store.getState().messagesByTask[task.id][0].attachments).toEqual([incoming]);
    expect(store.getState().activeTurnBySession[sessionKey]).toEqual(active);
  });
});
