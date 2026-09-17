import { describe, expect, it, vi } from 'vitest';
import { createTaskStore } from '../src/stores/task-store';

function setup() {
  const persistTask = vi.fn(async () => ({ ok: true as const }));
  const store = createTaskStore({
    persistTask,
    persistTaskUpdate: vi.fn(async () => ({ ok: true as const })),
    deleteTask: vi.fn(async () => ({ ok: true as const })),
    loadTasks: vi.fn(async () => ({ ok: true, rows: [] })),
    patchSession: vi.fn(async () => ({ ok: true as const })),
    getDeviceId: vi.fn(async () => 'device-1'),
    getDefaultGatewayId: () => 'gw-1',
    getAgentCatalog: () => ({ agents: [{ id: 'main' }], defaultId: 'main' }),
  });
  return { store, persistTask };
}

describe('task store pending task metadata', () => {
  it('preserves the selected model and thinking level when committing a pending task', () => {
    const { store, persistTask } = setup();

    store.getState().startNewTask({
      model: 'deepseek-v4-flash',
      thinkingLevel: 'high',
    });
    const task = store.getState().commitPendingTask();

    expect(task).toEqual(
      expect.objectContaining({
        model: 'deepseek-v4-flash',
        thinkingLevel: 'high',
      }),
    );
    expect(persistTask).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'deepseek-v4-flash',
        thinkingLevel: 'high',
      }),
    );
  });

  it('persists pending task tags when the task is committed', () => {
    const { store, persistTask } = setup();

    store.getState().startNewTask({
      tags: ['private', 'assistant-task-preset:content:short-video-script'],
    });
    const task = store.getState().commitPendingTask();

    expect(task.tags).toEqual(['private', 'assistant-task-preset:content:short-video-script']);
    expect(persistTask).toHaveBeenCalledWith(
      expect.objectContaining({
        tags: ['private', 'assistant-task-preset:content:short-video-script'],
      }),
    );
  });

  it('hydrates persisted task tags without losing them', async () => {
    const tags = ['private', 'assistant-task-preset:video:storyboard'];
    const store = createTaskStore({
      persistTask: vi.fn(async () => ({ ok: true as const })),
      persistTaskUpdate: vi.fn(async () => ({ ok: true as const })),
      deleteTask: vi.fn(async () => ({ ok: true as const })),
      loadTasks: vi.fn(async () => ({
        ok: true,
        rows: [
          {
            id: 'task-1',
            sessionKey: 'agent:main:clawwork:task:task-1',
            sessionId: '',
            title: 'Persisted task',
            status: 'active',
            createdAt: '2026-09-17T00:00:00.000Z',
            updatedAt: '2026-09-17T00:00:00.000Z',
            tags,
            artifactDir: '',
            gatewayId: 'gw-1',
          },
        ],
      })),
      patchSession: vi.fn(async () => ({ ok: true as const })),
      getDeviceId: vi.fn(async () => 'device-1'),
      getDefaultGatewayId: () => 'gw-1',
      getAgentCatalog: () => ({ agents: [{ id: 'main' }], defaultId: 'main' }),
    });

    await store.getState().hydrate();

    expect(store.getState().tasks[0]?.tags).toEqual(tags);
  });
});
