// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * **接线**集成测试：跑的是**真的 `platform/index.ts`**，不是桩。
 *
 * ⚠️ 为什么单独有这一条：上面那两组（决策纯函数、设置页组件）都把 `@/platform`
 *    或 composer 换成了桩 —— 于是恰好漏掉唯一一处最容易写错的地方：
 *    `platform/index.ts` 里那个 dep 有没有真的接上、`readTier` 读的是不是那个字段。
 *    本项目的教训之一就是"每个零件都测过、拼起来没测过"。
 *
 * 这里注入的只有 `window.clawwork`（进程边界外面那一层），依赖图其余部分全是真的。
 */

vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const TASK = {
  id: 'wire-1',
  gatewayId: 'local-runtime',
  sessionKey: 'agent:main:wire-1',
  title: '接线',
  model: 'deepseek-v4-flash',
};

describe('platform 里的接线（真文件）', () => {
  let patchSession: ReturnType<typeof vi.fn>;
  let sendMessage: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.resetModules();

    patchSession = vi.fn().mockResolvedValue({ ok: true });
    sendMessage = vi.fn().mockResolvedValue({ ok: true });

    (globalThis.window as unknown as { clawwork: Record<string, unknown> }).clawwork = {
      patchSession,
      sendMessage,
      persistMessage: vi.fn().mockResolvedValue(undefined),
      persistTask: vi.fn().mockResolvedValue(undefined),
      persistTaskUpdate: vi.fn().mockResolvedValue(undefined),
      deleteTask: vi.fn().mockResolvedValue(undefined),
      loadTasks: vi.fn().mockResolvedValue({ ok: true, result: [] }),
      loadMessages: vi.fn().mockResolvedValue({ ok: true, result: [] }),
      getDeviceId: vi.fn().mockResolvedValue('dev-1'),
      getSettings: vi.fn().mockResolvedValue({ workspacePath: '/tmp/ws', gateways: [] }),
      updateSettings: vi.fn().mockResolvedValue({ ok: true, config: {} }),
      rebuildMenu: vi.fn(),
      onGatewayEvent: vi.fn(),
      onGatewayStatus: vi.fn(),
      onRuntimeStatus: vi.fn(),
    };
  });

  async function mountPlatform(computerAccess: unknown) {
    const platform = await import('../src/renderer/platform/index');
    const { useSettingsStore } = await import('../src/renderer/stores/settingsStore');
    useSettingsStore.setState({
      settings: { workspacePath: '/tmp/ws', gateways: [], computerAccess } as never,
      loaded: true,
      loading: false,
    });
    platform.taskStore.setState({ tasks: [TASK], activeTaskId: TASK.id } as never);
    return platform;
  }

  /** 只挑带 `permissionMode` 的 patch（model/thinkingLevel 也在同一条链上发）。 */
  const permissionPatches = () =>
    patchSession.mock.calls
      .filter((c) => (c[2] as Record<string, unknown>)?.permissionMode !== undefined)
      .map((c) => ({ key: c[1], mode: (c[2] as Record<string, unknown>).permissionMode }));

  it('设置是安全档 ⇒ 发送链上一次 permissionMode 都不发', async () => {
    const platform = await mountPlatform('safe');
    await platform.composer.send(TASK.id, { content: 'hi' });
    expect(permissionPatches()).toEqual([]);
  });

  it('⭐ 设置缺字段（老盘升级 / 新装机）⇒ 发 full —— 2026-09-27 起默认就是全权', async () => {
    // ⚠️ 这条**以前断言的是 `[]`**（默认安全 ⇒ 一个字都不发）。默认反转之后，
    //    它变成了「老盘升级上来会不会自动开全权」的**唯一判据** —— 答案是**会**，
    //    而且那是用户明确要的（"我建议默认开启"）。别把它当成 bug 改回去。
    const platform = await mountPlatform(undefined);
    await platform.composer.send(TASK.id, { content: 'hi' });
    expect(permissionPatches()).toEqual([{ key: TASK.sessionKey, mode: 'full' }]);
  });

  it('⭐ 设置是全权 ⇒ 真的发 {permissionMode:"full"} 到这个会话', async () => {
    const platform = await mountPlatform('full');
    await platform.composer.send(TASK.id, { content: 'hi' });
    expect(permissionPatches()).toEqual([{ key: TASK.sessionKey, mode: 'full' }]);
    expect(sendMessage).toHaveBeenCalled();
  });

  it('⭐ 设置被改回安全 ⇒ 下一条消息真的把它收回去', async () => {
    const platform = await mountPlatform('full');
    await platform.composer.send(TASK.id, { content: '一' });
    expect(permissionPatches()).toEqual([{ key: TASK.sessionKey, mode: 'full' }]);

    const { useSettingsStore } = await import('../src/renderer/stores/settingsStore');
    useSettingsStore.setState({
      settings: { workspacePath: '/tmp/ws', gateways: [], computerAccess: 'safe' } as never,
      loaded: true,
      loading: false,
    });
    await platform.composer.send(TASK.id, { content: '二' });

    expect(permissionPatches()).toEqual([
      { key: TASK.sessionKey, mode: 'full' },
      { key: TASK.sessionKey, mode: 'guarded' },
    ]);
  });
});
