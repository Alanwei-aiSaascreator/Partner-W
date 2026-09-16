import { beforeEach, describe, expect, it, vi } from 'vitest';

const handleMap = new Map<string, (...args: unknown[]) => unknown>();
const allMock = vi.fn();
const whereMock = vi.fn(() => ({ all: allMock }));
const fromMock = vi.fn(() => ({ where: whereMock, all: allMock }));
const selectMock = vi.fn(() => ({ from: fromMock }));
const getDbMock = vi.fn(() => ({ select: selectMock }));
const autoExtractArtifactsMock = vi.fn();
const getArtifactAvailabilityMock = vi.fn(() => 'available');
const showSaveDialogMock = vi.fn();
const copyArtifactToDestinationMock = vi.fn();
const inspectArtifactFileMock = vi.fn();
const openPathMock = vi.fn();
const showItemInFolderMock = vi.fn();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handleMap.set(channel, handler);
    }),
  },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  dialog: { showSaveDialog: showSaveDialogMock },
  shell: { openPath: openPathMock, showItemInFolder: showItemInFolderMock },
}));

vi.mock('../src/main/db/index.js', () => ({
  getDb: getDbMock,
  getSqlite: vi.fn(() => null),
}));

vi.mock('../src/main/workspace/config.js', () => ({
  getWorkspacePath: vi.fn(() => '/workspace'),
}));

vi.mock('../src/main/artifact/save.js', () => ({
  saveArtifact: vi.fn(),
  saveArtifactFromBuffer: vi.fn(),
}));

vi.mock('../src/main/artifact/auto-extract.js', () => ({
  autoExtractArtifacts: autoExtractArtifactsMock,
}));

vi.mock('../src/main/artifact/reconcile.js', () => ({
  getArtifactAvailability: getArtifactAvailabilityMock,
}));

vi.mock('../src/main/artifact/access.js', () => ({
  copyArtifactToDestination: copyArtifactToDestinationMock,
  inspectArtifactFile: inspectArtifactFileMock,
}));

vi.mock('../src/main/net/safe-fetch.js', () => ({
  safeFetch: vi.fn(),
}));

describe('artifact handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handleMap.clear();
  });

  it('lists artifacts without triggering auto-extract side effects', async () => {
    const { registerArtifactHandlers } = await import('../src/main/ipc/artifact-handlers.js');
    registerArtifactHandlers();

    allMock.mockReturnValue([
      {
        id: 'a1',
        taskId: 'task-1',
        messageId: 'msg-1',
        type: 'image',
        name: 'image-1---abc-11111111.png',
        localPath: 'task-1/image-1---abc-11111111.png',
        mimeType: 'image/png',
        size: 10,
        createdAt: '2026-03-16T00:00:00.000Z',
      },
      {
        id: 'a2',
        taskId: 'task-1',
        messageId: 'msg-1',
        type: 'image',
        name: 'image-1---abc-22222222.png',
        localPath: 'task-1/image-1---abc-22222222.png',
        mimeType: 'image/png',
        size: 10,
        createdAt: '2026-03-16T00:00:01.000Z',
      },
    ]);

    const listArtifacts = handleMap.get('artifact:list');
    expect(listArtifacts).toBeTypeOf('function');

    await expect(listArtifacts?.({}, { taskId: 'task-1' })).resolves.toEqual({
      ok: true,
      result: [
        expect.objectContaining({ id: 'a1', availability: 'available' }),
        expect.objectContaining({ id: 'a2', availability: 'available' }),
      ],
    });
    expect(getArtifactAvailabilityMock).toHaveBeenCalledTimes(2);
    expect(autoExtractArtifactsMock).not.toHaveBeenCalled();
  });

  it('returns an explicit cancelled result without copying', async () => {
    allMock.mockReturnValue([
      {
        id: 'a1',
        taskId: 'task-1',
        name: 'report.txt',
        localPath: 'task-1/report.txt',
      },
    ]);
    showSaveDialogMock.mockResolvedValue({ canceled: true });
    const { registerArtifactHandlers } = await import('../src/main/ipc/artifact-handlers.js');
    registerArtifactHandlers();

    await expect(handleMap.get('artifact:save-as')?.({}, { artifactId: 'a1', taskId: 'task-1' })).resolves.toEqual({
      ok: true,
      result: { status: 'cancelled' },
    });
    expect(copyArtifactToDestinationMock).not.toHaveBeenCalled();
  });

  it('copies the database-owned artifact selected by id', async () => {
    allMock.mockReturnValue([
      {
        id: 'a1',
        taskId: 'task-1',
        name: 'report.txt',
        localPath: 'task-1/report.txt',
      },
    ]);
    showSaveDialogMock.mockResolvedValue({ canceled: false, filePath: 'C:\\Exports\\report.txt' });
    copyArtifactToDestinationMock.mockResolvedValue({ status: 'saved', filePath: 'C:\\Exports\\report.txt' });
    const { registerArtifactHandlers } = await import('../src/main/ipc/artifact-handlers.js');
    registerArtifactHandlers();

    await expect(handleMap.get('artifact:save-as')?.({}, { artifactId: 'a1', taskId: 'task-1' })).resolves.toEqual({
      ok: true,
      result: { status: 'saved', filePath: 'C:\\Exports\\report.txt' },
    });
    expect(copyArtifactToDestinationMock).toHaveBeenCalledWith(
      '/workspace',
      'task-1/report.txt',
      'C:\\Exports\\report.txt',
    );
  });

  it('rejects a mismatched task before opening or revealing an artifact', async () => {
    allMock.mockReturnValue([{ id: 'a1', taskId: 'task-2', name: 'report.txt', localPath: 'task-2/report.txt' }]);
    const { registerArtifactHandlers } = await import('../src/main/ipc/artifact-handlers.js');
    registerArtifactHandlers();

    await expect(handleMap.get('artifact:open-file')?.({}, { artifactId: 'a1', taskId: 'task-1' })).resolves.toEqual({
      ok: false,
      error: 'artifact not found',
    });
    expect(openPathMock).not.toHaveBeenCalled();
  });

  it('refuses missing or unsafe artifacts before opening them', async () => {
    allMock.mockReturnValue([{ id: 'a1', taskId: 'task-1', name: 'report.txt', localPath: 'task-1/report.txt' }]);
    inspectArtifactFileMock.mockResolvedValue({ availability: 'unsafe' });
    const { registerArtifactHandlers } = await import('../src/main/ipc/artifact-handlers.js');
    registerArtifactHandlers();

    await expect(handleMap.get('artifact:open-file')?.({}, { artifactId: 'a1', taskId: 'task-1' })).resolves.toEqual({
      ok: false,
      error: 'artifact unsafe',
    });
    expect(openPathMock).not.toHaveBeenCalled();
  });
});
