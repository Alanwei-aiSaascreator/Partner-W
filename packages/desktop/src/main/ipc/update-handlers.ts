import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { app, ipcMain } from 'electron';
import type { PortableUpdateChannel } from '@clawwork/shared';
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
} from '../auto-updater.js';
import { getPortableWorkspaceRoot } from '../workspace/config.js';
import {
  downloadPortablePackage,
  extractPortablePackage,
  verifyPortableProgramTree,
} from '../update/portable-package.js';
import { PORTABLE_UPDATE_DIRECTORY_NAME, PortableUpdateStateStore } from '../update/portable-state.js';
import { createPortableUpdateService } from '../update/portable-update-service.js';

const LAUNCHER_FILE_NAME = '\u8363\u76c8\u9b54\u65b9\u542f\u52a8\u5668.exe';
const LAUNCHER_PROTOCOL_VERSION = '1.0.0';

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

let portableInitialized = false;

function ensurePortableUpdateService(): void {
  if (portableInitialized) return;
  const root = getPortableWorkspaceRoot();
  if (root === null) return;
  portableInitialized = true;

  const channel = portableChannel();
  const feed = `${UPDATE_FEED_BASE}${channel}/`;
  const stateStore = new PortableUpdateStateStore({
    stateFilePath: join(root, PORTABLE_UPDATE_DIRECTORY_NAME, 'update-state.json'),
  });

  attachPortableUpdateService(
    createPortableUpdateService({
      root,
      currentVersion: app.getVersion(),
      channel,
      launcherVersion: LAUNCHER_PROTOCOL_VERSION,
      publicKeyBase64: buildTimePublicKey(),
      stateStore,
      fetchManifest: async () => {
        const response = await fetch(`${feed}manifest.json`);
        if (!response.ok) throw new Error(`portable feed responded ${response.status}`);
        return response.json();
      },
      fetchFileManifest: async (manifest) => {
        const response = await fetch(new URL('portable-files.json', manifest.packageUrl).toString());
        if (!response.ok) throw new Error(`portable file manifest responded ${response.status}`);
        return response.json();
      },
      downloadPackage: downloadPortablePackage,
      extractPackage: extractPortablePackage,
      verifyTree: verifyPortableProgramTree,
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
    }),
  );
}

export function registerUpdateHandlers(options: { onRendererReady?: () => void } = {}): void {
  initAutoUpdater();
  ensurePortableUpdateService();

  ipcMain.on('app:portable-update-renderer-ready', () => {
    options.onRendererReady?.();
  });

  ipcMain.handle('app:get-version', (): string => app.getVersion());

  ipcMain.handle('app:get-update-state', () => getPortableUpdateState());

  ipcMain.handle('app:check-for-updates', async (): Promise<UpdateCheckResult> => {
    ensurePortableUpdateService();
    if (isPortableUpdateNow() || isAutoUpdaterAvailable()) {
      return checkForUpdatesViaUpdater();
    }
    return devCheckResult();
  });

  ipcMain.handle('app:download-update', async (): Promise<{ ok: boolean; error?: string }> => {
    if (!isPortableUpdateNow() && !isAutoUpdaterAvailable()) {
      return { ok: false, error: 'dev-not-supported' };
    }
    return downloadUpdate();
  });

  ipcMain.handle('app:install-update', async (): Promise<{ ok: boolean; error?: string }> => {
    if (!isPortableUpdateNow() && !isAutoUpdaterAvailable()) {
      return { ok: false, error: 'dev-not-supported' };
    }
    return installUpdate();
  });

  ipcMain.handle('app:cancel-update-download', (): { ok: boolean; error?: string } => {
    if (!isPortableUpdateNow() && !isAutoUpdaterAvailable()) {
      return { ok: false, error: 'dev-not-supported' };
    }
    return cancelUpdateDownload();
  });
}
