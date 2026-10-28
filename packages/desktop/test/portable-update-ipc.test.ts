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
  /** 主进程忙态补位（2026-10-11）：②轮次软状态 ③交付在途 的可控替身。 */
  artifactFlags: { liveTurns: false, deliveries: false },
}));

// 三源取或的 ②③（主进程真状态）——单测用替身隔离它们各自的状态机（各有专测）。
vi.mock('../src/main/artifact/turn-lifecycle.js', () => ({
  hasLiveTurnSessions: () => mocks.artifactFlags.liveTurns,
}));
vi.mock('../src/main/artifact/delivery-activity.js', () => ({
  hasActiveDeliveryOperations: () => mocks.artifactFlags.deliveries,
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
  mocks.artifactFlags.liveTurns = false;
  mocks.artifactFlags.deliveries = false;
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
      deps,
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
    // `tray:update-status` = 忙态信号（2026-10-11 升级补齐）：只**多挂一个监听**读渲染层
    // 推来的真实任务/run 状态，不新增通道。
    expect([...mocks.listeners.keys()].sort()).toEqual(['app:portable-update-renderer-ready', 'tray:update-status']);
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

  // ⭐ 2026-10-11 升级补齐：忙态（生成/写文件期间）绝不退出应用、绝不启动替换。
  //    渲染层那条真实 run 状态经**既有** `tray:update-status` 通道上来，这里只多挂监听。
  it('任务进行中：安装被拒（不调 requestRestart、不退出），检查/下载照常；任务结束后可装', async () => {
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
    const install = mocks.handlers.get('app:install-update');
    const tray = mocks.listeners.get('tray:update-status');

    await check?.();
    created[0]?.setPhase('ready');
    expect(created[0]?.deps.isBusy?.(), '默认（还没收到推送）= 不忙').toBe(false);

    tray?.({}, { status: 'running', tasks: [{ taskId: 't1' }] });
    expect(created[0]?.deps.isBusy?.(), '忙态信号要一路传到便携服务的边界上').toBe(true);

    await expect(install?.()).resolves.toEqual({ ok: false, error: 'app-busy' });
    expect(created[0]?.requestRestart, '忙态不许走到换目录那一步').not.toHaveBeenCalled();
    expect(mocks.quit, '更不许退出应用').not.toHaveBeenCalled();

    // 运行中仍允许检查/下载（ready 候选留在原地，等用户稍后安装）
    await expect(check?.()).resolves.toMatchObject({ state: 'ready' });
    const downloading = Promise.resolve(download?.());
    await expect(cancel?.()).resolves.toEqual({ ok: true });
    await expect(downloading).resolves.toEqual({ ok: false, error: 'unknown' });
    expect(created[0]?.prepare, '忙不挡下载/准备').toHaveBeenCalledTimes(1);

    // 任务结束（或只剩未读）⇒ 安装恢复可用
    tray?.({}, { status: 'idle', tasks: [] });
    expect(created[0]?.deps.isBusy?.()).toBe(false);
    await expect(install?.()).resolves.toEqual({ ok: true });
    expect(created[0]?.requestRestart).toHaveBeenCalledTimes(1);
  });

  // ⭐ 2026-10-11 主进程补位（评审要点：不能只靠按钮灰掉）：
  //    渲染层推送尚未到达/已落后（②轮次软状态）、或 turn 已结束但交付在途（③）——
  //    这两段窗口只靠 tray 信号会漏；isAppBusy 三源取或后，IPC 与便携服务边界都挡。
  it('⭐ 主进程补位：轮次软状态未落 / 交付在途 ⇒ 渲染层说空闲也不许装；收敛后恢复', async () => {
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
    const tray = mocks.listeners.get('tray:update-status');

    await check?.();
    created[0]?.setPhase('ready');
    tray?.({}, { status: 'idle', tasks: [] });
    expect(created[0]?.deps.isBusy?.(), '渲染层说空闲').toBe(false);

    // ② 主进程轮次软状态未落（网关 start 已到、end 未到 / 渲染层推送滞后）
    mocks.artifactFlags.liveTurns = true;
    expect(created[0]?.deps.isBusy?.(), '主进程在跑 = 忙（服务边界同源）').toBe(true);
    await expect(install?.()).resolves.toEqual({ ok: false, error: 'app-busy' });
    expect(created[0]?.requestRestart, '忙态不许走到换目录那一步').not.toHaveBeenCalled();
    expect(mocks.quit, '更不许退出应用').not.toHaveBeenCalled();

    // ③ turn 已结束、交付（写盘/登记）仍在途——正是只靠渲染层会漏的窗口
    mocks.artifactFlags.liveTurns = false;
    mocks.artifactFlags.deliveries = true;
    expect(created[0]?.deps.isBusy?.()).toBe(true);
    await expect(install?.()).resolves.toEqual({ ok: false, error: 'app-busy' });
    expect(mocks.quit).not.toHaveBeenCalled();

    // 真实事件收敛（交付终态）⇒ 恢复可装
    mocks.artifactFlags.deliveries = false;
    await expect(install?.()).resolves.toEqual({ ok: true });
    expect(created[0]?.requestRestart).toHaveBeenCalledTimes(1);
  });
});
