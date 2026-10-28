import { ipcMain } from 'electron';
import { handleQuickLaunchSubmit, hideQuickLaunch, updateQuickLaunchConfig } from '../quick-launch.js';
import { readConfig } from '../workspace/config.js';

export function registerQuickLaunchHandlers(): void {
  ipcMain.on('quick-launch:submit', (_event, message: string) => {
    handleQuickLaunchSubmit(message);
  });

  ipcMain.on('quick-launch:hide', () => {
    hideQuickLaunch();
  });

  ipcMain.handle('quick-launch:get-config', () => {
    const config = readConfig();
    return {
      enabled: config?.quickLaunch?.enabled ?? false,
      shortcut: config?.quickLaunch?.shortcut ?? 'Alt+Space',
      sendShortcut: config?.sendShortcut ?? 'enter',
    };
  });

  ipcMain.handle('quick-launch:update-config', (_event, enabled: boolean, shortcut?: string) => {
    return updateQuickLaunchConfig(enabled, shortcut);
  });
}
