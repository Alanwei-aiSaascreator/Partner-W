import { ipcMain, globalShortcut } from 'electron';
import { updateTrayStatus, isTrayEnabled, setTrayEnabled, setTrayAbortHandler } from '../tray.js';
import type { TrayStatus, TrayTaskInfo } from '../tray.js';
import { cancelArtifactRunsForSession } from './data-handlers.js';
import { getGatewayClient } from '../ws/index.js';
import { getDebugLogger } from '../debug/index.js';

const STOP_SHORTCUT = 'CommandOrControl+Shift+.';
let latestTasks: TrayTaskInfo[] = [];
let shortcutRegistered = false;

async function abortTrayTask(task: TrayTaskInfo | undefined): Promise<void> {
  if (!task?.sessionKey || !task.gatewayId) return;
  cancelArtifactRunsForSession(task.sessionKey);
  const gw = getGatewayClient(task.gatewayId);
  if (!gw?.isConnected) return;
  try {
    await gw.abortChat(task.sessionKey);
    getDebugLogger().info({
      domain: 'tray',
      event: 'tray.abort',
      data: { taskId: task.taskId, sessionKey: task.sessionKey },
    });
  } catch (err) {
    getDebugLogger().warn({
      domain: 'tray',
      event: 'tray.abort.failed',
      data: { message: err instanceof Error ? err.message : 'unknown' },
    });
  }
}

function syncStopShortcut(tasks: TrayTaskInfo[]): void {
  latestTasks = tasks;
  if (tasks.length > 0 && !shortcutRegistered) {
    shortcutRegistered = globalShortcut.register(STOP_SHORTCUT, () => {
      void abortTrayTask(latestTasks[0]);
    });
  } else if (tasks.length === 0 && shortcutRegistered) {
    globalShortcut.unregister(STOP_SHORTCUT);
    shortcutRegistered = false;
  }
}

export function registerTrayHandlers(): void {
  setTrayAbortHandler((task) => {
    void abortTrayTask(task);
  });

  ipcMain.on('tray:update-status', (_event, payload: { status: TrayStatus; tasks: TrayTaskInfo[] }) => {
    const tasks = payload.tasks ?? [];
    updateTrayStatus({ status: payload.status, tasks });
    if (payload.status === 'running') syncStopShortcut(tasks);
    else syncStopShortcut([]);
  });

  ipcMain.handle('tray:get-enabled', () => {
    return isTrayEnabled();
  });

  ipcMain.handle('tray:set-enabled', (_event, enabled: boolean) => {
    setTrayEnabled(enabled);
    return true;
  });
}
