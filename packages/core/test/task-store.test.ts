import { describe, expect, it, vi } from 'vitest';
import { createTaskStore } from '../src/stores/task-store';
import { buildSessionKey, type Task, type IpcResult } from '@clawwork/shared';

function setup() {
  const persistTask = vi.fn(async () => ({ ok: true as const }));
  const deleteTask = vi.fn<() => Promise<IpcResult>>().mockResolvedValue({ ok: true });
  const patchSession = vi.fn(async () => ({ ok: true as const }));
  const loadTasks = vi
    .fn<Parameters<typeof createTaskStore>[0]['loadTasks']>()
    .mockResolvedValue({ ok: true, rows: [] });
  const getDeviceId = vi.fn(async () => 'device-1');
  const store = createTaskStore({
    persistTask,
    persistTaskUpdate: vi.fn(async () => ({ ok: true as const })),
    deleteTask,
    loadTasks,
    patchSession,
    getDeviceId,
    getDefaultGatewayId: () => 'gw-1',
    getAgentCatalog: () => ({ agents: [{ id: 'main' }], defaultId: 'main' }),
  });
  return { store, persistTask, deleteTask, patchSession, loadTasks, getDeviceId };
}

describe('task store pending task metadata', () => {
  it.each(['device', 'tasks'])('ignores prior workspace hydration while awaiting %s', async (phase) => {
    const h = setup();
    const replacement = h.store.getState().createTask();
    let releaseDevice!: (value: string) => void;
    let releaseTasks!: (value: Awaited<ReturnType<typeof h.loadTasks>>) => void;
    if (phase === 'device') {
      h.getDeviceId.mockReturnValueOnce(
        new Promise((resolve) => {
          releaseDevice = resolve;
        }),
      );
    } else {
      h.loadTasks.mockReturnValueOnce(
        new Promise((resolve) => {
          releaseTasks = resolve;
        }),
      );
    }
    const pending = h.store.getState().hydrate();
    await Promise.resolve();
    h.store.getState().resetWorkspace();
    h.store.getState().registerPersistedTasks([replacement]);
    if (phase === 'device') releaseDevice('old-device');
    else releaseTasks({ ok: true, rows: [] });
    await pending;

    expect(h.store.getState().tasks).toEqual([replacement]);
    expect(h.store.getState().hydrated).toBe(false);
    if (phase === 'device') expect(h.loadTasks).not.toHaveBeenCalled();
    const next = h.store.getState().createTask();
    expect(next.sessionKey).toBe(buildSessionKey(next.id, 'main'));
  });

  it('registers atomically persisted tasks without a second write or session patch', () => {
    const h = setup();
    const task: Task = {
      id: 'saved',
      sessionKey: buildSessionKey('saved'),
      sessionId: '',
      title: 'Summary',
      status: 'active',
      createdAt: '2026-09-30',
      updatedAt: '2026-09-30',
      tags: [],
      artifactDir: '',
      gatewayId: 'gw-1',
      model: 'selected',
      thinkingLevel: 'high',
    };
    h.store.getState().registerPersistedTasks([task], task.id);
    h.store.getState().registerPersistedTasks([task]);
    expect(h.store.getState().tasks).toEqual([task]);
    expect(h.store.getState().activeTaskId).toBe(task.id);
    expect(h.persistTask).not.toHaveBeenCalled();
    expect(h.patchSession).not.toHaveBeenCalled();
  });

  it('waits for acknowledged deletion before removing task selection', async () => {
    const h = setup();
    const task = h.store.getState().createTask();
    let release!: (value: IpcResult) => void;
    h.deleteTask.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = h.store.getState().removeTask(task.id);
    expect(h.store.getState().tasks).toContain(task);
    expect(h.store.getState().activeTaskId).toBe(task.id);
    release({ ok: true });
    await pending;
    expect(h.store.getState().tasks).toEqual([]);
    expect(h.store.getState().activeTaskId).toBeNull();
  });

  it('retains the task and reports a main-process deletion refusal', async () => {
    const h = setup();
    const task = h.store.getState().createTask();
    h.deleteTask.mockResolvedValueOnce({ ok: false, error: 'active meeting' });
    await expect(h.store.getState().removeTask(task.id)).rejects.toThrow('active meeting');
    expect(h.store.getState().tasks).toContain(task);
    expect(h.store.getState().activeTaskId).toBe(task.id);
  });
  it('rejects a stale deletion acknowledgment without touching replacement workspace tasks', async () => {
    const h = setup();
    const task = h.store.getState().createTask();
    let release!: (value: IpcResult) => void;
    h.deleteTask.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = h.store.getState().removeTask(task.id);
    const replacement = { ...task, sessionKey: buildSessionKey(task.id, 'other') };
    h.store.setState({ tasks: [replacement] });
    release({ ok: true });
    await expect(pending).rejects.toThrow();
    expect(h.store.getState().tasks).toEqual([replacement]);
  });
  it('finishes acknowledged deletion after a normal metadata update of the same task', async () => {
    const h = setup();
    const task = h.store.getState().createTask();
    let release!: (value: IpcResult) => void;
    h.deleteTask.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = h.store.getState().removeTask(task.id);
    h.store.getState().updateTaskMetadata(task.id, { inputTokens: 42 });
    release({ ok: true });
    await pending;
    expect(h.store.getState().tasks).toEqual([]);
  });
  it('rejects a prior workspace deletion even when replacement ownership is identical', async () => {
    const h = setup();
    const task = h.store.getState().createTask();
    let release!: (value: IpcResult) => void;
    h.deleteTask.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = h.store.getState().removeTask(task.id);
    h.store.getState().resetWorkspace();
    h.store.getState().registerPersistedTasks([{ ...task }]);
    release({ ok: true });
    await expect(pending).rejects.toThrow();
    expect(h.store.getState().tasks).toEqual([task]);
  });
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

  it('hydrates persisted team tasks as direct while preserving non-team ensemble tasks', async () => {
    const row = (id: string, teamId?: string) => ({
      id,
      sessionKey: `agent:main:clawwork:task:${id}`,
      sessionId: '',
      title: id,
      status: 'active',
      ensemble: true,
      teamId,
      createdAt: '2026-09-17T00:00:00.000Z',
      updatedAt: '2026-09-17T00:00:00.000Z',
      tags: [],
      artifactDir: '',
      gatewayId: 'gw-1',
    });
    const store = createTaskStore({
      persistTask: vi.fn(async () => ({ ok: true as const })),
      persistTaskUpdate: vi.fn(async () => ({ ok: true as const })),
      deleteTask: vi.fn(async () => ({ ok: true as const })),
      loadTasks: vi.fn(async () => ({
        ok: true,
        rows: [row('team-task', 'team-design'), row('ensemble-task')],
      })),
      patchSession: vi.fn(async () => ({ ok: true as const })),
      getDeviceId: vi.fn(async () => 'device-1'),
      getDefaultGatewayId: () => 'gw-1',
      getAgentCatalog: () => ({ agents: [{ id: 'main' }], defaultId: 'main' }),
    });

    await store.getState().hydrate();

    expect(store.getState().tasks.find((task) => task.id === 'team-task')?.ensemble).toBe(false);
    expect(store.getState().tasks.find((task) => task.id === 'ensemble-task')?.ensemble).toBe(true);
  });
});
