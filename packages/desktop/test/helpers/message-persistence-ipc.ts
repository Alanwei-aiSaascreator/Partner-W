export const handlers = new Map<string, (...args: unknown[]) => unknown>();
export const ipcMain = {
  handle: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler),
};
export const app = { isPackaged: false, getAppPath: () => process.cwd() };
export const BrowserWindow = { getAllWindows: () => [] };
