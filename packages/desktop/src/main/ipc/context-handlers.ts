import { ipcMain, dialog, BrowserWindow } from 'electron';
import { scanFolder } from '../context/file-index.js';
import { readContextFile } from '../context/file-reader.js';
import { watchFolder, unwatchFolder } from '../context/file-watcher.js';
import {
  createFolderSource,
  listGrantedFiles,
  listTaskContextSources,
  readGrantedFile,
  revokeTaskContextSource,
} from '../context/source-service.js';

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${name} is required`);
  return value;
}

function failure(error: unknown): { ok: false; error: string } {
  return { ok: false, error: error instanceof Error ? error.message : 'unknown error' };
}

export function registerContextHandlers(): void {
  ipcMain.handle('context:grant-folder', async (_event, params: { taskId?: unknown }) => {
    try {
      const taskId = requireString(params?.taskId, 'taskId');
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) return { ok: false, error: 'no window available' };
      const result = await dialog.showOpenDialog(win, {
        properties: ['openDirectory'],
        title: '选择任务上下文文件夹',
      });
      if (result.canceled || result.filePaths.length === 0) return { ok: true, result: null };
      return { ok: true, result: createFolderSource({ taskId, absolutePath: result.filePaths[0] }) };
    } catch (error) {
      return failure(error);
    }
  });

  ipcMain.handle('context:list-sources', (_event, params: { taskId?: unknown }) => {
    try {
      return { ok: true, result: listTaskContextSources(requireString(params?.taskId, 'taskId')) };
    } catch (error) {
      return failure(error);
    }
  });

  ipcMain.handle('context:revoke-source', (_event, params: { taskId?: unknown; sourceId?: unknown }) => {
    try {
      const taskId = requireString(params?.taskId, 'taskId');
      const sourceId = requireString(params?.sourceId, 'sourceId');
      return { ok: true, result: revokeTaskContextSource(taskId, sourceId) };
    } catch (error) {
      return failure(error);
    }
  });

  ipcMain.handle(
    'context:list-source-files',
    (_event, params: { taskId?: unknown; sourceId?: unknown; query?: unknown }) => {
      try {
        const taskId = requireString(params?.taskId, 'taskId');
        const sourceId = requireString(params?.sourceId, 'sourceId');
        const query = params?.query === undefined ? undefined : requireString(params.query, 'query');
        return { ok: true, result: listGrantedFiles(taskId, sourceId, query) };
      } catch (error) {
        return failure(error);
      }
    },
  );

  ipcMain.handle(
    'context:read-source-file',
    (_event, params: { taskId?: unknown; sourceId?: unknown; relativePath?: unknown }) => {
      try {
        const taskId = requireString(params?.taskId, 'taskId');
        const sourceId = requireString(params?.sourceId, 'sourceId');
        const relativePath = requireString(params?.relativePath, 'relativePath');
        return { ok: true, result: readGrantedFile(taskId, sourceId, relativePath) };
      } catch (error) {
        return failure(error);
      }
    },
  );

  ipcMain.handle('context:select-folder', async () => {
    try {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) return { ok: false, error: 'no window' };

      const result = await dialog.showOpenDialog(win, {
        properties: ['openDirectory'],
        title: 'Select Context Folder',
      });

      if (result.canceled || result.filePaths.length === 0) {
        return { ok: true, result: null };
      }

      return { ok: true, result: result.filePaths[0] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle('context:list-files', (_event, params: { folders: string[]; query?: string }) => {
    try {
      const folders = params?.folders ?? [];
      const allFiles = [];
      for (const folder of folders) {
        try {
          allFiles.push(...scanFolder(folder, { query: params?.query }));
        } catch {
          continue;
        }
      }

      return { ok: true, result: allFiles.slice(0, 100) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle('context:watch-folder', (_event, folderPath: string) => {
    const ok = watchFolder(folderPath);
    if (!ok) return { ok: false, error: 'watch rejected: folder limit reached or watcher failed' };
    return { ok: true, result: folderPath };
  });

  ipcMain.handle('context:unwatch-folder', (_event, folderPath: string) => {
    unwatchFolder(folderPath);
    return { ok: true };
  });

  ipcMain.handle('context:read-file', (_event, params: { absolutePath: string; folders: string[] }) => {
    try {
      const result = readContextFile(params.absolutePath, params?.folders ?? []);
      return { ok: true, result };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      return { ok: false, error: msg };
    }
  });
}
