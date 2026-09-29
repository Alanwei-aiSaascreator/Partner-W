import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { app, ipcMain } from 'electron';
import { canonicalizeJson, type PortableUpdateChannel } from '@clawwork/shared';
import {
  UPDATE_FEED_BASE,
  attachPortableUpdateService,
  cancelUpdateDownload,
  checkForUpdatesViaUpdater,
  downloadUpdate,
  getPortableUpdateState,
  getUpdateChannel,
  initAutoUpdater,
  installUpdate,
  isAutoUpdaterAvailable,
  isPortableUpdateOperationActive,
} from '../auto-updater.js';
import { getPortableWorkspaceRoot } from '../workspace/config.js';
import { getDebugLogger } from '../debug/index.js';
import { probeLauncherVersion } from '../update/launcher-version.js';
import { asarSafeFs } from '../update/asar-safe-fs.js';
import { PortableUpdateFailure } from '../update/portable-manifest.js';
import {
  downloadPortablePackage,
  extractPortablePackage,
  fetchFeedResponse,
  measureProgramTreeBytes,
  readFeedJson,
  verifyPortableProgramTree,
} from '../update/portable-package.js';
import {
  PORTABLE_PROGRAM_DIRECTORY_NAME,
  PortableUpdateStateStore,
  portableUpdateStateFilePath,
} from '../update/portable-state.js';
import { createPortableUpdateService } from '../update/portable-update-service.js';

const LAUNCHER_FILE_NAME = '\u8363\u76c8\u9b54\u65b9\u542f\u52a8\u5668.exe';

interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  releaseUrl: string;
  releaseNotes?: string | null;
  state: string;
  portable: boolean;
}

function buildTimePublicKey(): string {
  return typeof __MOFANG_UPDATE_PUBLIC_KEY_B64__ === 'string' ? __MOFANG_UPDATE_PUBLIC_KEY_B64__ : '';
}

function portableChannel(): PortableUpdateChannel {
  return getUpdateChannel() === 'beta' ? 'internal' : 'stable';
}

function isPortableUpdateNow(): boolean {
  return getPortableWorkspaceRoot() !== null;
}

function devCheckResult(): UpdateCheckResult {
  const currentVersion = app.getVersion();
  return {
    currentVersion,
    latestVersion: currentVersion,
    hasUpdate: false,
    releaseUrl: '',
    state: 'idle',
    portable: false,
  };
}

let portableInitialization: { key: string; promise: Promise<void> } | null = null;
let portableInitializationGeneration = 0;

async function initializePortableUpdateService(
  root: string,
  channel: PortableUpdateChannel,
  generation: number,
): Promise<void> {
  const feed = `${UPDATE_FEED_BASE}${channel}/`;
  const stateStore = new PortableUpdateStateStore({
    // 路径走唯一那个算法：启动恢复读的必须是同一个文件（两处各拼一次迟早会漂）。
    stateFilePath: portableUpdateStateFilePath(root),
  });

  // ⚠️ 在 `createPortableUpdateService` **之前**问盘上启动器要真版本。
  //    以前这里传的是硬编码的 '1.0.0' —— 与盘上那个 exe 毫无关系，
  //    所以 `minLauncherVersion` 那道门从来没真的比过。
  //    探测失败**不退回任何版本号**：交给服务拒绝一切更新（`launcher-incompatible`），
  //    这里只负责把原因记下来（吞掉但不静默）。
  const launcherPath = join(root, LAUNCHER_FILE_NAME);
  const probe = await probeLauncherVersion({ launcherPath });
  if (probe.kind === 'unavailable') {
    getDebugLogger().warn({
      domain: 'updater',
      event: 'portable.launcher-version.unavailable',
      message: probe.reason,
      data: { launcherPath },
    });
  }

  const service = createPortableUpdateService({
    root,
    currentVersion: app.getVersion(),
    channel,
    launcherVersion: probe.kind === 'version' ? probe.version : null,
    publicKeyBase64: buildTimePublicKey(),
    stateStore,
    fetchManifest: async () => {
      const response = await fetchFeedResponse(`${feed}manifest.json`);
      // 404 = **这个频道还没有发布任何 manifest**（每次发版之前的正常状态，不是故障）。
      // 报成一个用户无事可做的错误会误导人；交给服务落回 idle，由文案说"当前频道暂无更新"。
      if (response.status === 404) throw new PortableUpdateFailure('update-not-published');
      if (!response.ok) throw new PortableUpdateFailure('feed-response');
      return readFeedJson(response);
    },
    fetchFileManifest: async (manifest) => {
      const response = await fetchFeedResponse(new URL('portable-files.json', manifest.packageUrl).toString());
      // ⚠️ 以前这里是 `throw new Error(...)`（普通 Error）⇒ 服务只能报 `unknown`。
      if (!response.ok) throw new PortableUpdateFailure('feed-response');
      return readFeedJson(response);
    },
    downloadPackage: downloadPortablePackage,
    extractPackage: extractPortablePackage,
    verifyTree: verifyPortableProgramTree,
    // 启动器 `Apply` 的第一步就是读 `staged/<事务>/` 下这两份清单验签；
    // 它们会重新规范化再验，所以这里给**规范 JSON** 就行（发布出去的本来就是规范形式）。
    // ⚠️ 以前**没人写这两份** ⇒ 事务指向两个不存在的文件 ⇒ 更新永远卡在「应用」。
    writeStagedManifests: async ({ paths, manifest, fileManifest }) => {
      await asarSafeFs.promises.mkdir(dirname(paths.manifestPath), { recursive: true });
      await asarSafeFs.promises.writeFile(paths.manifestPath, canonicalizeJson(manifest), 'utf8');
      await asarSafeFs.promises.writeFile(paths.fileManifestPath, canonicalizeJson(fileManifest), 'utf8');
    },
    // 空间预算的第三项：换目录之前，现有程序目录一直占着这块盘。
    measureProgramSize: () => measureProgramTreeBytes(join(root, PORTABLE_PROGRAM_DIRECTORY_NAME)),
    now: () => Date.now(),
    createTransactionId: () => randomUUID(),
    startLauncher: (stateFilePath) =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(join(root, LAUNCHER_FILE_NAME), ['--apply', stateFilePath], {
          detached: true,
          stdio: 'ignore',
        });
        child.once('error', reject);
        child.once('spawn', () => {
          child.unref();
          resolve();
        });
      }),
    quit: () => app.quit(),
  });
  if (generation === portableInitializationGeneration) attachPortableUpdateService(service);
}

/**
 * 幂等地把盘上更新服务装配起来。
 *
 * 返回 Promise 的原因只有一个：要给启动器做一次 `--version` 探测（见上）。
 * 语义与以前那个 `portableInitialized` 布尔**逐条相同**：
 *   · 还没认出来"这是盘上运行"（`root === null`）⇒ 什么都不做，下次再来；
 *   · 成功之后不再重复装配（**也不会重复 spawn 启动器**）；
 *   · 装配失败则记日志并允许下次重试。
 * 同一时刻只会有一次在飞，所以 `app:check-for-updates` 与启动时那次调用不会各探一遍。
 */
function ensurePortableUpdateService(): Promise<void> {
  const root = getPortableWorkspaceRoot();
  if (root === null) return Promise.resolve();
  const channel = portableChannel();
  const key = `${root}\u0000${channel}`;
  if (portableInitialization?.key === key) return portableInitialization.promise;
  const currentState = getPortableUpdateState();
  if (portableInitialization && currentState && isPortableUpdateOperationActive(currentState.phase)) {
    // 频道是“下一次事务”的选择，不是给正在下载/已 ready 的事务换血。
    // 旧服务必须一直持有取消句柄与 readyTransaction，否则取消、安装都会路由到空服务。
    return portableInitialization.promise;
  }
  const generation = ++portableInitializationGeneration;

  const run = initializePortableUpdateService(root, channel, generation).catch((error: unknown) => {
    getDebugLogger().error({
      domain: 'updater',
      event: 'portable.service.init-failed',
      message: error instanceof Error ? error.message : String(error),
    });
    if (portableInitialization?.promise === run) portableInitialization = null;
  });
  portableInitialization = { key, promise: run };
  return run;
}

export function registerUpdateHandlers(options: { onRendererReady?: () => void } = {}): void {
  initAutoUpdater();
  // 启动时先探一次（不 await：这里还是 `prepareWorkspaceAtStartup` 之前，
  // `getPortableWorkspaceRoot()` 多半仍是 null，真正的装配会在第一次
  // `app:check-for-updates` 时补上）。不 await 也意味着**不会有未处理的 rejection**：
  // `ensurePortableUpdateService` 内部已经把失败收成日志 + 允许重试。
  void ensurePortableUpdateService();

  ipcMain.on('app:portable-update-renderer-ready', () => {
    options.onRendererReady?.();
  });

  ipcMain.handle('app:get-version', (): string => app.getVersion());

  ipcMain.handle('app:get-update-state', () => getPortableUpdateState());

  ipcMain.handle('app:check-for-updates', async (): Promise<UpdateCheckResult> => {
    // 必须 await：首次检查更新必须等装配（含启动器版本探测）落定，
    // 否则 `isPortableUpdateNow()` 已经为真、而服务还没挂上，会掉进
    // electron-updater 那条在盘上没有立足点的分支。
    await ensurePortableUpdateService();
    if (isPortableUpdateNow() || isAutoUpdaterAvailable()) {
      return checkForUpdatesViaUpdater();
    }
    return devCheckResult();
  });

  ipcMain.handle('app:download-update', async (): Promise<{ ok: boolean; error?: string }> => {
    if (!isPortableUpdateNow() && !isAutoUpdaterAvailable()) {
      return { ok: false, error: 'dev-not-supported' };
    }
    await ensurePortableUpdateService();
    return downloadUpdate();
  });

  ipcMain.handle('app:install-update', async (): Promise<{ ok: boolean; error?: string }> => {
    if (!isPortableUpdateNow() && !isAutoUpdaterAvailable()) {
      return { ok: false, error: 'dev-not-supported' };
    }
    await ensurePortableUpdateService();
    return installUpdate();
  });

  ipcMain.handle('app:cancel-update-download', async (): Promise<{ ok: boolean; error?: string }> => {
    if (!isPortableUpdateNow() && !isAutoUpdaterAvailable()) {
      return { ok: false, error: 'dev-not-supported' };
    }
    await ensurePortableUpdateService();
    return cancelUpdateDownload();
  });
}
