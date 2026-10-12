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
import { hasLiveTurnSessions } from '../artifact/turn-lifecycle.js';
import { hasActiveDeliveryOperations } from '../artifact/delivery-activity.js';

const LAUNCHER_FILE_NAME = '\u8363\u76c8\u9b54\u65b9\u542f\u52a8\u5668.exe';

/**
 * ⭐ 忙态信号（2026-10-11 升级补齐）：**渲染层推来的真实任务/run 活动状态**。
 *
 * 来源是**既有**的 `tray:update-status` 通道（`useTraySync`，App 挂载即生效）：
 * 它在渲染层用 `deriveSessionActivity`（`activeTurnBySession` + `processingBySession`）
 * 算"有没有任务在跑"，每次变化都推一次。这里**只多挂一个监听**，不新增通道、
 * 不新增第二套运行状态（更新模块不该自己发明一套"忙"的判据）。
 *
 * 用途只有一处：`app:install-update` 在真正调 `installUpdate()`（盘上形态 = 启动启动器
 * + 退出应用；装机版 = quitAndInstall）**之前**再挡一次。盘上形态还有第二道同源闸：
 * 便携服务的 `requestRestart` 边界（见 `portable-update-service.ts` 的 `isBusy`）。
 *
 * ⚠️ 保守口径（仅针对渲染层推送）：**读不到推送就说"不忙"**（渲染层还没挂上、老 preload、
 *    测试替身）。"不知道"永远不该变成"永远不让更新" —— 界面那一层（设置 → 关于）本来就是
 *    第一道门，这里的职责是堵住竞态/程序化路径。
 * ⚠️ 只把 `running` 当忙：`unread`（有结果没看）和 `idle` 都不是在跑。
 */
let rendererTaskActivity: 'idle' | 'running' | 'unread' = 'idle';

function noteRendererTaskActivity(status: unknown): void {
  if (status === 'running' || status === 'unread' || status === 'idle') rendererTaskActivity = status;
}

function isAppBusy(): boolean {
  // **三源取或**（评审要点：生成/写文件期间不得退出应用或启动替换，不能只靠按钮灰掉）：
  //   ① 渲染层推来的任务活动（本文件上方，tray 同源）；
  //   ② 主进程「这一轮在跑」软状态（artifact/turn-lifecycle，网关 lifecycle 同源）——
  //      堵住"渲染层推送尚未到达 / 已落后"的竞态窗；
  //   ③ 交付操作在途（artifact/delivery-activity 的 active 集）——
  //      堵住"turn 已结束、但写盘/登记还在途"的窗口（这正是仅靠渲染层判据会漏的那段）。
  // ②③ 是主进程自己的真状态：集合非空即忙，等真实事件（lifecycle end/settle、交付终态）
  // 收敛后自动解除——不是固定等待，也不会因一次 UI 渲染滞后而误放行。
  return rendererTaskActivity === 'running' || hasLiveTurnSessions() || hasActiveDeliveryOperations();
}

interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  releaseUrl: string;
  releaseNotes?: string | null;
  state: string;
  portable: boolean;
  /**
   * ⭐ B2（2026-10-11 整改）：这次结果**实际归属**的频道（渲染层按它记通知去重键）。
   *
   * ⚠️ 刻意与"当前设置里的频道"分开：盘上形态的**已就绪候选/在途事务属于创建它的
   *    那个频道**（`ensurePortableUpdateService` 在事务活跃时**不换血**），用户切了
   *    频道之后这次检查回报的仍是旧频道的事务 —— 归属必须如实是这个事务的频道。
   * ⚠️ 复审二轮：频道由 `checkForUpdatesViaUpdater` 在**创建检查的那一刻**锁定，
   *    本文件不再按调用者时刻重标（加入在飞检查的调用拿到创建者的频道）。
   */
  channel: 'stable' | 'beta';
}

function buildTimePublicKey(): string {
  return typeof __MOFANG_UPDATE_PUBLIC_KEY_B64__ === 'string' ? __MOFANG_UPDATE_PUBLIC_KEY_B64__ : '';
}

function portableChannel(): PortableUpdateChannel {
  return getUpdateChannel() === 'beta' ? 'internal' : 'stable';
}

/**
 * ⭐ B2：盘上频道（渲染层词汇）—— 装配服务时随 `attachPortableUpdateService` 一起交给
 * auto-updater，由它在**创建检查的那一刻**绑定进结果（复审二轮：归属必须跟着创建者，
 * 加入在飞检查的调用不许按自己的时刻重标）。
 */
function portableChannelLabel(channel: PortableUpdateChannel): 'stable' | 'beta' {
  return channel === 'internal' ? 'beta' : 'stable';
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
    channel: getUpdateChannel(),
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
    // 忙态判据（真实任务/run 活动）——见文件上方 `rendererTaskActivity` 的注释。
    // 服务在 `requestRestart` 的**最后边界**（启动启动器/退出之前）再查一次。
    isBusy: () => isAppBusy(),
  });
  if (generation === portableInitializationGeneration) {
    // ⭐ B2（复审二轮）：频道随服务一起交给 auto-updater —— 检查结果在**创建那一刻**
    //    绑定的频道就是这里给出的（在飞/就绪事务所属服务的频道；服务不换血就不变）。
    attachPortableUpdateService(service, portableChannelLabel(channel));
  }
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

  // ⭐ 忙态信号：**既有**通道再加一个监听（`tray-handlers` 那边照旧，互不影响）。
  //    只读 `status`：`useTraySync` 用 `deriveSessionActivity`（真实 run 状态）算出来的
  //    'running'/'unread'/'idle'。不新增通道、不新增第二套运行状态。
  ipcMain.on('tray:update-status', (_event, payload: { status?: unknown }) => {
    noteRendererTaskActivity(payload?.status);
  });

  ipcMain.handle('app:get-version', (): string => app.getVersion());

  ipcMain.handle('app:get-update-state', () => getPortableUpdateState());

  ipcMain.handle('app:check-for-updates', async (): Promise<UpdateCheckResult> => {
    // 必须 await：首次检查更新必须等装配（含启动器版本探测）落定，
    // 否则 `isPortableUpdateNow()` 已经为真、而服务还没挂上，会掉进
    // electron-updater 那条在盘上没有立足点的分支。
    await ensurePortableUpdateService();
    if (isPortableUpdateNow() || isAutoUpdaterAvailable()) {
      // ⭐ B2（复审二轮）：频道归属**随创建检查的那一刻**锁定（见 auto-updater 的
      //    `checkForUpdatesViaUpdater`）—— 这里不再按调用者时刻重标：后到的调用
      //    （含"检查在飞时用户切了频道"）复用同一份在飞结果，如实拿到**创建者**的
      //    频道；需要新频道的检查按现有流程排下一次（下一次调用自然用新频道创建）。
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
    // ⭐ 忙态边界（2026-10-11 升级补齐）：生成/写文件期间**不得**退出应用或启动替换。
    //    检查/下载不受这条影响（运行中仍允许，ready 候选留给用户稍后安装）。
    //    ⚠️ 界面按钮灰掉只是观感；这里堵的是双击、竞态与程序化触发那条路。
    //    盘上形态在便携服务的 `requestRestart` 边界还有一次同源复查（见 deps.isBusy）。
    if (isAppBusy()) {
      getDebugLogger().info({ domain: 'updater', event: 'updater.install.refused-busy' });
      return { ok: false, error: 'app-busy' };
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
