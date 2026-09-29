import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const handleMap = new Map<string, (...args: unknown[]) => unknown>();

const isWorkspaceConfiguredMock = vi.fn(() => false);
const getWorkspacePathMock = vi.fn<() => string | null>(() => '/tmp/old-workspace');
const writeConfigMock = vi.fn();
const updateConfigMock = vi.fn();
const getDefaultWorkspacePathMock = vi.fn(() => '/tmp/default-workspace');

const initWorkspaceMock = vi.fn();
const migrateWorkspaceMock = vi.fn();

const initDatabaseMock = vi.fn();
const reinitDatabaseMock = vi.fn();
const closeDatabaseMock = vi.fn();

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
  dialog: {
    showOpenDialog: vi.fn(),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handleMap.set(channel, handler);
    }),
  },
}));

vi.mock('../src/main/workspace/config.js', () => ({
  getWorkspacePath: getWorkspacePathMock,
  writeConfig: writeConfigMock,
  updateConfig: updateConfigMock,
  isWorkspaceConfigured: isWorkspaceConfiguredMock,
  getDefaultWorkspacePath: getDefaultWorkspacePathMock,
  // 补记盘符自愈线索时也要看"程序自己运行的那块盘"（本机安装形态 = null）。
  // ⚠️ 与上面 `getSqlite` 同一条纪律：mock 少一个被用到的导出，vitest 报的是
  //    `No "…" export is defined on the mock`，指向 mock 而不是被测代码。
  getPortableWorkspaceRoot: () => null,
}));

vi.mock('../src/main/workspace/init.js', () => ({
  initWorkspace: initWorkspaceMock,
  migrateWorkspace: migrateWorkspaceMock,
}));

vi.mock('../src/main/db/index.js', () => ({
  initDatabase: initDatabaseMock,
  reinitDatabase: reinitDatabaseMock,
  closeDatabase: closeDatabaseMock,
  // `workspace-handlers` 换库后会重建资料库运行时，而它要拿 sqlite。
  // ⚠️ mock 必须与真实模块的**被用到的那部分**对齐：少一个导出，
  //    vitest 直接抛 `No "getSqlite" export is defined on the mock`，
  //    报错指向的是 mock 而不是被测代码。返回 null ⇒ 运行时重建那条路静默跳过，
  //    本文件关心的"换库顺序"不受影响。
  getSqlite: () => null,
}));

function createDeferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('registerWorkspaceHandlers', () => {
  beforeEach(() => {
    handleMap.clear();
    vi.clearAllMocks();
    getWorkspacePathMock.mockReturnValue('/tmp/old-workspace');
    isWorkspaceConfiguredMock.mockReturnValue(false);
    getDefaultWorkspacePathMock.mockReturnValue('/tmp/default-workspace');
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('waits for workspace migration before reopening the database', async () => {
    const deferred = createDeferred();
    migrateWorkspaceMock.mockReturnValue(deferred.promise);

    const { registerWorkspaceHandlers } = await import('../src/main/ipc/workspace-handlers.js');

    registerWorkspaceHandlers();

    const handler = handleMap.get('workspace:change');
    expect(handler).toBeTypeOf('function');

    const pending = handler?.({}, '/tmp/new-workspace') as Promise<{ ok: boolean; error?: string }>;

    await Promise.resolve();

    expect(closeDatabaseMock).toHaveBeenCalledTimes(1);
    expect(migrateWorkspaceMock).toHaveBeenCalledWith('/tmp/old-workspace', '/tmp/new-workspace');
    expect(reinitDatabaseMock).not.toHaveBeenCalled();
    expect(updateConfigMock).not.toHaveBeenCalled();

    deferred.resolve();

    await expect(pending).resolves.toEqual({ ok: true });
    expect(closeDatabaseMock).toHaveBeenCalledTimes(1);
    expect(reinitDatabaseMock).toHaveBeenCalledWith('/tmp/new-workspace');
    expect(updateConfigMock).toHaveBeenCalledWith({ workspacePath: '/tmp/new-workspace' });
  });

  it('⭐ 运行中换工作区先同步 runtime main.workspace，再提交客户端配置', async () => {
    const order: string[] = [];
    migrateWorkspaceMock.mockImplementation(async () => {
      order.push('migrate');
    });
    const syncRuntimeWorkspace = vi.fn(async () => {
      order.push('runtime');
    });
    updateConfigMock.mockImplementation(() => {
      order.push('config');
    });

    const { registerWorkspaceHandlers } = await import('../src/main/ipc/workspace-handlers.js');
    registerWorkspaceHandlers({ syncRuntimeWorkspace });
    const handler = handleMap.get('workspace:change');

    await expect(handler?.({}, '/tmp/new-workspace')).resolves.toEqual({ ok: true });
    expect(syncRuntimeWorkspace).toHaveBeenCalledWith('/tmp/new-workspace');
    expect(order).toEqual(['migrate', 'runtime', 'config']);
  });

  it('⭐ runtime main.workspace 同步失败 ⇒ 不报成功、不改客户端配置，并恢复旧数据库', async () => {
    const syncRuntimeWorkspace = vi.fn(async () => {
      throw new Error('runtime config busy');
    });

    const { registerWorkspaceHandlers } = await import('../src/main/ipc/workspace-handlers.js');
    registerWorkspaceHandlers({ syncRuntimeWorkspace });
    const handler = handleMap.get('workspace:change');

    await expect(handler?.({}, '/tmp/new-workspace')).resolves.toEqual({
      ok: false,
      error: 'runtime config busy',
    });
    expect(updateConfigMock).not.toHaveBeenCalled();
    expect(reinitDatabaseMock).toHaveBeenLastCalledWith('/tmp/old-workspace');
  });

  it('returns error without closing database when migration fails', async () => {
    migrateWorkspaceMock.mockRejectedValue(new Error('copy failed'));

    const { registerWorkspaceHandlers } = await import('../src/main/ipc/workspace-handlers.js');

    registerWorkspaceHandlers();

    const handler = handleMap.get('workspace:change');
    expect(handler).toBeTypeOf('function');

    await expect(handler?.({}, '/tmp/new-workspace')).resolves.toEqual({
      ok: false,
      error: 'copy failed',
    });

    expect(closeDatabaseMock).toHaveBeenCalledTimes(1);
    expect(reinitDatabaseMock).toHaveBeenCalledWith('/tmp/old-workspace');
  });

  it('joins workspace and slug using path.join so the host separator is used', async () => {
    const { registerWorkspaceHandlers } = await import('../src/main/ipc/workspace-handlers.js');
    registerWorkspaceHandlers();

    const handler = handleMap.get('workspace:team-path');
    expect(handler).toBeTypeOf('function');

    getWorkspacePathMock.mockReturnValue('/tmp/claw-workspace');
    const result = (await handler?.({}, 'test-team')) as string;
    const expected = (await import('path')).join('/tmp/claw-workspace', 'test-team');

    expect(result).toBe(expected);
    expect(result.endsWith(`${(await import('path')).sep}test-team`)).toBe(true);
    expect(result.includes('//test-team')).toBe(false);
  });

  /**
   * ⚠️ 2026-09-20 U 盘交付实机**改掉的旧行为**：以前这里 `return slug`（把 slug 本身
   *    当路径发出去）。调用方拿到的是相对路径，交给网关进程按它自己的 home 解释
   *    ⇒ 每个助手都建失败，界面只剩 `No agents were created successfully`。
   *    现在**拒绝**：拿不到工作区就不许伪造一条路径。
   */
  it('⭐ 没有工作区时拒绝，不再把 slug 当路径发出去', async () => {
    getWorkspacePathMock.mockReturnValue(null);
    const { registerWorkspaceHandlers } = await import('../src/main/ipc/workspace-handlers.js');
    registerWorkspaceHandlers();

    const handler = handleMap.get('workspace:team-path');
    expect(handler).toBeTypeOf('function');

    expect(() => handler?.({}, 'lonely-team')).toThrow('workspace not configured');
  });

  it('rejects invalid team workspace slugs', async () => {
    const { registerWorkspaceHandlers } = await import('../src/main/ipc/workspace-handlers.js');
    registerWorkspaceHandlers();

    const handler = handleMap.get('workspace:team-path');
    expect(handler).toBeTypeOf('function');

    for (const slug of ['', '../invalid', 'invalid/path', String.raw`invalid\path`, 'bad..slug', 123]) {
      expect(() => handler?.({}, slug)).toThrow('Invalid team slug');
    }
  });
});
