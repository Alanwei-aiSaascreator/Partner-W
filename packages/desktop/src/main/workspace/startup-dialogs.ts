/**
 * 启动期工作区对话框的**真实 Electron 实现**（中文、可操作）。
 *
 * ⚠️ 这里是唯一允许出现"退出"这个选项的地方：用户在工作区打不开时，
 *    必须看到「选择其它目录 / 重建工作区 / 退出」并自己选，而不是被
 *    `showErrorBox('Database Error') + app.quit()` 直接甩掉。
 *
 * ⚠️ 启动期可能**还没有窗口**（工作区是在 `createWindow()` 之前准备的），
 *    所以每个对话框都允许无父窗口调用。
 */

import { BrowserWindow, dialog } from 'electron';
import type { MissingWorkspaceChoice, UnusableWorkspaceChoice, WorkspaceStartupDialogs } from './startup.js';

const BROWSE_LABEL = '选择其它目录…';
const CREATE_LABEL = '新建工作区';
const QUIT_LABEL = '退出';
const REBUILD_LABEL = '重建工作区';

function showMessageBox(options: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> {
  const win = BrowserWindow.getAllWindows()[0];
  return win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);
}

async function showOpenDialog(options: Electron.OpenDialogOptions): Promise<string | null> {
  const win = BrowserWindow.getAllWindows()[0];
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
}

export function createWorkspaceStartupDialogs(): WorkspaceStartupDialogs {
  return {
    /**
     * 找不到工作区。
     *
     * 多命中时**先让用户挑**：按钮就是候选路径本身（同时在 detail 里编号列一遍），
     * 因为"两个 U 盘都有荣盈魔方工作区"这种情况，只有用户知道哪份是他的。
     */
    async askForMissingWorkspace({ recordedPath, candidates }): Promise<MissingWorkspaceChoice> {
      const buttons = [...candidates, BROWSE_LABEL, CREATE_LABEL, QUIT_LABEL];
      const detail = candidates.length
        ? `下面这些位置都有同一个工作区，请选择要用哪一个：\n\n${candidates
            .map((path, index) => `${index + 1}. ${path}`)
            .join('\n')}`
        : `这个位置所在的盘现在不在（U 盘没插、盘符变了，或目录被删了）：\n\n${recordedPath}\n\n可以自己指定一个目录，或者新建一份工作区。`;

      const { response } = await showMessageBox({
        type: 'warning',
        title: '找不到工作区',
        message: `打不开原来的工作区：\n${recordedPath}`,
        detail,
        buttons,
        defaultId: 0,
        // Esc / 关窗 = 「退出」：这是用户**显式**关掉了这个对话框，不是我们偷偷退出。
        cancelId: buttons.length - 1,
        noLink: true,
      });

      if (response >= 0 && response < candidates.length) {
        return { kind: 'use', path: candidates[response] };
      }
      if (response === candidates.length) return { kind: 'browse' };
      if (response === candidates.length + 1) return { kind: 'create' };
      return { kind: 'quit' };
    },

    browseForDirectory(defaultPath: string): Promise<string | null> {
      return showOpenDialog({
        title: '选择工作区目录',
        defaultPath,
        properties: ['openDirectory', 'createDirectory'],
      });
    },

    /**
     * 数据库打不开。三个出口都写清楚后果：
     * 「重建工作区」只把打不开的数据库文件改名挪到一边（`.corrupt-<时间戳>`），不删别的东西。
     */
    async askForUnusableWorkspace({ workspacePath, message }): Promise<UnusableWorkspaceChoice> {
      const buttons = [BROWSE_LABEL, REBUILD_LABEL, QUIT_LABEL];
      const { response } = await showMessageBox({
        type: 'error',
        title: '打不开工作区',
        message: `工作区里的数据打不开：\n${workspacePath}`,
        detail: `${message}\n\n可以换一个目录，或在这个位置重建工作区（原来的数据库文件会改名保留，不会删除你的文件）。`,
        buttons,
        defaultId: 0,
        cancelId: buttons.length - 1,
        noLink: true,
      });

      if (response === 0) return 'browse';
      if (response === 1) return 'rebuild';
      return 'quit';
    },

    async notifyFatal({ title, message, detail }): Promise<void> {
      await showMessageBox({
        type: 'error',
        title,
        message,
        detail,
        buttons: [QUIT_LABEL],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
    },
  };
}
