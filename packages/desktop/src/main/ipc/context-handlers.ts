import { ipcMain, dialog, BrowserWindow } from 'electron';
import {
  IMPORT_FILE_EXTENSIONS,
  importTaskFiles,
  listImportedTaskFiles,
  validateImportTaskId,
} from '../context/file-import.js';
import {
  createFolderSource,
  listGrantedFiles,
  listTaskContextSources,
  readGrantedFile,
  revokeTaskContextSource,
} from '../context/source-service.js';
import { getWorkspacePath } from '../workspace/config.js';

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${name} is required`);
  return value;
}

function failure(error: unknown): { ok: false; error: string } {
  return { ok: false, error: error instanceof Error ? error.message : 'unknown error' };
}

export function registerContextHandlers(): void {
  ipcMain.handle('context:import-files', async (_event, params: { taskId?: unknown }) => {
    try {
      const taskId = validateImportTaskId(params?.taskId);
      const workspacePath = getWorkspacePath();
      if (!workspacePath) return { ok: false, error: 'workspace not configured' };
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) return { ok: false, error: 'no window available' };
      const selection = await dialog.showOpenDialog(win, {
        properties: ['openFile', 'multiSelections'],
        title: 'Import Task Files',
        filters: [
          {
            name: 'Supported Files',
            extensions: [...IMPORT_FILE_EXTENSIONS],
          },
        ],
      });
      if (selection.canceled || selection.filePaths.length === 0) {
        return { ok: true, result: { imported: [], rejected: [] } };
      }
      return {
        ok: true,
        result: await importTaskFiles({ workspacePath, taskId, sourcePaths: selection.filePaths }),
      };
    } catch (error) {
      return failure(error);
    }
  });

  ipcMain.handle('context:list-imported-files', (_event, params: { taskId?: unknown }) => {
    try {
      const taskId = validateImportTaskId(params?.taskId);
      const workspacePath = getWorkspacePath();
      if (!workspacePath) return { ok: false, error: 'workspace not configured' };
      return { ok: true, result: listImportedTaskFiles(workspacePath, taskId) };
    } catch (error) {
      return failure(error);
    }
  });

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
        if (params?.query !== undefined && typeof params.query !== 'string') throw new Error('query must be a string');
        const query = typeof params?.query === 'string' && params.query.trim().length > 0 ? params.query : undefined;
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
}
