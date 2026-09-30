import { app, ipcMain, dialog, BrowserWindow, shell } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'path';
import {
  getWorkspacePath,
  writeConfig,
  updateConfig,
  isWorkspaceConfigured,
  getDefaultWorkspacePath,
  getPortableWorkspaceRoot,
  ensureDeviceId,
} from '../workspace/config.js';
import { initWorkspace, migrateWorkspace } from '../workspace/init.js';
import { probeWorkspaceFsIdentity } from '../workspace/fs-identity.js';
import { workspaceLocationPatch } from '../workspace/portable.js';
import { refreshRemovableDrives } from '../workspace/removable-drives.js';
import { reinitDatabase, closeDatabase, getSqlite } from '../db/index.js';
import { buildKbRuntime, ensureKbRuntime, resetKbRuntime } from '../kb/runtime.js';
import { registerDeliveryActivityHandlers } from '../artifact/delivery-activity.js';

/**
 * 换库之后重建资料库运行时。
 *
 * ⚠️ **必须先 reset 再建**：`KbService` 抓着的是**旧的 sqlite 实例**，而
 * `reinitDatabase` 已经把连接关掉换成新的了 —— 继续用旧服务就是往一个关掉的连接上写。
 * 表现是"换完工作区后资料库就不动了"，而且只在换盘这条路径上出现。
 */
function restartKbRuntime(): void {
  resetKbRuntime();
  void ensureKbRuntime(() => {
    const sqlite = getSqlite();
    if (!sqlite) throw new Error('工作区库未初始化');
    return buildKbRuntime({
      sqlite,
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
      log: () => {
        /* 换库路径上不额外记日志：`kb.runtime.*` 在启动那条已经记过 */
      },
    });
  }).catch(() => {
    /* 建不起来就是纯关键词检索（合法降级），换工作区不该因此失败 */
  });
}

const TEAM_WORKSPACE_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * 工作区落在**可移动盘**上、或落在**程序自己运行的那块盘**上时，补记"相对盘根 + 盘根 marker"
 * 两个字段（T-U1 的盘符自愈就靠它们找回来）。两条都不满足则显式清掉旧线索。
 *
 * ⚠️ 这里**重新枚举**（不是用启动时那份缓存）：用户完全可能先开应用、后插盘，
 *    再用这个入口把工作区设到那个盘上 —— 用缓存的话那一刻的列表里没有它，
 *    线索就永远记不上（见 `refreshRemovableDrives`）。
 */
function locationPatch(workspacePath: string): { workspaceRelPath?: string; volumeMarker?: string } {
  return workspaceLocationPatch({
    workspacePath,
    removableDrives: refreshRemovableDrives(),
    exists: existsSync,
    // 程序自己所在的那块盘（盘上形态才有）：`DriveType=3` 的盘不在可移动盘列表里，
    // 少了这一条，用户把工作区设到那块盘上时一条线索都记不上（换口就丢）。
    runVolumeRoot: getPortableWorkspaceRoot(),
  });
}

export interface WorkspaceHandlerDeps {
  /**
   * Keep the already-running portable runtime's `agents.entries.main.workspace`
   * aligned with the desktop workspace before the desktop commits the change.
   */
  syncRuntimeWorkspace?: (workspacePath: string) => Promise<void>;
}

export function registerWorkspaceHandlers(deps: WorkspaceHandlerDeps = {}): void {
  registerDeliveryActivityHandlers();
  ipcMain.handle('workspace:open-folder', () => {
    const p = getWorkspacePath();
    if (p) shell.openPath(p);
  });

  ipcMain.handle('workspace:is-configured', isWorkspaceConfigured);
  ipcMain.handle('workspace:get-path', getWorkspacePath);
  ipcMain.handle('workspace:get-default', getDefaultWorkspacePath);
  /**
   * 这一进程是不是**盘上运行**（U 盘形态）。
   *
   * ⭐ 为什么要单独给一条：界面上有一句**只对盘上版成立**的说明
   *    （「这不是安装…拔掉 U 盘后仍可继续用」）。以前那句话活在一个**没人渲染**的
   *    整屏里（[[tests-keep-dead-code-alive]]），用户一个字都看不到。
   * ⚠️ 现问现答、不缓存：判定依赖启动次序（见 auto-updater 里那段说明）。
   */
  ipcMain.handle('workspace:is-portable', () => getPortableWorkspaceRoot() !== null);

  ipcMain.handle('workspace:browse', async () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return null;

    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory'],
      title: '选择工作区目录',
      defaultPath: getDefaultWorkspacePath(),
    });

    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('workspace:setup', async (_event, workspacePath: string) => {
    try {
      await initWorkspace(workspacePath);
      reinitDatabase(workspacePath);
      restartKbRuntime();
      // writeConfig 是**整份覆盖**：`portableSetupPending` 这类首启标记到这里就该没了
      writeConfig({ workspacePath, gateways: [], ...locationPatch(workspacePath) });
      ensureDeviceId();
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'setup failed';
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle('workspace:change', async (_event, newWorkspacePath: string) => {
    const oldPath = getWorkspacePath();
    if (!oldPath) return { ok: false, error: 'no current workspace' };
    if (oldPath === newWorkspacePath) return { ok: true };
    let runtimeSyncAttempted = false;
    try {
      closeDatabase();
      await migrateWorkspace(oldPath, newWorkspacePath);
      if (deps.syncRuntimeWorkspace) {
        runtimeSyncAttempted = true;
        await deps.syncRuntimeWorkspace(newWorkspacePath);
      }
      reinitDatabase(newWorkspacePath);
      restartKbRuntime();
      updateConfig({ workspacePath: newWorkspacePath, ...locationPatch(newWorkspacePath) });
      const win = BrowserWindow.getAllWindows()[0];
      if (win) win.webContents.send('workspace:changed', newWorkspacePath);
      return { ok: true };
    } catch (err) {
      if (runtimeSyncAttempted && deps.syncRuntimeWorkspace) {
        try {
          await deps.syncRuntimeWorkspace(oldPath);
        } catch {
          // Keep the original failure as the user-facing result. The runtime
          // sync uses an atomic writer, so this rollback is a best-effort guard
          // for failures after the new value had already been committed.
        }
      }
      reinitDatabase(oldPath);
      restartKbRuntime();
      return { ok: false, error: err instanceof Error ? err.message : 'migration failed' };
    }
  });

  ipcMain.handle('workspace:get-device-id', () => {
    return ensureDeviceId();
  });

  /**
   * 工作区所在文件系统的身份（FAT32 上 `dev = 0` ⇒ 助手读写身份文件必失败）。
   *
   * ⚠️ 探测在**工作区根**做：fs-safe 校验的是工作区里那些身份文件所在的卷，
   *    而同一次安装里它们都在同一个卷上（助手目录是工作区的子目录）。
   *    没有工作区 ⇒ `unknown`（**不是** ok：没量到就不许说"没问题"）。
   */
  ipcMain.handle('workspace:fs-identity', () => {
    const workspacePath = getWorkspacePath();
    if (!workspacePath) return { state: 'unknown', dev: null, ino: null };
    return probeWorkspaceFsIdentity(workspacePath);
  });

  ipcMain.handle('workspace:team-path', (_event, slug: string) => {
    if (typeof slug !== 'string' || !TEAM_WORKSPACE_SLUG_RE.test(slug)) {
      throw new Error('Invalid team slug');
    }
    const base = getWorkspacePath();
    // ⚠️ **不许 `return slug`**（2026-09-20 U 盘交付实机改掉的行为）：调用方拿这个字符串
    //    去 `agents.create`，而那是**另一个进程**按它自己的 home 解析相对路径
    //    ⇒ 每个助手都建失败，界面只剩 `No agents were created successfully`。
    //    没有工作区就明确报错，由渲染侧翻成中文（见 `lib/install-workspace.ts`）。
    if (!base) throw new Error('workspace not configured');
    return join(base, slug);
  });
}
