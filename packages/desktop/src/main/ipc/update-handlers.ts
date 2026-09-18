import { ipcMain, app } from 'electron';
import {
  initAutoUpdater,
  isAutoUpdaterAvailable,
  checkForUpdatesViaUpdater,
  downloadUpdate,
  installUpdate,
  cancelUpdateDownload,
} from '../auto-updater.js';

interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  releaseUrl: string;
  releaseNotes?: string | null;
  /** 主进程此刻的更新状态（`downloaded` 时界面必须给安装入口）。 */
  state: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error';
  /** 盘上运行（U 盘形态）：界面提示"换包"，不给下载/安装按钮。 */
  portable: boolean;
}

/**
 * 未打包（dev）时 `autoUpdater` 不可用。
 *
 * 这里原先会去查**上游** GitHub 的 release —— 那既会显示一个本机装不上的版本，
 * 又把上游仓库地址带回了客户端。现在不再请求任何远端：更新源已改到自有 feed
 * （见 auto-updater.ts 的 UPDATE_FEED_BASE），而 dev 构建本来也装不了更新
 * （`app:download-update` 直接返回 dev-not-supported）。
 *
 * ⚠️ `state` / `portable` 必须给全：preload 的 `UpdateCheckResult` 把它们声明成必填，
 *    少给的话 dev 下渲染层拿到 `undefined`（现在靠 falsy 侥幸不出事，但类型在说谎）。
 */
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

export function registerUpdateHandlers(): void {
  initAutoUpdater();

  ipcMain.handle('app:get-version', (): string => app.getVersion());

  ipcMain.handle('app:check-for-updates', async (): Promise<UpdateCheckResult> => {
    if (isAutoUpdaterAvailable()) {
      return checkForUpdatesViaUpdater();
    }
    return devCheckResult();
  });

  ipcMain.handle('app:download-update', async (): Promise<{ ok: boolean; error?: string }> => {
    if (!isAutoUpdaterAvailable()) {
      return { ok: false, error: 'dev-not-supported' };
    }
    return downloadUpdate();
  });

  ipcMain.handle('app:install-update', (): { ok: boolean; error?: string } => {
    if (!isAutoUpdaterAvailable()) {
      return { ok: false, error: 'dev-not-supported' };
    }
    return installUpdate();
  });

  ipcMain.handle('app:cancel-update-download', (): { ok: boolean; error?: string } => {
    if (!isAutoUpdaterAvailable()) {
      return { ok: false, error: 'dev-not-supported' };
    }
    return cancelUpdateDownload();
  });
}
