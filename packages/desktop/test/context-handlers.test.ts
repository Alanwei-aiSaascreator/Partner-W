import { beforeEach, describe, expect, it, vi } from 'vitest';

const handleMap = new Map<string, (...args: unknown[]) => unknown>();
const showOpenDialogMock = vi.fn();
const getAllWindowsMock = vi.fn();
const createFolderSourceMock = vi.fn();
const listTaskContextSourcesMock = vi.fn();
const revokeTaskContextSourceMock = vi.fn();
const listGrantedFilesMock = vi.fn();
const readGrantedFileMock = vi.fn();
const readGrantedFileForSendMock = vi.fn();
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
  readGrantedFileForSend: readGrantedFileForSendMock,
}));

vi.mock('../src/main/context/file-import.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/context/file-import.js')>();
  return {
    ...actual,
    importTaskFiles: importTaskFilesMock,
    listImportedTaskFiles: listImportedTaskFilesMock,
  };
});

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

  it('registers a fixed-limit task-scoped source read for sending', () => {
    readGrantedFileForSendMock.mockReturnValue({ content: 'eA==', tier: 'image', byteLength: 1 });
    expect(
      handleMap.get('context:read-source-file-for-send')?.(
        {},
        { taskId: 'task-1', sourceId: 'source-1', relativePath: 'image.png' },
      ),
    ).toEqual({ ok: true, result: { content: 'eA==', tier: 'image', byteLength: 1 } });
    expect(readGrantedFileForSendMock).toHaveBeenCalledWith('task-1', 'source-1', 'image.png');
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
    expect(extensions).not.toEqual(expect.arrayContaining(['gif', 'svg']));
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

  /**
   * 埋点：`file_attached` 的口径是「**真的**有文件进来」。
   *
   * ⚠️ 这里必须走**真的** reporter 单例（而不是 mock 掉 `trackEvent`）：
   *    被钉住的行为是「handler 记了哪个事件、记了几次」，只有真实队列看得见
   *    —— mock 掉之后这条测试会退化成"handler 里出现过某个字符串"。
   * ⚠️ 必须在 `vi.resetModules()` **之后**动态 import：静态 import 拿到的是
   *    重置前那个注册表里的实例，而 handler 用的是重置后的新实例 —— 两者不是同一个 `active`。
   */
  async function freshReporter() {
    const { createAnalyticsReporter, initAnalyticsReporterForTest } = await import('../src/main/analytics/reporter.js');
    const reporter = createAnalyticsReporter({
      storage: { read: () => null, write: () => {} },
      send: vi.fn(),
    });
    initAnalyticsReporterForTest(reporter);
    return reporter;
  }

  it('★ 取消选择文件**不算**一次 file_attached', async () => {
    showOpenDialogMock.mockResolvedValue({ canceled: true, filePaths: [] });
    const reporter = await freshReporter();

    await expect(handleMap.get('context:import-files')?.({}, { taskId: 'task-1' })).resolves.toEqual({
      ok: true,
      result: { imported: [], rejected: [] },
    });

    expect(reporter.peek()).toEqual([]);
  });

  it('★ 真导入才记一次 file_attached；选中的文件**全被拒**也不记', async () => {
    const reporter = await freshReporter();
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: ['C:\\source\\a.txt'] });

    importTaskFilesMock.mockResolvedValue({ imported: [], rejected: [{ fileName: 'a.exe' }] });
    await handleMap.get('context:import-files')?.({}, { taskId: 'task-1' });
    expect(reporter.peek()).toEqual([]);

    importTaskFilesMock.mockResolvedValue({ imported: [{ fileName: 'a.txt' }], rejected: [] });
    await handleMap.get('context:import-files')?.({}, { taskId: 'task-1' });
    expect(reporter.peek().map((e) => e.event)).toEqual(['file_attached']);
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
    await expect(handleMap.get('context:import-files')?.({}, { taskId: 'a/b' })).resolves.toEqual({
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

  it('does not register renderer-chosen absolute path context channels', () => {
    for (const channel of [
      'context:select-folder',
      'context:list-files',
      'context:read-file',
      'context:watch-folder',
      'context:unwatch-folder',
    ]) {
      expect(handleMap.has(channel)).toBe(false);
    }
  });
});
