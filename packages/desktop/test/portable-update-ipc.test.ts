import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PortableUpdateService, PortableUpdateServiceDeps } from '../src/main/update/portable-update-service.js';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  listeners: new Map<string, (...args: unknown[]) => void>(),
  portableRoot: null as string | null,
  quit: vi.fn(),
  packaged: true,
  updateChannel: 'stable' as 'stable' | 'beta',
  serviceFactory: null as null | ((deps: PortableUpdateServiceDeps) => PortableUpdateService),
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
  readConfig: () => ({ updateChannel: mocks.updateChannel }),
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

vi.mock('../src/main/update/portable-update-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/update/portable-update-service.js')>();
  return {
    ...actual,
    createPortableUpdateService: (deps: PortableUpdateServiceDeps) =>
      mocks.serviceFactory?.(deps) ?? actual.createPortableUpdateService(deps),
  };
});

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
  mocks.updateChannel = 'stable';
  mocks.serviceFactory = null;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('portable update IPC', () => {
  function controlledService(deps: PortableUpdateServiceDeps) {
    let phase: ReturnType<PortableUpdateService['getState']>['phase'] = 'idle';
    let finishPrepare: ((result: { ok: false; errorCode: 'unknown' }) => void) | null = null;
    const prepare = vi.fn(() => {
      phase = 'downloading';
      return new Promise<{ ok: false; errorCode: 'unknown' }>((resolve) => {
        finishPrepare = resolve;
      });
    });
    const cancel = vi.fn(() => {
      phase = 'error';
      finishPrepare?.({ ok: false, errorCode: 'unknown' });
      return { ok: true } as const;
    });
    const requestRestart = vi.fn(async () => ({ ok: true }) as const);
    const service: PortableUpdateService = {
      getState: () => ({
        phase,
        currentVersion: deps.currentVersion,
        ...(phase === 'idle' || phase === 'checking' || phase === 'error' ? {} : { targetVersion: '0.0.22' }),
        updatedAt: 1,
      }),
      subscribe: () => () => {},
      check: async () => {
        phase = 'available';
        return service.getState();
      },
      prepare,
      cancel,
      requestRestart,
    };
    return {
      channel: deps.channel,
      service,
      prepare,
      cancel,
      requestRestart,
      setPhase: (next: typeof phase) => (phase = next),
    };
  }

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
    await expect(mocks.handlers.get('app:cancel-update-download')?.()).resolves.toEqual({
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

  it('同一进程从 stable 切到 beta 后，下一次检查必须请求 internal 清单', async () => {
    mocks.portableRoot = 'F:\\';
    const fetchMock = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(
      async () => new Response('', { status: 404 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { registerUpdateHandlers } = await loadHandlers();
    registerUpdateHandlers();
    const check = mocks.handlers.get('app:check-for-updates');

    await check?.();
    mocks.updateChannel = 'beta';
    expect((await import('../src/main/auto-updater.js')).getUpdateChannel()).toBe('beta');
    await check?.();

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'https://api.rongyinghudong.com/updates/stable/manifest.json',
      'https://api.rongyinghudong.com/updates/internal/manifest.json',
    ]);
  });

  it('⭐ 空闲时切频道后再下载：先换到新频道；下载中取消仍命中同一服务', async () => {
    mocks.portableRoot = 'F:\\';
    const created: ReturnType<typeof controlledService>[] = [];
    mocks.serviceFactory = (deps) => {
      const entry = controlledService(deps);
      created.push(entry);
      return entry.service;
    };
    const { registerUpdateHandlers } = await loadHandlers();
    registerUpdateHandlers();
    const check = mocks.handlers.get('app:check-for-updates');
    const download = mocks.handlers.get('app:download-update');
    const cancel = mocks.handlers.get('app:cancel-update-download');

    await check?.();
    expect(created.map((entry) => entry.channel)).toEqual(['stable']);

    mocks.updateChannel = 'beta';
    const downloading = Promise.resolve(download?.());
    await vi.waitFor(() => expect(created.map((entry) => entry.channel)).toEqual(['stable', 'internal']));
    expect(created[0]?.prepare).not.toHaveBeenCalled();
    expect(created[1]?.prepare).toHaveBeenCalledTimes(1);

    await expect(cancel?.()).resolves.toEqual({ ok: true });
    expect(created).toHaveLength(2);
    expect(created[1]?.cancel).toHaveBeenCalledTimes(1);
    await expect(downloading).resolves.toEqual({ ok: false, error: 'unknown' });
  });

  it('⭐ ready 事务期间切频道并再次检查：不换服务，安装仍交给原事务', async () => {
    mocks.portableRoot = 'F:\\';
    const created: ReturnType<typeof controlledService>[] = [];
    mocks.serviceFactory = (deps) => {
      const entry = controlledService(deps);
      created.push(entry);
      return entry.service;
    };
    const { registerUpdateHandlers } = await loadHandlers();
    registerUpdateHandlers();
    const check = mocks.handlers.get('app:check-for-updates');
    const install = mocks.handlers.get('app:install-update');

    await check?.();
    created[0]?.setPhase('ready');
    mocks.updateChannel = 'beta';

    const state = (await check?.()) as { state: string; latestVersion: string };
    expect(state).toMatchObject({ state: 'ready', latestVersion: '0.0.22' });
    expect(created, 'ready 事务是可安装资产，切频道不能把它从路由上摘掉').toHaveLength(1);
    await expect(install?.()).resolves.toEqual({ ok: true });
    expect(created[0]?.requestRestart).toHaveBeenCalledTimes(1);
  });
});
