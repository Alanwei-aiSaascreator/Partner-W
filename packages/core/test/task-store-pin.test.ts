import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTaskStore } from '../src/stores/task-store';

/**
 * 任务置顶。
 *
 * ⚠️ 本文件最重要的一条是**置顶不许动 `updatedAt`**：
 * 置顶是"我要它一直在眼前"，不是"这个任务有活动"。要是顺手刷新了更新时间，
 * 取消置顶的那一刻它会凭着一个假的新鲜度插回列表最前面 —— 用户会以为没取消掉。
 */
function setup() {
  const persistTaskUpdate = vi.fn(async () => ({ ok: true as const }));
  const store = createTaskStore({
    persistTask: vi.fn(async () => ({ ok: true as const })),
    persistTaskUpdate,
    deleteTask: vi.fn(async () => ({ ok: true as const })),
    loadTasks: vi.fn(async () => ({ ok: true, rows: [] })),
    patchSession: vi.fn(async () => ({ ok: true as const })),
    getDeviceId: vi.fn(async () => 'device-1'),
    getDefaultGatewayId: () => 'gw-1',
    getAgentCatalog: () => ({ agents: [{ id: 'main' }], defaultId: 'main' }),
  });

  const task = store.getState().commitPendingTask()!;
  persistTaskUpdate.mockClear();
  return { store, task, persistTaskUpdate };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('task store —— 置顶', () => {
  it('⭐ 置顶写上 pinnedAt，但**不动 updatedAt**', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T10:00:00.000Z'));
    const { store, task } = setup();
    const before = store.getState().tasks.find((t) => t.id === task.id)!.updatedAt;

    store.getState().setTaskPinned(task.id, true);

    const after = store.getState().tasks.find((t) => t.id === task.id)!;
    expect(after.pinnedAt).toBe('2026-09-18T10:00:00.000Z');
    expect(after.updatedAt, '置顶是"我要它一直在眼前"，不是"这个任务有活动"').toBe(before);
  });

  it('落库时带 pinnedAt，且带的是**原来的** updatedAt（不是现在）', () => {
    const { store, task, persistTaskUpdate } = setup();
    const before = store.getState().tasks.find((t) => t.id === task.id)!.updatedAt;

    store.getState().setTaskPinned(task.id, true);

    expect(persistTaskUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: task.id, pinnedAt: expect.any(String), updatedAt: before }),
    );
  });

  it('⭐ 取消置顶 = 清掉字段，并往库里写 null（否则重启会"复活"）', () => {
    const { store, task, persistTaskUpdate } = setup();
    store.getState().setTaskPinned(task.id, true);
    const updatedAtAfterPin = store.getState().tasks.find((t) => t.id === task.id)!.updatedAt;

    store.getState().setTaskPinned(task.id, false);

    expect(store.getState().tasks.find((t) => t.id === task.id)!.pinnedAt).toBeUndefined();
    expect(persistTaskUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: task.id, pinnedAt: null, updatedAt: updatedAtAfterPin }),
    );
  });

  it('重复置顶会刷新置顶时间（最近置顶的排最前）', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T10:00:00.000Z'));
    const { store, task } = setup();
    store.getState().setTaskPinned(task.id, true);

    vi.setSystemTime(new Date('2026-09-18T11:00:00.000Z'));
    store.getState().setTaskPinned(task.id, true);

    expect(store.getState().tasks.find((t) => t.id === task.id)!.pinnedAt).toBe('2026-09-18T11:00:00.000Z');
  });

  it('认不出的 id 是空操作（不落库、不抛）', () => {
    const { store, persistTaskUpdate } = setup();

    expect(() => store.getState().setTaskPinned('没这个任务', true)).not.toThrow();
    expect(persistTaskUpdate).not.toHaveBeenCalled();
  });

  it('⭐ 重启后置顶还在（hydrate 是**逐字段**映射的，漏一个字段就等于功能失效）', async () => {
    // 这条是这类"加一列"的功能最典型的暗坑：写库那侧通了、读回来却没带上，
    // 用户看到的是"置顶根本不管用"。所以必须拿**从库里读出来的行**钉一遍。
    const store = createTaskStore({
      persistTask: vi.fn(async () => ({ ok: true as const })),
      persistTaskUpdate: vi.fn(async () => ({ ok: true as const })),
      deleteTask: vi.fn(async () => ({ ok: true as const })),
      loadTasks: vi.fn(async () => ({
        ok: true,
        rows: [
          {
            id: 't-pinned',
            sessionKey: 'k',
            sessionId: 's',
            title: '置顶过的任务',
            status: 'active',
            createdAt: '2026-09-01T00:00:00.000Z',
            updatedAt: '2026-09-01T00:00:00.000Z',
            tags: [],
            artifactDir: '',
            gatewayId: 'gw-1',
            pinnedAt: '2026-09-18T10:00:00.000Z',
          },
        ],
      })),
      patchSession: vi.fn(async () => ({ ok: true as const })),
      getDeviceId: vi.fn(async () => 'device-1'),
      getDefaultGatewayId: () => 'gw-1',
      getAgentCatalog: () => ({ agents: [{ id: 'main' }], defaultId: 'main' }),
    });

    await store.getState().hydrate();

    expect(store.getState().tasks.find((t) => t.id === 't-pinned')?.pinnedAt).toBe('2026-09-18T10:00:00.000Z');
  });

  it('库里是 NULL 的任务读回来就是未置顶（不能变成 null 字符串）', async () => {
    const store = createTaskStore({
      persistTask: vi.fn(async () => ({ ok: true as const })),
      persistTaskUpdate: vi.fn(async () => ({ ok: true as const })),
      deleteTask: vi.fn(async () => ({ ok: true as const })),
      loadTasks: vi.fn(async () => ({
        ok: true,
        rows: [
          {
            id: 't-normal',
            sessionKey: 'k',
            sessionId: 's',
            title: '普通任务',
            status: 'active',
            createdAt: '2026-09-01T00:00:00.000Z',
            updatedAt: '2026-09-01T00:00:00.000Z',
            tags: [],
            artifactDir: '',
            gatewayId: 'gw-1',
            pinnedAt: null,
          },
        ],
      })),
      patchSession: vi.fn(async () => ({ ok: true as const })),
      getDeviceId: vi.fn(async () => 'device-1'),
      getDefaultGatewayId: () => 'gw-1',
      getAgentCatalog: () => ({ agents: [{ id: 'main' }], defaultId: 'main' }),
    });

    await store.getState().hydrate();

    expect(store.getState().tasks.find((t) => t.id === 't-normal')?.pinnedAt).toBeUndefined();
  });
});
