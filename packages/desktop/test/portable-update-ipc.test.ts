import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  listeners: new Map<string, (...args: unknown[]) => void>(),
  portableRoot: null as string | null,
  quit: vi.fn(),
  packaged: true,
}));

vi.mock('electron', () => ({
  app: {
    getVersion: () => '0.0.21',
    get isPackaged() {
      return mocks.packaged;
    },
    quit: (...args: unknown[]) => mocks.quit(...args),
    getPath: () => 'C:\\ud',
  },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      if (mocks.handlers.has(channel)) throw new Error(`duplicate handle: ${channel}`);
      mocks.handlers.set(channel, handler);
    },
    on: (channel: string, listener: (...args: unknown[]) => void) => {
      if (mocks.listeners.has(channel)) throw new Error(`duplicate on: ${channel}`);
      mocks.listeners.set(channel, listener);
    },
  },
}));

vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }));

vi.mock('electron-updater', () => ({
  default: {
    autoUpdater: {
      autoDownload: false,
      autoInstallOnAppQuit: true,
      autoRunAppAfterInstall: true,
      allowPrerelease: false,
      logger: null,
      on: () => {},
      checkForUpdates: async () => null,
      downloadUpdate: async () => {},
      quitAndInstall: () => {},
    },
  },
}));

vi.mock('../src/main/workspace/config.js', () => ({
  readConfig: () => ({ updateChannel: 'stable' }),
  getPortableWorkspaceRoot: () => mocks.portableRoot,
}));

vi.mock('../src/main/debug/index.js', () => ({
  getDebugLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

// 装配盘上更新服务时会先问一次启动器版本（`--version`）。这里给个立刻返回的桩：
// 不然单测会去真 spawn 一个不存在的 exe（慢、且依赖文件系统），
// 而"探测到底怎么工作"由 `portable-update-launcher-version.test.ts` 负责。
vi.mock('../src/main/update/launcher-version.js', () => ({
  LAUNCHER_VERSION_ARGUMENT: '--version',
  probeLauncherVersion: async () => ({ kind: 'version', version: '0.0.21' }),
}));

async function loadHandlers() {
  vi.resetModules();
  return import('../src/main/ipc/update-handlers.js');
}

beforeEach(() => {
  mocks.handlers.clear();
  mocks.listeners.clear();
  mocks.portableRoot = null;
  mocks.quit.mockReset();
  mocks.packaged = true;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('portable update IPC', () => {
  it('registers each channel once', async () => {
    const { registerUpdateHandlers } = await loadHandlers();
    registerUpdateHandlers();

    expect([...mocks.handlers.keys()].sort()).toEqual([
      'app:cancel-update-download',
      'app:check-for-updates',
      'app:download-update',
      'app:get-update-state',
      'app:get-version',
      'app:install-update',
    ]);
    expect([...mocks.listeners.keys()]).toEqual(['app:portable-update-renderer-ready']);
  });

  it('reports no portable state while the app is not running from a drive', async () => {
    const { registerUpdateHandlers } = await loadHandlers();
    registerUpdateHandlers();

    expect(await mocks.handlers.get('app:get-update-state')?.()).toBeNull();
  });

  it('reports the typed public state once a portable run has a service', async () => {
    mocks.portableRoot = 'F:\\';
    const { registerUpdateHandlers } = await loadHandlers();
    registerUpdateHandlers();

    // ⚠️ 装配现在是**异步**的：里面多了一次启动器版本探测（`--version`）。
    //    这里只等它落定，断言的内容与以前一字不差。
    await vi.waitFor(() => {
      expect(mocks.handlers.get('app:get-update-state')?.()).not.toBeNull();
    });

    const state = (await mocks.handlers.get('app:get-update-state')?.()) as Record<string, unknown> | null;

    expect(state).not.toBeNull();
    expect(state).toMatchObject({ phase: 'idle', currentVersion: '0.0.21' });
    for (const key of Object.keys(state ?? {})) {
      expect(key).not.toMatch(/token|password|key|path|url|signature/i);
    }
  });

  it('forwards the renderer acknowledgement to the health coordinator', async () => {
    const { registerUpdateHandlers } = await loadHandlers();
    let acknowledged = 0;
    registerUpdateHandlers({ onRendererReady: () => (acknowledged += 1) });

    mocks.listeners.get('app:portable-update-renderer-ready')?.();

    expect(acknowledged).toBe(1);
  });

  it('keeps dev builds unsupported outside a portable run', async () => {
    mocks.packaged = false;
    const { registerUpdateHandlers } = await loadHandlers();
    registerUpdateHandlers();

    expect(await mocks.handlers.get('app:download-update')?.()).toEqual({
      ok: false,
      error: 'dev-not-supported',
    });
    expect(await mocks.handlers.get('app:install-update')?.()).toEqual({
      ok: false,
      error: 'dev-not-supported',
    });
    expect(mocks.handlers.get('app:cancel-update-download')?.()).toEqual({
      ok: false,
      error: 'dev-not-supported',
    });
  });

  it('never routes a portable install through the electron-updater installer', async () => {
    mocks.portableRoot = 'F:\\';
    const { registerUpdateHandlers } = await loadHandlers();
    registerUpdateHandlers();

    const result = (await mocks.handlers.get('app:install-update')?.()) as { ok: boolean; error?: string };

    expect(result.ok).toBe(false);
    expect(mocks.quit, '没有 ready 事务时不许退出应用').not.toHaveBeenCalled();
  });
});
