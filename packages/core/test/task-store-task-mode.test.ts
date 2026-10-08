import { describe, expect, it, vi } from 'vitest';
import { createTaskStore } from '../src/stores/task-store';
import { DEFAULT_TASK_MODE, resolveEffectiveTaskMode, type IpcResult } from '@clawwork/shared';

/**
 * `tasks.mode`（任务模式）在 store 层的三条契约：
 *   1. **新任务默认智能**（`createTask` 写入默认档，不靠发送路径兜底）；
 *   2. 待发态选的档**跟着建任务走**（`startNewTask({mode}) → commitPendingTask`）；
 *   3. **存量保护**：旧行（mode 为空）读回来是 `undefined`，`resolveEffectiveTaskMode`
 *      按 `custom` 处理 —— 不得劫持它当年显式选过的 `model`（也不许被默认档顶掉）。
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

describe('任务模式 · tasks.mode 持久化契约', () => {
  it('新任务默认 smart（内存与落库一致）', () => {
    const h = setup();
    const task = h.store.getState().createTask();

    expect(DEFAULT_TASK_MODE).toBe('smart');
    expect(task.mode).toBe('smart');
    expect(h.persistTask).toHaveBeenCalledWith(expect.objectContaining({ mode: 'smart' }));
  });

  it('待发态没选档 ⇒ 建出来的任务仍是默认 smart', () => {
    const h = setup();
    h.store.getState().startNewTask();
    const task = h.store.getState().commitPendingTask();

    expect(task.mode).toBe('smart');
  });

  it('⭐ 待发态选了档 ⇒ 建任务时原样带上（不被默认档顶掉）', () => {
    const h = setup();
    h.store.getState().startNewTask({ mode: 'fast' });
    const task = h.store.getState().commitPendingTask();

    expect(task.mode).toBe('fast');
    expect(h.persistTask).toHaveBeenCalledWith(expect.objectContaining({ mode: 'fast' }));
  });

  it('切档写内存也写库（updateTaskMetadata）', () => {
    const h = setup();
    const task = h.store.getState().createTask();

    h.store.getState().updateTaskMetadata(task.id, { mode: 'deep' });

    expect(h.store.getState().tasks.find((t) => t.id === task.id)?.mode).toBe('deep');
    expect(h.persistTaskUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: task.id, mode: 'deep' }));
  });

  it('⭐ 旧行（mode 为空）hydrate 回来是 undefined，且按 custom 处理 —— 不劫持既有 model', async () => {
    const h = setup();
    h.loadTasks.mockResolvedValueOnce({
      ok: true,
      rows: [
        {
          id: 'legacy',
          sessionKey: 'agent:main:clawwork:task:legacy',
          sessionId: '',
          title: '旧对话',
          status: 'active',
          createdAt: '2026-09-01T00:00:00.000Z',
          updatedAt: '2026-09-01T00:00:00.000Z',
          tags: [],
          artifactDir: '',
          gatewayId: 'gw-1',
          model: 'deepseek-v4-pro',
          thinkingLevel: 'high',
          mode: null,
        },
      ],
    });

    await h.store.getState().hydrate();

    const task = h.store.getState().tasks[0]!;
    expect(task.model).toBe('deepseek-v4-pro');
    expect(task.thinkingLevel).toBe('high');
    expect(task.mode).toBeUndefined();
    // 发送路径与界面共用这把尺：旧行 = custom（用户当年选的模型说了算）
    expect(resolveEffectiveTaskMode(task)).toBe('custom');
  });

  it('hydrate 认三档与 custom；脏值一律当"没偏好"（undefined ⇒ custom），不猜', async () => {
    const h = setup();
    const row = (id: string, mode: unknown) => ({
      id,
      sessionKey: `agent:main:clawwork:task:${id}`,
      sessionId: '',
      title: id,
      status: 'active',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      tags: [],
      artifactDir: '',
      gatewayId: 'gw-1',
      mode: mode as never,
    });
    h.loadTasks.mockResolvedValueOnce({
      ok: true,
      rows: [
        row('t-fast', 'fast'),
        row('t-smart', 'smart'),
        row('t-deep', 'deep'),
        row('t-custom', 'custom'),
        row('t-dirty', 'turbo'),
      ],
    });

    await h.store.getState().hydrate();

    const byId = new Map(h.store.getState().tasks.map((t) => [t.id, t.mode]));
    expect(byId.get('t-fast')).toBe('fast');
    expect(byId.get('t-smart')).toBe('smart');
    expect(byId.get('t-deep')).toBe('deep');
    expect(byId.get('t-custom')).toBe('custom');
    expect(byId.get('t-dirty')).toBeUndefined();
  });

  it('网关发现并回填的旧会话（adoptTasks）不带 mode ⇒ 走 custom 语义', () => {
    const h = setup();
    h.store.getState().adoptTasks([
      {
        taskId: 'discovered',
        sessionKey: 'agent:main:clawwork:task:discovered',
        title: '旧会话',
        updatedAt: '2026-09-01T00:00:00.000Z',
        gatewayId: 'gw-1',
        model: 'glm-4.7',
      },
    ]);

    const task = h.store.getState().tasks.find((t) => t.id === 'discovered')!;
    expect(task.mode).toBeUndefined();
    expect(resolveEffectiveTaskMode(task)).toBe('custom');
  });
});
