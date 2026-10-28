import { describe, expect, it, vi } from 'vitest';
import { createTaskStore } from '../src/stores/task-store';
import type { IpcResult } from '@clawwork/shared';

/**
 * `tasks.deckRouted`（deck 路由粘性标记）在 store 层的两条契约：
 *   1. **写入**：`updateTaskMetadata(id, { deckRouted: true })` 既进内存、也落库
 *      （演示任务命中一次就粘住 —— 判据在 renderer 的 `lib/deck-intent.ts`）；
 *   2. **读回**：hydrate 必须把它带上。这是"加一列"最典型的暗坑 —— 写库那侧照常通，
 *      读回来没带上 ⇒ 用户看到的是"重启后改稿又跑回 qwen"（功能根本不管用）。
 *      0 / NULL（老行）= `undefined`（= "没标记过"），不伪造。
 */
function setup() {
  const persistTask = vi.fn(async () => ({ ok: true as const }));
  const persistTaskUpdate = vi.fn(async () => ({ ok: true as const }));
  const loadTasks = vi
    .fn<Parameters<typeof createTaskStore>[0]['loadTasks']>()
    .mockResolvedValue({ ok: true, rows: [] });
  const store = createTaskStore({
    persistTask,
    persistTaskUpdate,
    deleteTask: vi.fn<() => Promise<IpcResult>>().mockResolvedValue({ ok: true }),
    loadTasks,
    patchSession: vi.fn(async () => ({ ok: true as const })),
    getDeviceId: vi.fn(async () => 'device-1'),
    getDefaultGatewayId: () => 'gw-1',
    getAgentCatalog: () => ({ agents: [{ id: 'main' }], defaultId: 'main' }),
  });
  return { store, persistTask, persistTaskUpdate, loadTasks };
}

describe('deck 路由标记 · tasks.deckRouted 持久化契约', () => {
  it('写入：内存与落库都带上（发送路径标记的那一下）', () => {
    const h = setup();
    const task = h.store.getState().createTask();

    h.store.getState().updateTaskMetadata(task.id, { deckRouted: true });

    expect(h.store.getState().tasks.find((t) => t.id === task.id)?.deckRouted).toBe(true);
    expect(h.persistTaskUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: task.id, deckRouted: true }));
  });

  it('⭐ hydrate 读回标记（漏读 ⇒ 重启后改稿又跑回模式模型）', async () => {
    const h = setup();
    const row = (id: string, deckRouted: unknown) => ({
      id,
      sessionKey: `agent:main:clawwork:task:${id}`,
      sessionId: '',
      title: id,
      status: 'active',
      createdAt: '2026-10-08T00:00:00.000Z',
      updatedAt: '2026-10-08T00:00:00.000Z',
      tags: [],
      artifactDir: '',
      gatewayId: 'gw-1',
      deckRouted: deckRouted as never,
    });
    h.loadTasks.mockResolvedValueOnce({
      ok: true,
      rows: [row('t-deck', 1), row('t-chat', 0), row('t-legacy', null)],
    });

    await h.store.getState().hydrate();

    const byId = new Map(h.store.getState().tasks.map((t) => [t.id, t.deckRouted]));
    expect(byId.get('t-deck')).toBe(true);
    // 0 / NULL（老行）= "没标记过"，不伪造
    expect(byId.get('t-chat')).toBeUndefined();
    expect(byId.get('t-legacy')).toBeUndefined();
  });

  it('新建任务没有标记（默认 false 不落到任务对象上，语义 = 正常模式解析）', () => {
    const h = setup();
    const task = h.store.getState().createTask();

    expect(task.deckRouted).toBeUndefined();
  });
});
