import { beforeEach, describe, expect, it, vi } from 'vitest';

const handleMap = new Map<string, (...args: unknown[]) => unknown>();
const showOpenDialogMock = vi.fn();
const getAllWindowsMock = vi.fn();
const createFolderSourceMock = vi.fn();
const listTaskContextSourcesMock = vi.fn();
const revokeTaskContextSourceMock = vi.fn();
const listGrantedFilesMock = vi.fn();
const readGrantedFileMock = vi.fn();
const importTaskFilesMock = vi.fn();
const listImportedTaskFilesMock = vi.fn();
const getWorkspacePathMock = vi.fn();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => handleMap.set(channel, handler)),
  },
  BrowserWindow: { getAllWindows: getAllWindowsMock },
  dialog: { showOpenDialog: showOpenDialogMock },
}));

vi.mock('../src/main/context/source-service.js', () => ({
  createFolderSource: createFolderSourceMock,
  listTaskContextSources: listTaskContextSourcesMock,
  revokeTaskContextSource: revokeTaskContextSourceMock,
  listGrantedFiles: listGrantedFilesMock,
  readGrantedFile: readGrantedFileMock,
}));

vi.mock('../src/main/context/file-import.js', () => ({
  importTaskFiles: importTaskFilesMock,
  listImportedTaskFiles: listImportedTaskFilesMock,
}));

vi.mock('../src/main/workspace/config.js', () => ({
  getWorkspacePath: getWorkspacePathMock,
}));

describe('task context source IPC handlers', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    handleMap.clear();
    getAllWindowsMock.mockReturnValue([{}]);
    getWorkspacePathMock.mockReturnValue('C:\\workspace');
    const { registerContextHandlers } = await import('../src/main/ipc/context-handlers.js');
    registerContextHandlers();
  });

  it('returns an empty successful import when the native multi-file dialog is canceled', async () => {
    showOpenDialogMock.mockResolvedValue({ canceled: true, filePaths: [] });

    await expect(handleMap.get('context:import-files')?.({}, { taskId: 'task-1' })).resolves.toEqual({
      ok: true,
      result: { imported: [], rejected: [] },
    });
    expect(importTaskFilesMock).not.toHaveBeenCalled();
    expect(showOpenDialogMock).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ properties: ['openFile', 'multiSelections'] }),
    );
    const options = showOpenDialogMock.mock.calls[0][1] as { filters: Array<{ extensions: string[] }> };
    const extensions = options.filters.flatMap((filter) => filter.extensions);
    expect(extensions).toEqual(
      expect.arrayContaining([
        'txt',
        'ts',
        'png',
        'jpg',
        'jpeg',
        'webp',
        'pdf',
        'doc',
        'docx',
        'xls',
        'xlsx',
        'ppt',
        'pptx',
        'csv',
        'json',
      ]),
    );
  });

  it('imports every selected native file into the configured task workspace', async () => {
    const imported = { imported: [{ fileName: 'a.txt' }], rejected: [] };
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: ['C:\\source\\a.txt', 'C:\\source\\b.pdf'] });
    importTaskFilesMock.mockResolvedValue(imported);

    await expect(handleMap.get('context:import-files')?.({}, { taskId: 'task-1' })).resolves.toEqual({
      ok: true,
      result: imported,
    });
    expect(importTaskFilesMock).toHaveBeenCalledWith({
      workspacePath: 'C:\\workspace',
      taskId: 'task-1',
      sourcePaths: ['C:\\source\\a.txt', 'C:\\source\\b.pdf'],
    });
  });

  it('lists imported files through the configured task workspace', () => {
    const files = [{ fileName: 'a.txt' }];
    listImportedTaskFilesMock.mockReturnValue(files);

    expect(handleMap.get('context:list-imported-files')?.({}, { taskId: 'task-1' })).toEqual({
      ok: true,
      result: files,
    });
    expect(listImportedTaskFilesMock).toHaveBeenCalledWith('C:\\workspace', 'task-1');
  });

  it('returns structured import errors for no window, missing workspace, invalid task ids, and service failures', async () => {
    getAllWindowsMock.mockReturnValue([]);
    await expect(handleMap.get('context:import-files')?.({}, { taskId: 'task-1' })).resolves.toEqual({
      ok: false,
      error: 'no window available',
    });

    getAllWindowsMock.mockReturnValue([{}]);
    getWorkspacePathMock.mockReturnValue(null);
    await expect(handleMap.get('context:import-files')?.({}, { taskId: 'task-1' })).resolves.toEqual({
      ok: false,
      error: 'workspace not configured',
    });
    expect(handleMap.get('context:list-imported-files')?.({}, { taskId: 'task-1' })).toEqual({
      ok: false,
      error: 'workspace not configured',
    });

    getWorkspacePathMock.mockReturnValue('C:\\workspace');
    await expect(handleMap.get('context:import-files')?.({}, { taskId: ' ' })).resolves.toEqual({
      ok: false,
      error: expect.any(String),
    });
    showOpenDialogMock.mockClear();
    showOpenDialogMock.mockResolvedValue({ canceled: true, filePaths: [] });
    await expect(handleMap.get('context:import-files')?.({}, { taskId: '..' })).resolves.toEqual({
      ok: false,
      error: expect.any(String),
    });
    expect(showOpenDialogMock).not.toHaveBeenCalled();
    listImportedTaskFilesMock.mockImplementation((_workspacePath, taskId) => {
      if (taskId === '..') throw new Error('taskId escapes workspace directory');
      return [];
    });
    expect(handleMap.get('context:list-imported-files')?.({}, { taskId: '..' })).toEqual({
      ok: false,
      error: expect.any(String),
    });

    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: ['C:\\source\\a.txt'] });
    importTaskFilesMock.mockRejectedValue(new Error('copy service unavailable'));
    await expect(handleMap.get('context:import-files')?.({}, { taskId: 'task-1' })).resolves.toEqual({
      ok: false,
      error: 'copy service unavailable',
    });
    listImportedTaskFilesMock.mockImplementation(() => {
      throw new Error('scan service unavailable');
    });
    expect(handleMap.get('context:list-imported-files')?.({}, { taskId: 'task-1' })).toEqual({
      ok: false,
      error: 'scan service unavailable',
    });
  });

  it('returns success with null when the native folder grant is canceled', async () => {
    showOpenDialogMock.mockResolvedValue({ canceled: true, filePaths: [] });
    await expect(handleMap.get('context:grant-folder')?.({}, { taskId: 'task-1' })).resolves.toEqual({
      ok: true,
      result: null,
    });
    expect(createFolderSourceMock).not.toHaveBeenCalled();
  });

  it('passes the selected path and task id to the source service', async () => {
    const source = { id: 'source-1' };
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: ['C:\\granted'] });
    createFolderSourceMock.mockReturnValue(source);
    await expect(handleMap.get('context:grant-folder')?.({}, { taskId: 'task-1' })).resolves.toEqual({
      ok: true,
      result: source,
    });
    expect(createFolderSourceMock).toHaveBeenCalledWith({ taskId: 'task-1', absolutePath: 'C:\\granted' });
  });

  it('returns structured errors for no window, invalid params, and service failures', async () => {
    getAllWindowsMock.mockReturnValue([]);
    await expect(handleMap.get('context:grant-folder')?.({}, { taskId: 'task-1' })).resolves.toEqual({
      ok: false,
      error: expect.any(String),
    });

    expect(handleMap.get('context:list-sources')?.({}, { taskId: ' ' })).toEqual({
      ok: false,
      error: expect.any(String),
    });
    listTaskContextSourcesMock.mockImplementation(() => {
      throw new Error('database unavailable');
    });
    expect(handleMap.get('context:list-sources')?.({}, { taskId: 'task-1' })).toEqual({
      ok: false,
      error: 'database unavailable',
    });
  });

  it('validates and forwards list, revoke, scan, and read parameters', async () => {
    listTaskContextSourcesMock.mockReturnValue([]);
    revokeTaskContextSourceMock.mockReturnValue(true);
    listGrantedFilesMock.mockReturnValue([]);
    readGrantedFileMock.mockReturnValue({ content: 'ok' });

    expect(handleMap.get('context:list-sources')?.({}, { taskId: 'task-1' })).toEqual({ ok: true, result: [] });
    expect(handleMap.get('context:revoke-source')?.({}, { taskId: 'task-1', sourceId: 'source-1' })).toEqual({
      ok: true,
      result: true,
    });
    expect(
      handleMap.get('context:list-source-files')?.({}, { taskId: 'task-1', sourceId: 'source-1', query: 'note' }),
    ).toEqual({ ok: true, result: [] });
    expect(
      handleMap.get('context:read-source-file')?.(
        {},
        { taskId: 'task-1', sourceId: 'source-1', relativePath: 'a.txt' },
      ),
    ).toEqual({ ok: true, result: { content: 'ok' } });

    expect(listTaskContextSourcesMock).toHaveBeenCalledWith('task-1');
    expect(revokeTaskContextSourceMock).toHaveBeenCalledWith('task-1', 'source-1');
    expect(listGrantedFilesMock).toHaveBeenCalledWith('task-1', 'source-1', 'note');
    expect(readGrantedFileMock).toHaveBeenCalledWith('task-1', 'source-1', 'a.txt');

    for (const channel of ['context:revoke-source', 'context:list-source-files', 'context:read-source-file']) {
      expect(handleMap.get(channel)?.({}, {})).toEqual({ ok: false, error: expect.any(String) });
    }
  });

  it('normalizes blank file queries to undefined and rejects non-string queries', () => {
    listGrantedFilesMock.mockReturnValue([]);

    expect(
      handleMap.get('context:list-source-files')?.({}, { taskId: 'task-1', sourceId: 'source-1', query: '' }),
    ).toEqual({ ok: true, result: [] });
    expect(
      handleMap.get('context:list-source-files')?.({}, { taskId: 'task-1', sourceId: 'source-1', query: '   ' }),
    ).toEqual({ ok: true, result: [] });
    expect(listGrantedFilesMock).toHaveBeenNthCalledWith(1, 'task-1', 'source-1', undefined);
    expect(listGrantedFilesMock).toHaveBeenNthCalledWith(2, 'task-1', 'source-1', undefined);

    expect(
      handleMap.get('context:list-source-files')?.({}, { taskId: 'task-1', sourceId: 'source-1', query: 42 }),
    ).toEqual({ ok: false, error: expect.any(String) });
  });
});
