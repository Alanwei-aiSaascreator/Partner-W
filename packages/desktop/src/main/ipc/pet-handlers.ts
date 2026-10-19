import { app, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { basename } from 'node:path';
import {
  applyDesktopOrganize,
  listDesktopEntries,
  planDesktopOrganize,
  safeDesktopChild,
} from '../pet/desktop.js';
import { closePetWindow, movePetWindow, openPetWindow } from '../pet/window.js';

/**
 * 桌面宠物 IPC（2026-10-17 用户：可以看桌面、帮忙整理、**删除/移动前提示**）。
 *
 * 三条硬约束：
 *   ① 只看桌面**这一层**，不递归、不碰文件夹与隐藏文件（见 `pet/desktop.ts`）；
 *   ② **任何移动/删除前都必须弹原生确认框**，并列出要动的文件（最多列 12 个）；
 *   ③ 删除只走回收站（`shell.trashItem`），永不 `unlink` —— 用户能从回收站找回。
 */
function trusted(event: IpcMainInvokeEvent): boolean {
  return Boolean(event.senderFrame && event.senderFrame === event.sender.mainFrame);
}

const desktopDir = (): string => app.getPath('desktop');

function listNames(names: readonly string[]): string {
  const head = names.slice(0, 12).join('\n');
  return names.length > 12 ? `${head}\n…等 ${names.length} 个` : head;
}

export function registerPetHandlers(): void {
  ipcMain.handle('pet:open', (event) => (trusted(event) ? openPetWindow() : { ok: false as const }));
  ipcMain.handle('pet:close', (event) => (trusted(event) ? closePetWindow() : { ok: false as const }));
  ipcMain.handle('pet:move', (event) => (trusted(event) ? movePetWindow() : { ok: false as const }));

  ipcMain.handle('pet:desktop-summary', async (event) => {
    if (!trusted(event)) return { ok: false as const, error: 'pet-untrusted-sender' };
    try {
      const entries = await listDesktopEntries(desktopDir());
      const plan = planDesktopOrganize(entries);
      const fileCount = plan.reduce((sum, group) => sum + group.files.length, 0);
      return {
        ok: true as const,
        result: {
          fileCount,
          groups: plan.map((group) => ({ folder: group.folder, count: group.files.length })),
        },
      };
    } catch {
      return { ok: false as const, error: 'pet-desktop-unavailable' };
    }
  });

  ipcMain.handle('pet:organize', async (event) => {
    if (!trusted(event)) return { ok: false as const, error: 'pet-untrusted-sender' };
    const dir = desktopDir();
    const plan = planDesktopOrganize(await listDesktopEntries(dir));
    const fileCount = plan.reduce((sum, group) => sum + group.files.length, 0);
    if (fileCount === 0) return { ok: true as const, result: { moved: 0, cancelled: false, failed: [] as string[] } };
    const detail = plan.map((group) => `${group.folder}/：${listNames(group.files)}`).join('\n\n');
    const answer = await dialog.showMessageBox({
      type: 'question',
      buttons: ['开始整理', '取消'],
      defaultId: 0,
      cancelId: 1,
      title: '小盈 · 整理桌面',
      message: `要把桌面上的 ${fileCount} 个文件按类型放进 ${plan.length} 个文件夹吗？`,
      detail: `${detail}\n\n只移动文件，不会删除任何东西；重名会自动加序号。`,
      noLink: true,
    });
    if (answer.response !== 0) return { ok: true as const, result: { moved: 0, cancelled: true, failed: [] as string[] } };
    const outcome = await applyDesktopOrganize(dir, plan);
    return { ok: true as const, result: { moved: outcome.moved, cancelled: false, failed: outcome.failed } };
  });

  ipcMain.handle('pet:trash', async (event) => {
    if (!trusted(event)) return { ok: false as const, error: 'pet-untrusted-sender' };
    const dir = desktopDir();
    const picked = await dialog.showOpenDialog({
      title: '小盈 · 选择要删除的文件',
      defaultPath: dir,
      properties: ['openFile', 'multiSelections'],
    });
    if (picked.canceled || picked.filePaths.length === 0) {
      return { ok: true as const, result: { trashed: 0, cancelled: true } };
    }
    const targets = picked.filePaths
      .map((filePath) => basename(filePath))
      .filter((name) => safeDesktopChild(dir, name) !== null);
    if (targets.length === 0) return { ok: false as const, error: 'pet-invalid-selection' };

    const answer = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['移到回收站', '取消'],
      defaultId: 1,
      cancelId: 1,
      title: '小盈 · 删除文件',
      message: `确定把这 ${targets.length} 个文件移到回收站吗？`,
      detail: `${listNames(targets)}\n\n删除后可以从系统回收站找回。`,
      noLink: true,
    });
    if (answer.response !== 0) {
      return { ok: true as const, result: { trashed: 0, cancelled: true } };
    }
    let trashed = 0;
    for (const name of targets) {
      const target = safeDesktopChild(dir, name);
      if (!target) continue;
      try {
        await shell.trashItem(target);
        trashed += 1;
      } catch {
        // 单个失败不打断其余文件；总数如实返回。
      }
    }
    return { ok: true as const, result: { trashed, cancelled: false } };
  });
}
