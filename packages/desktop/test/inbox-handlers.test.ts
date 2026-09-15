import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const openPathMock = vi.fn();
const showItemInFolderMock = vi.fn();
const readInboxFileMock = vi.fn();
const resolveInboxPathMock = vi.fn();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler)),
  },
  shell: { openPath: openPathMock, showItemInFolder: showItemInFolderMock },
}));

vi.mock('../src/main/inbox/save.js', () => ({ saveInboxAttachment: vi.fn() }));
vi.mock('../src/main/inbox/resolve.js', () => ({
  readInboxFile: readInboxFileMock,
  resolveInboxPath: resolveInboxPathMock,
}));
vi.mock('../src/main/workspace/config.js', () => ({ getWorkspacePath: () => 'C:\\workspace' }));

describe('inbox file IPC handlers', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    handlers.clear();
    readInboxFileMock.mockResolvedValue(null);
    resolveInboxPathMock.mockResolvedValue(null);
    const { registerInboxHandlers } = await import('../src/main/ipc/inbox-handlers.js');
    registerInboxHandlers();
  });

  it('rejects staging and nested paths for read, open, and show-in-folder', async () => {
    const invalidPaths = ['task-1/inbox/.import-staging/.import-deadbeef.partial', 'task-1/inbox/folder/file.txt'];

    for (const localPath of invalidPaths) {
      await expect(handlers.get('inbox:read-file')?.({}, { localPath })).resolves.toEqual({
        ok: false,
        error: 'invalid path',
      });
      await expect(handlers.get('inbox:open')?.({}, { localPath })).resolves.toEqual({
        ok: false,
        error: 'invalid path',
      });
      await expect(handlers.get('inbox:show-in-folder')?.({}, { localPath })).resolves.toEqual({
        ok: false,
        error: 'invalid path',
      });
    }
    expect(openPathMock).not.toHaveBeenCalled();
    expect(showItemInFolderMock).not.toHaveBeenCalled();
  });

  it('keeps legitimate top-level inbox attachments available to all three handlers', async () => {
    const localPath = 'task-1/inbox/note.txt';
    readInboxFileMock.mockResolvedValue('aGVsbG8=');
    resolveInboxPathMock.mockResolvedValue('C:\\workspace\\task-1\\inbox\\note.txt');
    openPathMock.mockResolvedValue('');

    await expect(handlers.get('inbox:read-file')?.({}, { localPath })).resolves.toEqual({
      ok: true,
      result: { content: 'aGVsbG8=', encoding: 'base64' },
    });
    await expect(handlers.get('inbox:open')?.({}, { localPath })).resolves.toEqual({ ok: true });
    await expect(handlers.get('inbox:show-in-folder')?.({}, { localPath })).resolves.toEqual({ ok: true });
    expect(openPathMock).toHaveBeenCalledTimes(1);
    expect(showItemInFolderMock).toHaveBeenCalledTimes(1);
  });
});
