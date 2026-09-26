import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PortableUpdatePublicState } from '@clawwork/shared';
import type { PortableUpdateService } from '../src/main/update/portable-update-service.js';

/**
 * 更新机制的主进程状态机（2026-09-18 真机实测 + 双审阅后重做）。
 *
 * 实测出来的毛病，这里逐个钉死：
 * ① 点「安装」原本传 `quitAndInstall(false, …)` ⇒ **弹 NSIS 向导**等人点，
 *    而产品承诺是"自动更新，什么都不用做" ⇒ 必须静默（isSilent=true）。
 * ② 下载完再点一次「检查更新」会把状态打回 `available` ⇒ `installUpdate()` 报
 *    `no-downloaded-update`，安装入口失效（0.0.21 实测踩到）。**判定必须看判定
 *    那一刻的事实**：下载可能在检查飞行途中就完成（缓存的包只需校验哈希）。
 * ③ 装完以后 `pending\` 里还留着 239MB 安装包，得清 —— 但要保守：缓存是用户级
 *    共享的，同机另一份副本可能正等着用它。
 * ④ 「取消下载」原本取消不掉（下载由 electron-updater 的 autoDownload 驱动，
 *    token 在库手里）⇒ 改由我们自己驱动下载。
 * 外加：便携（U 盘）形态不该自动下载、更不该把包装到本机（那是"第二份副本"）。
 *
 * ⚠️ 每个用例都拿一份**全新**的模块实例（`vi.resetModules()` + 动态 import）：
 *    state / downloadedVersion / initialized 都是模块级的，共享会让断言互相污染。
 */

const mocks = vi.hoisted(() => ({
  portableRoot: null as string | null,
  currentVersion: '0.0.21',
  handlers: new Map<string, (...args: unknown[]) => void>(),
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn(),
  quitAndInstall: vi.fn(),
  logs: [] as { event: string }[],
}));

vi.mock('electron', () => ({
  app: {
    getVersion: () => mocks.currentVersion,
    isPackaged: true,
    getName: () => '@clawwork/desktop',
    getPath: (key: string) => (key === 'exe' ? 'C:\\Program Files\\@clawworkdesktop\\荣盈魔方.exe' : 'C:\\ud'),
    getAppPath: () => 'C:\\Program Files\\@clawworkdesktop\\resources\\app.asar',
    // 安装看门狗会在真正开始退出时撤掉自己（见 installUpdate）
    once: vi.fn(),
  },
  BrowserWindow: { getAllWindows: () => [] },
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
      on: (event: string, handler: (...args: unknown[]) => void) => mocks.handlers.set(event, handler),
      checkForUpdates: (...a: unknown[]) => mocks.checkForUpdates(...a),
      downloadUpdate: (...a: unknown[]) => mocks.downloadUpdate(...a),
      quitAndInstall: (...a: unknown[]) => mocks.quitAndInstall(...a),
    },
  },
}));

vi.mock('../src/main/debug/index.js', () => ({
  getDebugLogger: () => ({
    info: (entry: { event: string }) => mocks.logs.push(entry),
    warn: (entry: { event: string }) => mocks.logs.push(entry),
    error: (entry: { event: string }) => mocks.logs.push(entry),
    debug: (entry: { event: string }) => mocks.logs.push(entry),
  }),
}));

vi.mock('../src/main/workspace/config.js', () => ({
  readConfig: () => ({ updateChannel: 'stable' }),
  getPortableWorkspaceRoot: () => mocks.portableRoot,
}));

type AutoUpdaterModule = typeof import('../src/main/auto-updater.js');
let mod: AutoUpdaterModule;
let updaterMock: { autoDownload: boolean };

/** 拿一份全新模块实例并初始化（事件 handler / 状态就此就绪）。 */
async function loadFresh(): Promise<AutoUpdaterModule> {
  vi.resetModules();
  mod = await import('../src/main/auto-updater.js');
  updaterMock = (await import('electron-updater')).default.autoUpdater as unknown as { autoDownload: boolean };
  mod.initAutoUpdater();
  return mod;
}

const updateInfo = (version: string): unknown => ({
  updateInfo: { version, releaseNotes: null },
  cancellationToken: null,
});
/** 一个永远不完成的下载：用来观察"下载中"的状态（mock 的默认实现会立刻 resolve）。 */
const pendingDownload = (): Promise<never> => new Promise<never>(() => {});

// ---------------------------------------------------------------- 环境与清理

const SAVED_RESOURCES_PATH = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
const SAVED_LOCALAPPDATA = process.env.LOCALAPPDATA;
let tempRoots: string[] = [];

const DAY = 24 * 60 * 60 * 1000;

/**
 * 造一棵"更新缓存"目录树：`<root>/AppData/Local/<cacheDirName>/pending` + resources/app-update.yml。
 * `ageMs` 把文件 mtime 拨老 —— 清理只动"至少一天没动过"的文件。
 */
function makeUpdaterCache(files: Record<string, string | number>, ageMs = 0): { pending: string } {
  const root = mkdtempSync(join(tmpdir(), 'clawwork-updater-'));
  tempRoots.push(root);
  const resourcesPath = join(root, 'resources');
  mkdirSync(resourcesPath, { recursive: true });
  writeFileSync(
    join(resourcesPath, 'app-update.yml'),
    "provider: generic\nurl: https://example.test/updates/\nupdaterCacheDirName: '@clawworkdesktop-updater'\n",
  );
  const pending = join(root, 'AppData', 'Local', '@clawworkdesktop-updater', 'pending');
  mkdirSync(pending, { recursive: true });
  const when = new Date(Date.now() - ageMs);
  for (const [name, size] of Object.entries(files)) {
    const full = join(pending, name);
    writeFileSync(full, 'x'.repeat(Number(size) || 1));
    if (ageMs > 0) utimesSync(full, when, when);
  }
  process.env.LOCALAPPDATA = join(root, 'AppData', 'Local');
  Object.defineProperty(process, 'resourcesPath', { value: resourcesPath, configurable: true });
  return { pending };
}

beforeEach(() => {
  mocks.portableRoot = null;
  mocks.currentVersion = '0.0.21';
  mocks.handlers.clear();
  mocks.logs.length = 0;
  mocks.checkForUpdates.mockReset();
  mocks.downloadUpdate.mockReset();
  mocks.quitAndInstall.mockReset();
  mocks.downloadUpdate.mockResolvedValue(undefined);
});

afterEach(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  tempRoots = [];
  // 全局状态复原（同仓库 runtime-bundled-locate.test.ts 的惯例）：不还原的话，后面的
  // 用例会继承一个指向已删目录的 LOCALAPPDATA / 指向别处的 resourcesPath。
  if (SAVED_RESOURCES_PATH) Object.defineProperty(process, 'resourcesPath', SAVED_RESOURCES_PATH);
  else delete (process as unknown as { resourcesPath?: string }).resourcesPath;
  if (SAVED_LOCALAPPDATA === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = SAVED_LOCALAPPDATA;
});

describe('清理更新缓存里已装版本的残留', () => {
  it('⭐ init 就会清一次：一天前下好的旧包删掉；比当前新的、刚下好的、非安装包一律不碰', async () => {
    const { pending } = makeUpdaterCache(
      {
        '荣盈魔方-0.0.21-win-x64.exe': 1024, // 当前版本 ⇒ 已装过，删
        '荣盈魔方-0.0.20-win-x64.exe': 1024, // 更老 ⇒ 删
        '荣盈魔方-0.0.22-win-x64.exe': 1024, // 比当前新 ⇒ **必须保留**
        'update-info.json': 100, // 不是安装包 ⇒ 不碰
        'current.blockmap': 100,
        'temp-荣盈魔方-0.0.19-win-x64.exe': 100, // 半截下载 ⇒ 删
      },
      DAY + 60_000,
    );

    await loadFresh();
    mod.runUpdaterStartupHousekeeping(); // 生产里由 main/index.ts 在工作区就绪后调用

    expect(readdirSync(pending).sort()).toEqual([
      'current.blockmap',
      'update-info.json',
      '荣盈魔方-0.0.22-win-x64.exe',
    ]);
  });

  it('⭐ 刚下好（不到一天）的一律不碰 —— 同机另一份副本可能正等着退出安装', async () => {
    const { pending } = makeUpdaterCache({
      '荣盈魔方-0.0.21-win-x64.exe': 1024,
      'temp-荣盈魔方-0.0.22-win-x64.exe': 1024,
    });

    await loadFresh();
    mod.runUpdaterStartupHousekeeping();

    expect(readdirSync(pending).sort()).toEqual(['temp-荣盈魔方-0.0.22-win-x64.exe', '荣盈魔方-0.0.21-win-x64.exe']);
  });

  it('⭐ 盘上运行（U 盘那份）绝不清理本机缓存 —— 共享目录里可能是本机等着装的那份', async () => {
    mocks.portableRoot = 'F:\\';
    const { pending } = makeUpdaterCache({ '荣盈魔方-0.0.20-win-x64.exe': 1024 }, DAY + 60_000);

    await loadFresh();
    mod.runUpdaterStartupHousekeeping();

    expect(readdirSync(pending)).toEqual(['荣盈魔方-0.0.20-win-x64.exe']);
  });

  it('认不出版本的文件不碰；当前版本是预发布（比不出大小）时整个清理跳过', async () => {
    mocks.currentVersion = '0.0.22-beta.1'; // 0.0.19 与它谁新谁旧说不清 ⇒ 宁可都不删
    const { pending } = makeUpdaterCache(
      { 'some-installer.exe': 1024, '荣盈魔方-0.0.19-win-x64.exe': 1024 },
      DAY + 60_000,
    );

    await loadFresh();
    mod.runUpdaterStartupHousekeeping();

    expect(readdirSync(pending).sort()).toEqual(['some-installer.exe', '荣盈魔方-0.0.19-win-x64.exe']);
  });
});

// ---------------------------------------------------------------- 状态机

describe('检查更新：状态与便携形态', () => {
  it('非便携：发现新版本 ⇒ 自动开始下载（T-U3），状态是下载中', async () => {
    const { checkForUpdatesViaUpdater } = await loadFresh();
    mocks.checkForUpdates.mockResolvedValue(updateInfo('0.0.22'));

    const result = await checkForUpdatesViaUpdater();

    expect(result.hasUpdate).toBe(true);
    expect(result.portable).toBe(false);
    expect(mocks.downloadUpdate, '远程/无人值守的用户不会自己点下载').toHaveBeenCalledTimes(1);
    expect(result.state).toBe('downloading');
  });

  /**
   * ⭐ 判定必须是「**比本机新**」，不是「**不相等**」。
   *
   * 2026-09-20 实机撞到：打包态 0.0.24 跑着、更新源上是 0.0.23（还没发新版），
   * 左下角却亮着「有新版本可用」—— 因为判据写的是 `latestVersion !== currentVersion`。
   * 用户点进去只会看到 electron-updater 拒绝降级（它自己不接受降级），白困惑一场。
   *
   * ⚠️ 顺带钉住"按数字比"：`0.0.9` → `0.0.10` 必须是新版本（字符串比会判反）。
   */
  it('⭐ 更新源比本机旧（0.0.24 跑着、源上 0.0.23）⇒ 不许说"有新版本可用"', async () => {
    mocks.currentVersion = '0.0.24';
    const { checkForUpdatesViaUpdater } = await loadFresh();
    mocks.checkForUpdates.mockResolvedValue(updateInfo('0.0.23'));

    const result = await checkForUpdatesViaUpdater();

    expect(result.latestVersion, '源上确实是这个版本').toBe('0.0.23');
    expect(result.hasUpdate, '降级不是更新 —— 别亮角标').toBe(false);
    expect(mocks.downloadUpdate, '更旧的包更不能自动下').not.toHaveBeenCalled();
  });

  it('⭐ 版本按数字比：0.0.9 → 0.0.10 是新版本', async () => {
    mocks.currentVersion = '0.0.9';
    const { checkForUpdatesViaUpdater } = await loadFresh();
    mocks.checkForUpdates.mockResolvedValue(updateInfo('0.0.10'));

    expect((await checkForUpdatesViaUpdater()).hasUpdate).toBe(true);
  });

  it('⭐ 便携（U 盘）形态：不自动下载，结果里标明 portable', async () => {
    const { checkForUpdatesViaUpdater } = await loadFresh();
    mocks.portableRoot = 'F:\\';
    mocks.checkForUpdates.mockResolvedValue(updateInfo('0.0.22'));

    const result = await checkForUpdatesViaUpdater();

    expect(result.portable, '界面要据此换成"请换包"的提示').toBe(true);
    expect(result.state).toBe('available');
    expect(mocks.downloadUpdate, 'U 盘版自动下 239MB 安装包 = 白下（装也装不到盘上）').not.toHaveBeenCalled();
  });

  it('⭐ 便携形态：没有整目录服务时，下载与安装明确报不可用（而不是悄悄装到本机）', async () => {
    const { checkForUpdatesViaUpdater, downloadUpdate, installUpdate } = await loadFresh();
    mocks.portableRoot = 'F:\\';
    mocks.checkForUpdates.mockResolvedValue(updateInfo('0.0.22'));
    await checkForUpdatesViaUpdater();

    expect(await downloadUpdate()).toEqual({ ok: false, error: 'portable-unavailable' });
    expect(await installUpdate()).toEqual({ ok: false, error: 'portable-unavailable' });
    expect(mocks.quitAndInstall).not.toHaveBeenCalled();
  });

  describe('便携路径：整目录更新服务的路由器', () => {
    function fakeService(overrides: Partial<PortableUpdateService> = {}): PortableUpdateService {
      const listeners = new Set<(state: PortableUpdatePublicState) => void>();
      return {
        getState: () => ({ phase: 'idle', currentVersion: '0.0.21', updatedAt: 1 }),
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        check: async () => {
          const state: PortableUpdatePublicState = {
            phase: 'available',
            currentVersion: '0.0.21',
            targetVersion: '0.0.22',
            updatedAt: 2,
          };
          for (const listener of listeners) listener(state);
          return state;
        },
        prepare: async () => ({ ok: true }),
        cancel: () => ({ ok: true }),
        requestRestart: async () => ({ ok: true }),
        ...overrides,
      };
    }

    it('检查更新交给服务，相位原样交回界面', async () => {
      const { checkForUpdatesViaUpdater, attachPortableUpdateService } = await loadFresh();
      mocks.portableRoot = 'F:\\';
      const service = fakeService();
      const check = vi.spyOn(service, 'check');
      attachPortableUpdateService(service);

      const result = await checkForUpdatesViaUpdater();

      expect(check).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ state: 'available', hasUpdate: true, latestVersion: '0.0.22', portable: true });
      expect(mocks.checkForUpdates, '盘上形态不走 electron-updater 的检查').not.toHaveBeenCalled();
    });

    it('下载走 prepare，失败码如实带回界面', async () => {
      const { downloadUpdate, attachPortableUpdateService } = await loadFresh();
      mocks.portableRoot = 'F:\\';
      const service = fakeService({ prepare: async () => ({ ok: false, errorCode: 'disk-space' }) });
      const prepare = vi.spyOn(service, 'prepare');
      attachPortableUpdateService(service);

      expect(await downloadUpdate()).toEqual({ ok: false, error: 'disk-space' });
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(mocks.downloadUpdate).not.toHaveBeenCalled();
    });

    it('取消走服务的 cancel', async () => {
      const { cancelUpdateDownload, attachPortableUpdateService } = await loadFresh();
      mocks.portableRoot = 'F:\\';
      const service = fakeService();
      const cancel = vi.spyOn(service, 'cancel');
      attachPortableUpdateService(service);

      expect(cancelUpdateDownload()).toEqual({ ok: true });
      expect(cancel).toHaveBeenCalledTimes(1);
    });

    it('安装走 requestRestart，绝不调用 quitAndInstall', async () => {
      const { installUpdate, attachPortableUpdateService } = await loadFresh();
      mocks.portableRoot = 'F:\\';
      const service = fakeService({ requestRestart: async () => ({ ok: false, errorCode: 'manifest-invalid' }) });
      const restart = vi.spyOn(service, 'requestRestart');
      attachPortableUpdateService(service);

      expect(await installUpdate()).toEqual({ ok: false, error: 'manifest-invalid' });
      expect(restart).toHaveBeenCalledTimes(1);
      expect(mocks.quitAndInstall, '便携路径永远不许把控制权交给 electron-updater 的安装器').not.toHaveBeenCalled();
    });

    it('服务卸载后回到不可用，不残留订阅', async () => {
      const { downloadUpdate, attachPortableUpdateService } = await loadFresh();
      mocks.portableRoot = 'F:\\';
      attachPortableUpdateService(fakeService());
      attachPortableUpdateService(null);

      expect(await downloadUpdate()).toEqual({ ok: false, error: 'portable-unavailable' });
    });
  });

  it('⭐ 下载由我们自己驱动 ⇒ 「取消下载」才取消得掉（autoDownload 必须是 false）', async () => {
    const { checkForUpdatesViaUpdater, cancelUpdateDownload } = await loadFresh();
    mocks.downloadUpdate.mockImplementation(pendingDownload); // 真的"还在下"
    mocks.checkForUpdates.mockResolvedValue(updateInfo('0.0.22'));
    await checkForUpdatesViaUpdater();

    expect(updaterMock.autoDownload, '靠库的 autoDownload，token 在它手里，取消不掉').toBe(false);
    expect(cancelUpdateDownload(), '下载中 ⇒ 取消应当被受理').toEqual({ ok: true });
  });

  it('⭐ 下载中点「检查更新」：仍在下载中，别打回 available（否则取消按钮是假的）', async () => {
    const { checkForUpdatesViaUpdater } = await loadFresh();
    mocks.downloadUpdate.mockImplementation(pendingDownload);
    mocks.checkForUpdates.mockResolvedValue(updateInfo('0.0.22'));
    await checkForUpdatesViaUpdater(); // 这一步已经自动开始下载 ⇒ downloading

    const again = await checkForUpdatesViaUpdater();

    expect(again.state).toBe('downloading');
    expect(mocks.downloadUpdate, '正在下就别再起一次').toHaveBeenCalledTimes(1);
  });

  it('⭐ 用户取消过的那一版不再自动下（否则下次检查又把 239MB 拉起来）；换版本照常自动下', async () => {
    const { checkForUpdatesViaUpdater, cancelUpdateDownload } = await loadFresh();
    // 用持有对象而不是裸变量：闭包里赋的值，TS 的收窄看不见，会判成"不可调用"
    const inFlight: { reject: ((err: unknown) => void) | null } = { reject: null };
    mocks.downloadUpdate.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          inFlight.reject = reject;
        }),
    );
    mocks.checkForUpdates.mockResolvedValue(updateInfo('0.0.22'));
    await checkForUpdatesViaUpdater();
    expect(cancelUpdateDownload()).toEqual({ ok: true });
    inFlight.reject?.(Object.assign(new Error('cancelled'), { isCancelled: true })); // 取消真的生效
    await Promise.resolve();

    mocks.downloadUpdate.mockClear();
    await checkForUpdatesViaUpdater();
    expect(mocks.downloadUpdate, '同一个版本：用户说了不要，就别再下').not.toHaveBeenCalled();

    mocks.checkForUpdates.mockResolvedValue(updateInfo('0.0.23'));
    await checkForUpdatesViaUpdater();
    expect(mocks.downloadUpdate, '换了新版本 ⇒ 照常自动下').toHaveBeenCalledTimes(1);
  });
});

describe('下载完成之后：状态不许被打回', () => {
  it('⭐ 检查飞行途中下载完成：判定要按**那一刻的事实**，不能按进检查前的快照', async () => {
    const { checkForUpdatesViaUpdater, installUpdate } = await loadFresh();
    // 真实路径：pending 里已有校验过的包 ⇒ checkForUpdates 期间就把 update-downloaded 发出来了
    mocks.checkForUpdates.mockImplementation(async () => {
      mocks.handlers.get('update-downloaded')?.({ version: '0.0.22' });
      return updateInfo('0.0.22');
    });

    const result = await checkForUpdatesViaUpdater();

    expect(result.state, '用旧快照判定 ⇒ 刚下好的更新被打回 available，安装入口失效').toBe('downloaded');

    // 假计时器：把 installUpdate 里那个 setImmediate 与 15 秒看门狗一次跑完，
    // 不给后面的用例留真计时器尾巴（留了会跨用例开火，把别处的断言打成 2 次调用）。
    vi.useFakeTimers();
    try {
      expect(await installUpdate()).toEqual({ ok: true });
      await vi.advanceTimersByTimeAsync(16_000);
      expect(mocks.quitAndInstall).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('⭐ 下载完再「检查更新」：状态仍是 downloaded；点「安装」= 静默安装 + 装完重启', async () => {
    const { checkForUpdatesViaUpdater, installUpdate, isInstallingUpdate } = await loadFresh();
    mocks.checkForUpdates.mockResolvedValue(updateInfo('0.0.22'));
    await checkForUpdatesViaUpdater(); // 自动下载（调用 1 次）
    mocks.handlers.get('update-downloaded')?.({ version: '0.0.22' });
    mocks.downloadUpdate.mockClear(); // 只观察"第二次检查会不会再起一次下载"

    const again = await checkForUpdatesViaUpdater();
    expect(again.state, '这一条断了 ⇒ 用户点完检查更新就再也装不上（0.0.21 实测）').toBe('downloaded');
    expect(mocks.downloadUpdate, '已经下好了就别再下').not.toHaveBeenCalled();

    // 看门狗用假计时器跑：真实计时器下它 15 秒后会开火，把状态改成 error
    vi.useFakeTimers();
    try {
      expect(await installUpdate()).toEqual({ ok: true });
      expect(isInstallingUpdate()).toBe(true);
      await vi.advanceTimersByTimeAsync(16_000); // INSTALL_WATCHDOG_MS = 15s
      expect(mocks.quitAndInstall).toHaveBeenCalledTimes(1);
      const [isSilent, isForceRunAfter] = mocks.quitAndInstall.mock.calls[0] as [boolean, boolean];
      expect(isSilent, 'isSilent=false 实测会弹出「荣盈魔方 安装」向导等人点').toBe(true);
      expect(isForceRunAfter, '装完要自动把新版本拉起来').toBe(true);
      expect(isInstallingUpdate(), '安装没起来还卡在 true ⇒ 关窗不再最小化、用户也不知道失败了').toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('已下载时再点「下载」：直接成功，不重复下一个 239MB', async () => {
    const { checkForUpdatesViaUpdater, downloadUpdate } = await loadFresh();
    mocks.checkForUpdates.mockResolvedValue(updateInfo('0.0.22'));
    await checkForUpdatesViaUpdater();
    await downloadUpdate();
    mocks.handlers.get('update-downloaded')?.({ version: '0.0.22' });
    mocks.downloadUpdate.mockClear();

    expect(await downloadUpdate()).toEqual({ ok: true });
    expect(mocks.downloadUpdate).not.toHaveBeenCalled();
  });

  it('下载完之后发现更新的版本（0.0.23）：回到 available 并重新下', async () => {
    const { checkForUpdatesViaUpdater, downloadUpdate } = await loadFresh();
    mocks.checkForUpdates.mockResolvedValue(updateInfo('0.0.22'));
    await checkForUpdatesViaUpdater();
    await downloadUpdate();
    mocks.handlers.get('update-downloaded')?.({ version: '0.0.22' });
    mocks.downloadUpdate.mockClear();

    mocks.checkForUpdates.mockResolvedValue(updateInfo('0.0.23'));
    const result = await checkForUpdatesViaUpdater();

    expect(result.state).toBe('downloading');
    expect(mocks.downloadUpdate, '新版本要重新下（差分下载，不会全量重来）').toHaveBeenCalledTimes(1);
  });
});

/**
 * 崩溃恢复**必须真的挂在启动序列上**。
 *
 * 这一条才是原缺陷的形状：`recoverPortablePrepare` 当年**生产零调用** ——
 * 逻辑写好了、单测也有、就是没人调。所以只测那个函数不够，必须证明
 * `runUpdaterStartupHousekeeping()`（`main/index.ts:422` 在工作区就绪后调它）
 * 真的把它带起来了。
 */
describe('启动序列里的崩溃恢复（生产装配点）', () => {
  it('⭐ runUpdaterStartupHousekeeping 清掉崩在下载/解压中途的残留，并留下一条日志', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mofang-auto-updater-recovery-'));
    tempRoots.push(root);
    const { PortableUpdateStateStore, resolvePortableTransactionPaths, PORTABLE_UPDATE_DIRECTORY_NAME } =
      await import('../src/main/update/portable-state.js');
    const paths = resolvePortableTransactionPaths({ root, transactionId: 'txn-crash' });
    mkdirSync(join(root, PORTABLE_UPDATE_DIRECTORY_NAME, 'staged', 'txn-crash', 'program'), { recursive: true });
    writeFileSync(join(root, PORTABLE_UPDATE_DIRECTORY_NAME, 'staged', 'txn-crash', 'program', 'app.txt'), 'half');
    const store = new PortableUpdateStateStore({
      stateFilePath: join(root, PORTABLE_UPDATE_DIRECTORY_NAME, 'update-state.json'),
    });
    await store.write({
      schemaVersion: 1,
      transactionId: 'txn-crash',
      phase: 'extracting',
      currentVersion: '0.0.25',
      targetVersion: '0.0.26',
      channel: 'internal',
      ...paths,
      updatedAt: 1,
    });

    mocks.portableRoot = root;
    mocks.logs.length = 0;
    await loadFresh();
    mod.runUpdaterStartupHousekeeping();

    // 恢复是 fire-and-forget（启动路径不 await），所以等它落定。
    //
    // ⚠️ **等的是日志，不是目录**（2026-09-27 修的一条真竞态）。
    //    代码里的顺序是「先 discard、后写日志」，所以"日志出现了"蕴含"目录已经删了"；
    //    反过来不成立 —— 原来等的是目录，于是紧接着断言日志时它**可能还没写**。
    //    单跑几乎不会撞上，满负载整仓跑时撞得上（实测：`expected [] to include`）。
    //    而且这一条不落定，它的日志会晚到**下一条测试**里（下一条会清空同一个共享 mock），
    //    症状变成下一条报 `expected [Array(1)] to not include` —— 两条红同一个根因。
    //
    // ⚠️ 显式给足超时：`vi.waitFor` 默认 1s，在满负载的整仓跑里不够。
    await vi.waitFor(
      () => {
        expect(mocks.logs.map((entry) => entry.event)).toContain('portable.prepare-recovery.discarded');
      },
      { timeout: 15_000 },
    );

    // 判据是 `staged/<txn>` 这一层：`discard` 删的是**这个事务**的目录，
    // 上层的 `staged/` 会留着（空目录，无害）。
    expect(() => readdirSync(join(root, PORTABLE_UPDATE_DIRECTORY_NAME, 'staged', 'txn-crash'))).toThrow();
  });

  it('非便携态（portableRoot=null）⇒ 恢复什么都不做，也不写日志', async () => {
    mocks.portableRoot = null;
    mocks.logs.length = 0;
    await loadFresh();
    mod.runUpdaterStartupHousekeeping();

    expect(mocks.logs.map((entry) => entry.event)).not.toContain('portable.prepare-recovery.discarded');
    expect(mocks.logs.map((entry) => entry.event)).not.toContain('portable.prepare-recovery.failed');
  });
});
