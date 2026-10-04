export const handlers = new Map<string, (...args: unknown[]) => unknown>();
export const ipcMain = {
  handle: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler),
};
export const app = {
  isPackaged: false,
  getAppPath: () => process.cwd(),
  getPath: (name: string) => {
    if (name !== 'userData' || !process.argv[2] || !isAbsolute(process.argv[2]))
      throw new Error('isolated fixture userData is required');
    return join(process.argv[2], '.electron-user-data');
  },
};
export const safeStorage = { isEncryptionAvailable: () => false };
export const BrowserWindow = { getAllWindows: () => [] };
import { join, isAbsolute } from 'node:path';
