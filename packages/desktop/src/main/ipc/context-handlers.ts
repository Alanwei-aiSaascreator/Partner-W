import path from 'node:path';
import { ipcMain, dialog, BrowserWindow } from 'electron';
import {
  IMPORT_FILE_EXTENSIONS,
  IMPORT_IMAGE_EXTENSIONS,
  importTaskFiles,
  listImportedTaskFiles,
  validateImportTaskId,
} from '../context/file-import.js';
import {
  createFolderSource,
  listGrantedFiles,
  listTaskContextSources,
  readGrantedFile,
  readGrantedFileForSend,
  revokeTaskContextSource,
} from '../context/source-service.js';
import { getWorkspacePath } from '../workspace/config.js';
import { trackEvent } from '../analytics/reporter.js';

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${name} is required`);
  return value;
}

function failure(error: unknown): { ok: false; error: string } {
  return { ok: false, error: error instanceof Error ? error.message : 'unknown error' };
}

export function registerContextHandlers(): void {
  ipcMain.handle(
    'context:import-files',
    async (_event, params: { taskId?: unknown; filePaths?: unknown; purpose?: unknown }) => {
      try {
        const taskId = validateImportTaskId(params?.taskId);
        const workspacePath = getWorkspacePath();
        if (!workspacePath) return { ok: false, error: 'workspace not configured' };

        // 两条进料口，汇进**同一条**导入管线（T05 口径：不另造导入框架）：
        //   ① 没有 `filePaths` → 主进程弹对话框（历史上唯一的入口）；
        //   ② 有 `filePaths`（拖入）→ 渲染层经 preload 的 `webUtils.getPathForFile`
        //      取到的**绝对路径**，主进程只做形状校验（字符串 + 绝对路径）。
        //      逐文件的类型/大小/目录/重名拒绝全部由 `importTaskFiles` 处理 ——
        //      与对话框逐字同一条路，失败状态（rejected 的原因）也同一套。
        let sourcePaths: string[];
        if (params && Object.prototype.hasOwnProperty.call(params, 'filePaths')) {
          const dropped = params.filePaths;
          if (
            !Array.isArray(dropped) ||
            dropped.some((candidate) => typeof candidate !== 'string' || !path.isAbsolute(candidate))
          ) {
            throw new Error('filePaths must be an array of absolute paths');
          }
          sourcePaths = dropped as string[];
        } else {
          const win = BrowserWindow.getAllWindows()[0];
          if (!win) return { ok: false, error: 'no window available' };
          // `purpose: 'images'` = 「识别图片」入口：只是**把可选范围缩到图片**
          //（导入 / 拒绝 / 选中语义一个字都不变）。其余值一律按普通文件入口。
          const imagesOnly = params?.purpose === 'images';
          const selection = await dialog.showOpenDialog(win, {
            properties: ['openFile', 'multiSelections'],
            title: imagesOnly ? 'Select Images' : 'Import Task Files',
            filters: [
              imagesOnly
                ? { name: 'Images', extensions: [...IMPORT_IMAGE_EXTENSIONS] }
                : {
                    name: 'Supported Files',
                    extensions: [...IMPORT_FILE_EXTENSIONS],
                  },
            ],
          });
          // ⚠️ 用户「打开选择框又关掉」也是 ok:true —— 这里**绝不能**记埋点，
          //    否则 `file_attached` 把取消也算成一次附带文件，数据当场失真。
          if (selection.canceled || selection.filePaths.length === 0) {
            return { ok: true, result: { imported: [], rejected: [] } };
          }
          sourcePaths = selection.filePaths;
        }

        if (sourcePaths.length === 0) return { ok: true, result: { imported: [], rejected: [] } };
        const result = await importTaskFiles({ workspacePath, taskId, sourcePaths });
        // 只有**真的进来文件**才算「附带文件」：选了文件但全被拒（超大/不支持）不算
        if (result.imported.length > 0) trackEvent('file_attached');
        return { ok: true, result };
      } catch (error) {
        return failure(error);
      }
    },
  );

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

  ipcMain.handle(
    'context:read-source-file-for-send',
    (_event, params: { taskId?: unknown; sourceId?: unknown; relativePath?: unknown }) => {
      try {
        const taskId = requireString(params?.taskId, 'taskId');
        const sourceId = requireString(params?.sourceId, 'sourceId');
        const relativePath = requireString(params?.relativePath, 'relativePath');
        return { ok: true, result: readGrantedFileForSend(taskId, sourceId, relativePath) };
      } catch (error) {
        return failure(error);
      }
    },
  );
}
