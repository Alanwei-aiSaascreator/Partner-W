import { app, BrowserWindow } from 'electron';
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import electronUpdater from 'electron-updater';
import type { UpdateInfo, ProgressInfo } from 'electron-updater';
import { CancellationToken } from 'builder-util-runtime';
import { is } from '@electron-toolkit/utils';
import { getDebugLogger } from './debug/index.js';
import { getPortableWorkspaceRoot, readConfig } from './workspace/config.js';

type UpdateChannel = 'stable' | 'beta';

export function getUpdateChannel(): UpdateChannel {
  return readConfig()?.updateChannel === 'beta' ? 'beta' : 'stable';
}

const { autoUpdater } = electronUpdater;

type UpdaterState = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error';

interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  releaseUrl: string;
  releaseNotes?: string | null;
  /**
   * 主进程此刻的更新状态。
   *
   * ⚠️ 界面**必须**用它来渲染「下载中/已下载」，不能只凭 `hasUpdate` 就显示成
   *    「可下载」—— 那正是 2026-09-18 实测的毛病：自动下载已经完成，用户进设置
   *    点一下「检查更新」，界面又变回「下载」，而主进程其实早下好了。
   */
  state: UpdaterState;
  /**
   * 这一进程是「盘上运行」（U 盘形态）。
   *
   * U 盘版**不该**自动下载、也不该安装：装到本机只会多出一份副本，盘上那份还是旧的。
   * 界面据此换成"请换包"的提示。
   */
  portable: boolean;
}

type UpdateErrorCode = 'dev-not-supported' | 'network' | 'no-release-metadata' | 'signature' | 'unknown';

/**
 * 更新源地址（generic provider，与 electron-builder.yml 的 `publish` 必须一致）。
 *
 * 绝不要指回上游 `clawwork-ai/clawwork`：那样用户点「检查更新」会把 ClawWork
 * 官方包当成新版本下载并安装（`autoInstallOnAppQuit` 还会在退出时静默装上），
 * 整个商业层会被覆盖掉。
 *
 * 该目录同时充当「手动下载」链接的落点。现在目录里没有文件 —— 查不到更新
 * 即是「已是最新」；将来把 latest.yml 与安装包放上去就能启用，不用再改代码。
 */
const UPDATE_FEED_BASE = 'https://api.rongyinghudong.com/updates/';

let initialized = false;
let state: UpdaterState = 'idle';
let inFlightCheck: Promise<UpdateCheckResult> | null = null;
let installingUpdate = false;
let currentDownloadToken: CancellationToken | null = null;
/** 已经**落盘**的那个版本（`update-downloaded` 事件给的）。用来分辨"已下载的正是这个版本"。 */
let downloadedVersion: string | null = null;
/** 最近一次检查看到的最新版本（取消下载时用来记住"这个版本用户不要了"）。 */
let latestKnownVersion: string | null = null;
/** 用户手动取消过的版本：同版本不再自动下载（换版本照常自动下）。 */
let cancelledVersion: string | null = null;

/** 点了「安装」之后等安装器接管本进程的看门狗（见 installUpdate）。 */
const INSTALL_WATCHDOG_MS = 15_000;
/** 多久没动过的残留才算"确定没用"（给同机另一份副本留足退出安装的时间）。 */
const STALE_INSTALLER_MS = 24 * 60 * 60 * 1000;

/**
 * 这一进程是不是「盘上运行」（U 盘形态）。
 *
 * ⚠️ 只能在**用的时候**现问，不能在 `initAutoUpdater()` 里缓存：启动次序上
 *    `registerUpdateHandlers()`（main/index.ts:240，其内部才调 `initAutoUpdater()`）跑在
 *    `prepareWorkspaceAtStartup()`（main/index.ts:274）**之前**，那一刻判定还不存在。
 *    检查/下载/安装都发生在启动之后（都由渲染进程 IPC 触发），现问是准的。
 */
function isPortableModeNow(): boolean {
  return getPortableWorkspaceRoot() !== null;
}

function broadcast(channel: string, data: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.webContents.send(channel, data);
    } catch {}
  }
}

function normalizeReleaseNotes(info: UpdateInfo): string | null {
  if (!info.releaseNotes) return null;
  if (typeof info.releaseNotes === 'string') return info.releaseNotes;
  if (Array.isArray(info.releaseNotes)) {
    return info.releaseNotes.map((n) => (typeof n === 'string' ? n : (n.note ?? ''))).join('\n');
  }
  return null;
}

function classifyError(err: unknown): UpdateErrorCode {
  const msg = err instanceof Error ? err.message : String(err);
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|network/i.test(msg)) return 'network';
  if (/latest.*yml|no published/i.test(msg)) return 'no-release-metadata';
  if (/signature|verify|checksum/i.test(msg)) return 'signature';
  return 'unknown';
}

export function isAutoUpdaterAvailable(): boolean {
  return !is.dev && app.isPackaged;
}

export function isInstallingUpdate(): boolean {
  return installingUpdate;
}

export function initAutoUpdater(): void {
  if (!isAutoUpdaterAvailable()) return;
  if (initialized) return;
  initialized = true;

  // T-U3：远程/无人值守的用户不会主动去点「下载」，所以检查完就**自动下载**。
  // ⚠️ 但下载由**我们自己**驱动（见 checkForUpdatesViaUpdater 里的 downloadUpdate()），
  //    不用 electron-updater 的 autoDownload：那条路 token 在库手里，
  //    「取消下载」根本取消不掉（点了没反应、字节还在流，2026-09-18 审阅实测指出）。
  // 安装时机仍由用户决定：`autoInstallOnAppQuit` 让下载好的更新在退出时装上，
  // 用户也可以提前在「设置 → 关于」里点安装。
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.autoRunAppAfterInstall = true;

  const logger = getDebugLogger();
  autoUpdater.logger = {
    info: (msg: unknown) => logger.info({ domain: 'updater', event: 'updater.info', message: String(msg) }),
    warn: (msg: unknown) => logger.warn({ domain: 'updater', event: 'updater.warn', message: String(msg) }),
    error: (msg: unknown) => logger.error({ domain: 'updater', event: 'updater.error', message: String(msg) }),
    debug: (msg: unknown) => logger.debug({ domain: 'updater', event: 'updater.debug', message: String(msg) }),
  };

  autoUpdater.on('download-progress', (progress: ProgressInfo) => {
    state = 'downloading';
    broadcast('update:download-progress', {
      percent: Math.round(progress.percent),
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total,
    });
  });

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    state = 'downloaded';
    downloadedVersion = info.version;
    broadcast('update:downloaded', { version: info.version });
  });

  autoUpdater.on('error', (err: Error) => {
    state = 'error';
    broadcast('update:error', { message: err.message, code: classifyError(err) });
  });
}

/**
 * 更新缓存的日常维护：上次"说要装却没装成"留一条日志 + 清掉已装版本的残留安装包。
 *
 * ⚠️ **必须由 `main/index.ts` 在 `prepareWorkspaceAtStartup()` 之后调用**，不能塞进
 *    `initAutoUpdater()`：清理要靠 `getPortableWorkspaceRoot()` 分辨"这一进程是不是
 *    盘上运行"，而那个判定正是工作区准备阶段写下的 —— 放在 init（`registerUpdateHandlers`，
 *    更早）那一刻恒为 null，U 盘那份就会去清**本机共享**的更新缓存，把同机另一份副本
 *    正等着退出安装的包删掉（那边会静默 ENOENT 失败）。
 */
export function runUpdaterStartupHousekeeping(): void {
  verifyPreviousInstall();
  cleanupStalePendingInstallers();
}

export async function checkForUpdatesViaUpdater(): Promise<UpdateCheckResult> {
  if (inFlightCheck) return inFlightCheck;

  const promise = (async (): Promise<UpdateCheckResult> => {
    const currentVersion = app.getVersion();
    const portable = isPortableModeNow();
    autoUpdater.allowPrerelease = getUpdateChannel() === 'beta';

    // ⚠️ 状态一律按**判定那一刻的事实**，不能用 `await` 之前的快照：下载完全可能
    //    在这次检查飞行途中就完成（pending 里已有校验过的包时只需校验哈希，窗口是
    //    秒级），那时快照还是 idle，一回写就把刚下好的更新打回 `available`
    //    ⇒ `installUpdate()` 报 `no-downloaded-update`，界面却显示成"可下载"。
    //    这正是 2026-09-18 实测的毛病，别再用快照把它引回来。
    const holdUpdate = (): UpdaterState => (state === 'downloaded' || state === 'downloading' ? state : 'idle');

    try {
      const result = await autoUpdater.checkForUpdates();
      if (!result || !result.updateInfo) {
        state = holdUpdate();
        return {
          currentVersion,
          latestVersion: currentVersion,
          hasUpdate: false,
          releaseUrl: '',
          state,
          portable,
        };
      }

      const info = result.updateInfo;
      const latestVersion = info.version;
      // ⚠️ 判据是**比本机新**，不是"不相等"（2026-09-20 实测：打包态 0.0.24 跑着、
      //    更新源上是 0.0.23，左下角却亮着「有新版本可用」）。降级不是更新 ——
      //    electron-updater 自己就拒绝降级，亮角标只会让用户点进去撞一头雾水。
      //    ⚠️ 必须用**数字**比较：`compareVersions` 逐段 `Number()`，
      //    字符串比会把 `0.0.9 → 0.0.10` 判反。
      const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;
      latestKnownVersion = latestVersion;

      if (hasUpdate) {
        if (downloadedVersion === latestVersion) {
          // 已经下好的正是这个版本 ⇒ 保持 downloaded，别再下一次
          state = 'downloaded';
        } else if (state === 'downloading') {
          // 下载在飞：别降级（降级后「取消下载」会变成假的）
          state = 'downloading';
        } else {
          state = 'available';
          // T-U3：远程/无人值守的用户不会主动点「下载」⇒ 非便携形态查完就**自动下载**。
          // 便携形态不下载：装也装不到盘上，白下 239MB（界面换成"换包"提示）。
          // 用户手动取消过的那个版本也不再自动下（只留手动入口）。
          if (!portable && cancelledVersion !== latestVersion) void downloadUpdate().catch(() => {});
        }
      } else {
        state = holdUpdate();
      }

      return {
        currentVersion,
        latestVersion,
        hasUpdate,
        releaseUrl: UPDATE_FEED_BASE,
        releaseNotes: normalizeReleaseNotes(info),
        state,
        portable,
      };
    } catch (err) {
      state = state === 'downloaded' || state === 'downloading' ? state : 'error';
      getDebugLogger().warn({
        domain: 'updater',
        event: 'updater.check-failed',
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      inFlightCheck = null;
    }
  })();

  inFlightCheck = promise;
  return promise;
}

export async function downloadUpdate(): Promise<{ ok: boolean; error?: string }> {
  // U 盘形态：要的是新包，不是把包装到本机（见 isPortableModeNow 的说明）
  if (isPortableModeNow()) return { ok: false, error: 'portable-manual-update' };
  // 已经下好了就直接成功 —— 用户多点一次「下载」不该再下一个 239MB。
  // 顺带把事实广播一次：界面可能因为错过了 update:downloaded 而停在 0% 的"下载中"。
  if (state === 'downloaded') {
    if (downloadedVersion) broadcast('update:downloaded', { version: downloadedVersion });
    return { ok: true };
  }
  if (state !== 'available') {
    return { ok: false, error: 'no-update-available' };
  }
  cancelledVersion = null; // 手动点了下载 ⇒ 之前那次"取消"作数完毕
  state = 'downloading';
  const token = new CancellationToken();
  currentDownloadToken = token;
  try {
    await autoUpdater.downloadUpdate(token);
    return { ok: true };
  } catch (err) {
    const cancelled = token.cancelled || (err as { isCancelled?: boolean })?.isCancelled === true;
    if (cancelled) {
      state = 'available';
      return { ok: false, error: 'cancelled' };
    }
    state = 'error';
    const message = err instanceof Error ? err.message : String(err);
    broadcast('update:error', { message, code: classifyError(err) });
    return { ok: false, error: message };
  } finally {
    if (currentDownloadToken === token) currentDownloadToken = null;
  }
}

export function cancelUpdateDownload(): { ok: boolean; error?: string } {
  if (state !== 'downloading' || !currentDownloadToken) {
    return { ok: false, error: 'no-download-in-progress' };
  }
  // 记住"这个版本用户不要了"：否则下一次检查（切渠道、重开设置页都会触发）会把
  // 那 239MB 又拉起来，用户以为取消了却看着进度条自己动。
  cancelledVersion = latestKnownVersion;
  currentDownloadToken.cancel();
  return { ok: true };
}

export function installUpdate(): { ok: boolean; error?: string } {
  // U 盘形态不安装：装到本机只会在别的盘上多出一份副本，用户要的是"换包"
  if (isPortableModeNow()) return { ok: false, error: 'portable-manual-update' };
  if (state !== 'downloaded') {
    return { ok: false, error: 'no-downloaded-update' };
  }
  installingUpdate = true;
  getDebugLogger().info({
    domain: 'updater',
    event: 'updater.install.requested',
    data: {
      version: app.getVersion(),
      exePath: app.getPath('exe'),
      appPath: app.getAppPath(),
      isPackaged: app.isPackaged,
      isInApplications: process.platform !== 'darwin' || app.getPath('exe').startsWith('/Applications/'),
    },
  });
  writeInstallMarker(downloadedVersion);
  setImmediate(() => {
    getDebugLogger().info({ domain: 'updater', event: 'updater.install.quit-and-install.called' });
    // ⚠️ 第一个参数是 **isSilent**：`false`（旧行为）会让 NSIS 弹出安装向导等人点
    //    —— 2026-09-18 实测窗口标题「荣盈魔方 安装」就卡在那儿，而承诺是
    //    "自动更新，什么都不用做"。第二个参数 = 装完把新版本拉起来。
    autoUpdater.quitAndInstall(true, true);

    // 安装器本该在几秒内把本进程带走。15 秒后如果**还没开始退出**，说明这次安装压根没起来
    //（`installerPath` 为空、或 `quitAndInstallCalled` 闩锁吞掉了这次调用）。
    // 不兜这一下的话 `installingUpdate` 会永远卡住（连关窗都不再最小化），用户也不知道
    // 出了什么事。⚠️ 它**兜不住**"per-machine 安装在 UAC 被拒"那条路：那条路 spawn 是
    // 成功的、我们会正常退出，用户看到的仍是"应用没了"—— 那种情况只能靠下次启动的
    // 装后校验字条说话（`updater.install.not-applied`）。
    const watchdog = setTimeout(() => {
      installingUpdate = false;
      // ⚠️ 状态**保持 downloaded**：包还好端端在盘上，"可以安装"这个事实没变
      //    （打成 error 的话用户再点安装会得到 no-downloaded-update，白白丢掉重试机会）
      getDebugLogger().warn({
        domain: 'updater',
        event: 'updater.install.did-not-start',
        data: { version: app.getVersion() },
      });
      broadcast('update:error', { message: 'install-did-not-start', code: 'unknown' });
    }, INSTALL_WATCHDOG_MS);

    // 退出流程真的开始了就撤掉看门狗：慢机器上收尾（刷日志 + 关网关 + 关库）可能超过
    // 15 秒，不撤的话会在**一次成功的安装**里打出假警告、还让界面变错误态。
    app.once('before-quit', () => clearTimeout(watchdog));
  });
  return { ok: true };
}

// ---------------------------------------------------------------- 安装后校验

/**
 * 安装前留一张字条（目标版本），下次启动比对 —— 只写调试日志，不打扰用户。
 *
 * 为什么不用告诉用户：装没装上**是自明的** —— 更新检查会照常再报一次（那份包因为
 * "比当前新必须保留"还在 pending 里，重下是缓存命中、很快），用户点一下就能重试。
 * 这张字条的价值是排障时能一眼看出"上次说要 0.0.22，结果还停在 0.0.21"。
 */
function writeInstallMarker(targetVersion: string | null): void {
  try {
    writeFileSync(
      installMarkerPath(),
      JSON.stringify({ targetVersion, fromVersion: app.getVersion(), at: new Date().toISOString() }),
      'utf8',
    );
  } catch {
    // 写不了就算了：这只是排障线索，不该影响安装
  }
}

function installMarkerPath(): string {
  return join(app.getPath('userData'), 'pending-update.json');
}

function verifyPreviousInstall(): void {
  const marker = installMarkerPath();
  try {
    if (!existsSync(marker)) return;
    const info = JSON.parse(readFileSync(marker, 'utf8')) as { targetVersion?: string | null };
    // 版本号两边都归一化（feed 里写成 `v0.0.22` 也认得），免得打出假的 not-applied
    const normalize = (v: string | null | undefined): string | null => (v ? v.replace(/^v/i, '').trim() : null);
    const target = normalize(info.targetVersion);
    const current = normalize(app.getVersion());
    // 字条没写目标版本 ⇒ 我们**不知道**装没装上，别冒充"装上了"
    const [level, event] = !target
      ? ['warn', 'updater.install.marker-unreadable']
      : target === current
        ? ['info', 'updater.install.applied']
        : ['warn', 'updater.install.not-applied'];
    getDebugLogger()[level as 'info' | 'warn']({
      domain: 'updater',
      event,
      data: { targetVersion: target, currentVersion: current },
    });
    rmSync(marker, { force: true });
  } catch {
    try {
      rmSync(marker, { force: true });
    } catch {
      // 坏字条删不掉也无所谓，下次还会走这里
    }
  }
}

// ---------------------------------------------------------------- 更新缓存清理

/**
 * 解析 `荣盈魔方-0.0.21-win-x64.exe` 里的版本号；认不出来返回 null（那种文件不碰）。
 *
 * ⚠️ 两条都别省：
 * ① 版本形状必须**带点**（`\d+\.\d+`）—— 否则 `-win-x64.exe` 尾巴上的 `x64` 会被当成版本；
 * ② 取**最后一个**候选。取第一个的话，artifactName 前面一旦也带版本形状
 *   （`…-setup-1.0.0-荣盈魔方-0.0.22.exe`），就会按 `1.0.0` 判定 ⇒ 可能把比当前**新**的包删掉。
 *   取最后一个，误判只会落到"保留"这个安全侧。
 */
function versionFromFileName(name: string): string | null {
  const matches = [...name.matchAll(/(\d+\.\d+(?:\.\d+)*)/g)];
  return matches.at(-1)?.[1] ?? null;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * 更新缓存目录（`<LOCALAPPDATA>\<updaterCacheDirName>\`）—— 与 electron-updater
 * 自己的算法保持一致：缓存的**父目录**按平台取，目录名读**打包时的** `app-update.yml`
 * （electron-builder 写的 `updaterCacheDirName`）。读不到就返回 null、什么都不做。
 */
function updaterCacheDir(): string | null {
  let base: string | undefined;
  if (process.platform === 'win32') base = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
  else if (process.platform === 'darwin') base = join(homedir(), 'Library', 'Caches');
  else base = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  if (!base) return null;

  let dirName: string | null = null;
  try {
    const yml = readFileSync(join(process.resourcesPath, 'app-update.yml'), 'utf8');
    dirName = yml.match(/^updaterCacheDirName:\s*'?([^'\r\n]+)'?\s*$/m)?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
  return dirName ? join(base, dirName) : null;
}

/**
 * 清掉更新缓存里**已经没有意义**的安装包。
 *
 * 为什么要有这个：安装是"新版本的安装器在跑"，装完之后那份安装包就没人会再用了，
 * 但 electron-updater 不会删它 —— 实测每次更新在一台机器上留下 **239MB**，
 * 而且要等到**下一次**更新下载时才会被覆盖。
 *
 * 只清两类，且都在 `pending\` 里、且**至少 24 小时没动过**：
 * ① 文件名里版本 **≤ 当前运行版本** 的文件（已经装上了，不可能再用）；
 * ② `temp-*`（半截下载）。
 * 比当前版本**新**的一律保留 —— 那正是"下好了还没装"的那份。
 *
 * ⚠️ 两个保守设定都不是多余的：缓存目录是**用户级共享**的（同机装了第二份副本时
 *    它们共用一个 `pending\`）。删太快就可能删掉"另一份副本刚下好、正等着退出安装"
 *    的那个包 —— 那边会静默 ENOENT 失败。所以：a) 盘上运行的那份一律不清理；
 *    b) 刚动过的文件不碰；c) 认不出版本、版本比不出大小的，一律保留。
 */
function cleanupStalePendingInstallers(): void {
  const cacheDir = updaterCacheDir();
  if (!cacheDir) return;

  // ⚠️ 盘上运行（U 盘那份）**绝不碰**本机的更新缓存：缓存是用户级共享的
  //   （LOCALAPPDATA + 同一个 cacheDirName），里面那份可能正是"本机那份等着
  //   退出安装"的包 —— 删了它的安装会 ENOENT 静默失败。
  if (isPortableModeNow()) return;

  const currentVersion = app.getVersion();
  // 预发布版本（0.0.22-beta.1 之类）不参与比较：比不出大小就别删（安全侧）
  if (!/^\d+(\.\d+)*$/.test(currentVersion)) return;

  const pending = join(cacheDir, 'pending');
  const removed: string[] = [];
  try {
    for (const name of readdirSync(pending)) {
      const full = join(pending, name);
      try {
        const stat = statSync(full);
        if (!stat.isFile()) continue;

        // 刚动过的文件一律不碰：可能正在下载（temp-*），也可能是同机另一份副本
        // 刚下好、正等着退出安装（共享缓存，见上面那条注释）。
        if (Date.now() - stat.mtimeMs < STALE_INSTALLER_MS) continue;

        if (name.startsWith('temp-')) {
          rmSync(full, { force: true });
          removed.push(name);
          continue;
        }

        const version = versionFromFileName(name);
        if (version && compareVersions(version, currentVersion) <= 0) {
          rmSync(full, { force: true });
          removed.push(name);
        }
      } catch {
        // 单个文件删不掉（占用/权限）就算了，别让清理影响启动
      }
    }
  } catch {
    // pending 目录不存在/读不了：正常情况（从没下载过更新）
    return;
  }

  if (removed.length) {
    getDebugLogger().info({
      domain: 'updater',
      event: 'updater.cache.cleaned',
      data: { currentVersion, removed },
    });
  }
}
