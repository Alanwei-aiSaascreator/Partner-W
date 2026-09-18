import { ipcMain, dialog, BrowserWindow, shell } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'path';
import {
  getWorkspacePath,
  writeConfig,
  updateConfig,
  isWorkspaceConfigured,
  getDefaultWorkspacePath,
  ensureDeviceId,
} from '../workspace/config.js';
import { initWorkspace, migrateWorkspace } from '../workspace/init.js';
import { workspaceLocationPatch } from '../workspace/portable.js';
import { refreshRemovableDrives } from '../workspace/removable-drives.js';
import { reinitDatabase, closeDatabase } from '../db/index.js';

const TEAM_WORKSPACE_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * 工作区落在**可移动盘**上时，补记"相对盘根 + 盘根 marker"两个字段
 * （T-U1 的盘符自愈就靠它们找回来）。不在可移动盘上则显式清掉旧线索。
 *
 * ⚠️ 这里**重新枚举**（不是用启动时那份缓存）：用户完全可能先开应用、后插盘，
 *    再用这个入口把工作区设到那个盘上 —— 用缓存的话那一刻的列表里没有它，
 *    线索就永远记不上（见 `refreshRemovableDrives`）。
 */
function locationPatch(workspacePath: string): { workspaceRelPath?: string; volumeMarker?: string } {
  return workspaceLocationPatch({ workspacePath, removableDrives: refreshRemovableDrives(), exists: existsSync });
}

export function registerWorkspaceHandlers(): void {
  ipcMain.handle('workspace:open-folder', () => {
    const p = getWorkspacePath();
    if (p) shell.openPath(p);
  });

  ipcMain.handle('workspace:is-configured', isWorkspaceConfigured);
  ipcMain.handle('workspace:get-path', getWorkspacePath);
  ipcMain.handle('workspace:get-default', getDefaultWorkspacePath);

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
    try {
      closeDatabase();
      await migrateWorkspace(oldPath, newWorkspacePath);
      reinitDatabase(newWorkspacePath);
      updateConfig({ workspacePath: newWorkspacePath, ...locationPatch(newWorkspacePath) });
      const win = BrowserWindow.getAllWindows()[0];
      if (win) win.webContents.send('workspace:changed', newWorkspacePath);
      return { ok: true };
    } catch (err) {
      reinitDatabase(oldPath);
      return { ok: false, error: err instanceof Error ? err.message : 'migration failed' };
    }
  });

  ipcMain.handle('workspace:get-device-id', () => {
    return ensureDeviceId();
  });

  ipcMain.handle('workspace:team-path', (_event, slug: string) => {
    if (typeof slug !== 'string' || !TEAM_WORKSPACE_SLUG_RE.test(slug)) {
      throw new Error('Invalid team slug');
    }
    const base = getWorkspacePath();
    if (!base) return slug;
    return join(base, slug);
  });
}
