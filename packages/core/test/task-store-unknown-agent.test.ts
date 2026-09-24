import { describe, expect, it, vi } from 'vitest';
import { createTaskStore, UnknownAgentError } from '../src/stores/task-store';

/** `getAgentCatalog` 的返回值决定一切：目录**有没有内容**就是「加载了没」的判据。 */
function setup(catalog: { agents: { id: string }[]; defaultId: string | null }) {
  const persistTask = vi.fn(async () => ({ ok: true as const }));
  const store = createTaskStore({
    persistTask,
    persistTaskUpdate: vi.fn(async () => ({ ok: true as const })),
    deleteTask: vi.fn(async () => ({ ok: true as const })),
    loadTasks: vi.fn(async () => ({ ok: true, rows: [] })),
    patchSession: vi.fn(async () => ({ ok: true as const })),
    getDeviceId: vi.fn(async () => 'device-1'),
    getDefaultGatewayId: () => 'gw-1',
    getAgentCatalog: () => catalog,
  });
  return { store, persistTask };
}

/**
 * 发送侧的闸门（2026-09-24，D1 的「拒绝」必须一路管到发送）。
 *
 * 洞：欢迎屏拒绝之后 `pendingNewTask.agentId` 仍指向那个不存在的助手，而
 * `useChatSend` 在无活动任务时直接 `commitPendingTask()`，这里只校验"非空"
 * ⇒ 会建出一个指向幽灵助手的任务。
 *
 * ⚠️ 判据**必须保守**：`getAgentCatalog` 把「目录没加载」与「目录为空」塌成同一个形状
 * `{agents: [], defaultId: null}`，core 里分不出这两者 ⇒ 只有 `agents.length > 0`
 * （确已加载）时才敢拒绝。中间那条用例就是这个对照。
 */
describe('commitPendingTask 拒绝不在已加载目录里的助手', () => {
  it('目录为空（可能只是还没加载）⇒ 不拒绝，与今天行为一致', () => {
    const { store } = setup({ agents: [], defaultId: null });
    store.getState().startNewTask({ agentId: 'team-agent-x' });

    const task = store.getState().commitPendingTask();

    expect(task.agentId).toBe('team-agent-x');
  });

  it('目录确有内容且不含该 id ⇒ 拒绝，且**不建出任务**', () => {
    const { store, persistTask } = setup({ agents: [{ id: 'main' }], defaultId: 'main' });
    store.getState().startNewTask({ agentId: 'team-agent-x' });

    expect(() => store.getState().commitPendingTask()).toThrow(UnknownAgentError);
    expect(store.getState().tasks, '拒绝之后不许留下半个任务').toHaveLength(0);
    expect(persistTask).not.toHaveBeenCalled();
    // 待发任务也不许被悄悄改掉（改了就变成"静默换人"的另一种写法）
    expect(store.getState().pendingNewTask?.agentId).toBe('team-agent-x');
  });

  it('目录含该 id ⇒ 放行', () => {
    const { store } = setup({ agents: [{ id: 'main' }, { id: 'rongying-video' }], defaultId: 'main' });
    store.getState().startNewTask({ agentId: 'rongying-video' });

    const task = store.getState().commitPendingTask();

    expect(task.agentId).toBe('rongying-video');
  });

  it('错误带稳定 code，界面才能分别措辞', () => {
    const { store } = setup({ agents: [{ id: 'main' }], defaultId: 'main' });
    store.getState().startNewTask({ agentId: 'team-agent-x' });

    try {
      store.getState().commitPendingTask();
      throw new Error('本该抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownAgentError);
      expect((error as UnknownAgentError).code).toBe('unknown-agent');
      expect((error as UnknownAgentError).agentId).toBe('team-agent-x');
    }
  });
});
