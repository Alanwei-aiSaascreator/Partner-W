import { Tray, Menu, nativeImage, app } from 'electron';
import { join } from 'path';
import { is } from '@electron-toolkit/utils';
import { getDebugLogger } from './debug/index.js';
import { readConfig, updateConfig } from './workspace/config.js';
import { getMainWindow } from './window-manager.js';

let abortActive: ((task: TrayTaskInfo) => void) | null = null;

export function setTrayAbortHandler(fn: (task: TrayTaskInfo) => void): void {
  abortActive = fn;
}

export type TrayStatus = 'idle' | 'running' | 'unread';

export interface TrayTaskInfo {
  taskId: string;
  title: string;
  snippet: string;
  duration: string;
  gatewayId?: string;
  sessionKey?: string;
}

interface TrayState {
  status: TrayStatus;
  tasks: TrayTaskInfo[];
}

let tray: Tray | null = null;
let animationTimer: ReturnType<typeof setInterval> | null = null;
let animationFrame = 0;

const SPINNER_FRAMES = ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'];

function getIconPath(): string {
  if (is.dev) {
    // 2026-10-07 质量战役构建回归：打包产物主 chunk 丢了 CJS shim（预14 有、预15 无），
    // 裸 __dirname 在 ESM 产物里 ReferenceError 崩掉窗口创建。改用 import.meta.dirname（ESM 原生）。
    return join(import.meta.dirname, '../../build/icon.png');
  }
  return join(process.resourcesPath, 'icon.png');
}

function loadIcon(): Electron.NativeImage {
  try {
    const img = nativeImage.createFromPath(getIconPath());
    if (!img.isEmpty()) {
      const resized = img.resize({ width: 16, height: 16 });
      resized.setTemplateImage(true);
      return resized;
    }
  } catch {}
  return nativeImage.createEmpty();
}

function stopAnimation(): void {
  if (animationTimer) {
    clearInterval(animationTimer);
    animationTimer = null;
  }
  animationFrame = 0;
}

function startAnimation(): void {
  stopAnimation();
  animationTimer = setInterval(() => {
    if (!tray) return;
    animationFrame = (animationFrame + 1) % SPINNER_FRAMES.length;
    tray.setTitle(SPINNER_FRAMES[animationFrame]);
  }, 120);
}

function focusMainWindow(): void {
  const win = getMainWindow();
  if (!win) return;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
}

function navigateToTask(taskId: string): void {
  focusMainWindow();
  const win = getMainWindow();
  if (win) win.webContents.send('tray:navigate-task', taskId);
}

function openSettings(): void {
  focusMainWindow();
  const win = getMainWindow();
  if (win) win.webContents.send('tray:open-settings');
}

function stopTask(task: TrayTaskInfo): void {
  abortActive?.(task);
}

function buildMenu(state: TrayState): Menu {
  const items: Electron.MenuItemConstructorOptions[] = [];

  if (state.tasks.length === 0) {
    items.push({ label: '没有正在进行的任务', enabled: false });
  } else {
    for (const task of state.tasks) {
      const label = (task.title || '未命名').slice(0, 40);
      items.push({
        label,
        sublabel: (task.snippet || task.duration).slice(0, 60),
        click: () => navigateToTask(task.taskId),
      });
    }
    items.push({
      label: '停止当前对话',
      click: () => stopTask(state.tasks[0]),
    });
  }

  items.push({ type: 'separator' });
  items.push({ label: '打开Partner-W', click: focusMainWindow });
  items.push({ label: '设置', click: openSettings });
  items.push({ type: 'separator' });
  items.push({ label: '退出', click: () => app.quit() });

  return Menu.buildFromTemplate(items);
}

function createTray(): void {
  if (tray) return;
  const icon = loadIcon();
  tray = new Tray(icon);
  tray.setToolTip('Partner-W');
  tray.setContextMenu(buildMenu({ status: 'idle', tasks: [] }));
  getDebugLogger().info({ domain: 'tray', event: 'tray.init' });
}

export function initTray(): void {
  const config = readConfig();
  if (config?.trayEnabled !== false) {
    createTray();
  }
}

export function isTrayEnabled(): boolean {
  return tray !== null;
}

export function setTrayEnabled(enabled: boolean): void {
  updateConfig({ trayEnabled: enabled });
  if (enabled) {
    createTray();
  } else {
    destroyTray();
  }
}

export function updateTrayStatus(state: TrayState): void {
  if (!tray) return;

  stopAnimation();

  switch (state.status) {
    case 'running':
      tray.setToolTip(`Partner-W — ${state.tasks.length} task(s) running`);
      startAnimation();
      break;
    case 'unread':
      tray.setTitle('●');
      tray.setToolTip('Partner-W — new results');
      break;
    default:
      tray.setTitle('');
      tray.setToolTip('Partner-W');
  }

  tray.setContextMenu(buildMenu(state));
}

export function destroyTray(): void {
  stopAnimation();
  if (tray) {
    tray.destroy();
    tray = null;
  }
}
