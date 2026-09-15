import { beforeEach, describe, expect, it, vi } from 'vitest';

const handleMap = new Map<string, (...args: unknown[]) => unknown>();
const showOpenDialogMock = vi.fn();
const getAllWindowsMock = vi.fn();
const createFolderSourceMock = vi.fn();
const listTaskContextSourcesMock = vi.fn();
const revokeTaskContextSourceMock = vi.fn();
const listGrantedFilesMock = vi.fn();
const readGrantedFileMock = vi.fn();

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

describe('task context source IPC handlers', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    handleMap.clear();
    getAllWindowsMock.mockReturnValue([{}]);
    const { registerContextHandlers } = await import('../src/main/ipc/context-handlers.js');
    registerContextHandlers();
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
