import type { BrowserWindow } from 'electron';

function isWindowAlive(win: BrowserWindow | null): win is BrowserWindow {
  return !!win && !win.isDestroyed() && !win.webContents.isDestroyed();
}

export function sendToWindow(win: BrowserWindow | null, channel: string, payload: unknown): boolean {
  if (!isWindowAlive(win)) {
    return false;
  }

  win.webContents.send(channel, payload);
  return true;
}
