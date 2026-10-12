import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ⭐ B2（2026-10-11 整改 · 复审二轮）：**在飞更新检查的频道归属**。
 *
 * 复审真实反例：stable 检查在飞、用户切到 beta，第二个调用者复用上一频道的共享
 * promise，却按自己的时刻把结果标成 beta（"只检查了一次 stable，第二次调用却回 beta"）。
 * 归属必须随**创建检查的那一刻**锁定：加入者拿到的是创建者的频道；需要新频道的检查
 * 按现有流程排下一次（下一次调用自然用新频道创建）。
 *
 * 这里驱动**真实的** `update-handlers`（`app:check-for-updates` 回调）与**真实的**
 * `auto-updater`（`checkForUpdatesViaUpdater` 的共享 promise 语义）；只有 electron /
 * electron-updater / workspace config 是内存替身。
 */

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  updaterCheck: vi.fn(),
  updaterDownload: vi.fn(async () => {}),
  channel: 'stable' as 'stable' | 'beta',
  allowPrerelease: false,
  version: '1.0.3',
}));

vi.mock('../src/main/artifact/turn-lifecycle.js', () => ({ hasLiveTurnSessions: () => false }));
vi.mock('../src/main/artifact/delivery-activity.js', () => ({ hasActiveDeliveryOperations: () => false }));

vi.mock('electron', () => ({
  app: {
    getVersion: () => mocks.version,
    get isPackaged() {
      return true;
    },
    quit: vi.fn(),
    getPath: () => 'C:\\ud',
  },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler);
    },
    on: () => {},
  },
}));

vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }));

vi.mock('electron-updater', () => ({
  default: {
    autoUpdater: {
      autoDownload: false,
      autoInstallOnAppQuit: true,
      autoRunAppAfterInstall: true,
      logger: null,
      on: () => {},
      checkForUpdates: mocks.updaterCheck,
      downloadUpdate: mocks.updaterDownload,
      quitAndInstall: () => {},
      get allowPrerelease() {
        return mocks.allowPrerelease;
      },
      set allowPrerelease(value: boolean) {
        mocks.allowPrerelease = value;
      },
    },
  },
}));

vi.mock('../src/main/workspace/config.js', () => ({
  readConfig: () => ({ updateChannel: mocks.channel }),
  getPortableWorkspaceRoot: () => null,
}));

vi.mock('../src/main/debug/index.js', () => ({
  getDebugLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

vi.mock('../src/main/update/launcher-version.js', () => ({
  LAUNCHER_VERSION_ARGUMENT: '--version',
  probeLauncherVersion: async () => ({ kind: 'unavailable', reason: 'fixture' }),
}));

async function flush(): Promise<void> {
  for (let tick = 0; tick < 12; tick += 1) await Promise.resolve();
}

async function setup(): Promise<(payload?: unknown) => Promise<unknown>> {
  vi.resetModules();
  const { registerUpdateHandlers } = await import('../src/main/ipc/update-handlers.js');
  registerUpdateHandlers();
  const check = mocks.handlers.get('app:check-for-updates');
  if (!check) throw new Error('app:check-for-updates 未注册');
  return check as (payload?: unknown) => Promise<unknown>;
}

beforeEach(() => {
  mocks.handlers.clear();
  mocks.updaterCheck.mockReset();
  mocks.updaterDownload.mockReset().mockResolvedValue(undefined);
  mocks.channel = 'stable';
  mocks.allowPrerelease = false;
  mocks.version = '1.0.3';
});

describe('B2 复审二轮：在飞检查的频道归属随创建锁定', () => {
  it('⭐ 切频道后第二个调用者复用同一份在飞检查：拿到**创建者**的频道，不重标、不重发', async () => {
    const check = await setup();
    let resolveCheck!: (value: { updateInfo: { version: string } }) => void;
    mocks.updaterCheck.mockImplementationOnce(
      () =>
        new Promise<{ updateInfo: { version: string } }>((resolve) => {
          resolveCheck = resolve;
        }),
    );

    const first = check();
    await flush();
    expect(mocks.updaterCheck).toHaveBeenCalledTimes(1);
    expect(mocks.allowPrerelease, '创建时按 stable 发起').toBe(false);

    // 检查在飞时用户切到 beta —— 第二次调用加入同一份在飞检查。
    mocks.channel = 'beta';
    const second = check();
    resolveCheck({ updateInfo: { version: '1.0.4' } });
    const firstResult = (await first) as { channel: string };
    const secondResult = (await second) as { channel: string };

    expect(mocks.updaterCheck, '复用在飞检查：不重复网络检查').toHaveBeenCalledTimes(1);
    expect(firstResult.channel).toBe('stable');
    expect(secondResult.channel, '加入者不许按自己被调用时的设置重标频道').toBe('stable');
  });

  it('⭐ 上一笔落定后的下一次检查用**新频道**创建（按现有流程排下一次）', async () => {
    const check = await setup();
    mocks.updaterCheck.mockResolvedValue({ updateInfo: { version: '1.0.4' } });

    const first = (await check()) as { channel: string };
    expect(first.channel).toBe('stable');

    mocks.channel = 'beta';
    const second = (await check()) as { channel: string };
    expect(second.channel, '新频道的新检查：归属是它自己').toBe('beta');
    expect(mocks.updaterCheck).toHaveBeenCalledTimes(2);
    expect(mocks.allowPrerelease, 'beta 的检查按 allowPrerelease=true 发起').toBe(true);
  });

  it('⭐ 失败也不许互相冒充：加入者拿到的仍是创建者的频道（同一 promise 同生共死）', async () => {
    const check = await setup();
    let rejectCheck!: (error: Error) => void;
    mocks.updaterCheck.mockImplementationOnce(
      () =>
        new Promise<{ updateInfo: { version: string } }>((_resolve, reject) => {
          rejectCheck = reject;
        }),
    );

    const first = check();
    await flush();
    mocks.channel = 'beta';
    const second = check();
    rejectCheck(new Error('network down'));
    await expect(first).rejects.toThrow('network down');
    await expect(second).rejects.toThrow('network down');
    expect(mocks.updaterCheck).toHaveBeenCalledTimes(1);
  });
});
