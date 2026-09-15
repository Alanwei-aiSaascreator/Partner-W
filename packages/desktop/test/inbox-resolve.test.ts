import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs', () => ({
  realpathSync: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  open: vi.fn(),
  realpath: vi.fn(),
  stat: vi.fn(),
}));

import { realpathSync } from 'fs';
import { open, realpath, stat } from 'fs/promises';
import { join, resolve } from 'path';
import { readInboxFile, resolveInboxPath } from '../src/main/inbox/resolve.js';

const mockOpen = vi.mocked(open);
const mockRealpath = vi.mocked(realpath);
const mockStat = vi.mocked(stat);
const mockRealpathSync = vi.mocked(realpathSync);
const WORKSPACE_PATH = resolve('workspace-fixture');
const LOCAL_PATH = join('task-1', 'inbox', 'file.txt');
const INBOX_DIR = join(WORKSPACE_PATH, 'task-1', 'inbox');
const INBOX_FILE = join(INBOX_DIR, 'file.txt');
const OUTSIDE_FILE = resolve('outside-fixture', 'passwd');

describe('inbox path access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects symlink escapes when resolving inbox paths', async () => {
    mockRealpath.mockImplementation(async (path) => {
      if (path === WORKSPACE_PATH) return WORKSPACE_PATH;
      if (path === INBOX_DIR) return INBOX_DIR;
      if (path === INBOX_FILE) return OUTSIDE_FILE;
      throw new Error(`unexpected path ${path}`);
    });

    await expect(resolveInboxPath(WORKSPACE_PATH, LOCAL_PATH)).resolves.toBeNull();
  });

  it('reads inbox files only after the opened fd resolves inside the inbox dir', async () => {
    const readFile = vi.fn().mockResolvedValue('aGVsbG8=');
    const close = vi.fn().mockResolvedValue(undefined);
    mockOpen.mockResolvedValue({
      fd: 42,
      stat: vi.fn().mockResolvedValue({ isFile: () => true }),
      readFile,
      close,
    } as unknown as Awaited<ReturnType<typeof open>>);
    mockRealpath.mockImplementation(async (path) => {
      if (path === WORKSPACE_PATH) return WORKSPACE_PATH;
      if (path === INBOX_DIR) return INBOX_DIR;
      if (path === INBOX_FILE) return INBOX_FILE;
      throw new Error(`unexpected path ${path}`);
    });
    mockRealpathSync.mockReturnValue(INBOX_FILE);

    await expect(readInboxFile(WORKSPACE_PATH, LOCAL_PATH)).resolves.toBe('aGVsbG8=');
    expect(readFile).toHaveBeenCalledWith({ encoding: 'base64' });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('rejects opened fds that resolve outside the inbox dir', async () => {
    const readFile = vi.fn().mockResolvedValue('aGVsbG8=');
    const close = vi.fn().mockResolvedValue(undefined);
    mockOpen.mockResolvedValue({
      fd: 42,
      stat: vi.fn().mockResolvedValue({ isFile: () => true }),
      readFile,
      close,
    } as unknown as Awaited<ReturnType<typeof open>>);
    mockRealpath.mockImplementation(async (path) => {
      if (path === WORKSPACE_PATH) return WORKSPACE_PATH;
      if (path === INBOX_DIR) return INBOX_DIR;
      if (path === INBOX_FILE) return OUTSIDE_FILE;
      throw new Error(`unexpected path ${path}`);
    });
    mockRealpathSync.mockReturnValue(OUTSIDE_FILE);

    await expect(readInboxFile(WORKSPACE_PATH, LOCAL_PATH)).resolves.toBeNull();
    expect(readFile).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('rejects nested and staging paths before opening them', async () => {
    const invalid = [
      join('task-1', 'inbox', 'folder', 'file.txt'),
      join('task-1', 'inbox', '.import-staging', '.import-deadbeef.partial'),
      join('task-1', 'inbox', '.import-deadbeef.partial'),
    ];

    for (const localPath of invalid) {
      await expect(resolveInboxPath(WORKSPACE_PATH, localPath)).resolves.toBeNull();
      await expect(readInboxFile(WORKSPACE_PATH, localPath)).resolves.toBeNull();
    }
    expect(mockOpen).not.toHaveBeenCalled();
    expect(mockRealpath).not.toHaveBeenCalled();
  });

  it('rejects a top-level inbox directory while preserving a legitimate top-level file', async () => {
    const folderPath = join('task-1', 'inbox', 'folder');
    const fullFolderPath = join(INBOX_DIR, 'folder');
    mockRealpath.mockImplementation(async (path) => String(path));
    mockStat.mockImplementation(
      async (path) =>
        ({
          isFile: () => path === INBOX_FILE,
          isSymbolicLink: () => false,
        }) as Awaited<ReturnType<typeof stat>>,
    );

    await expect(resolveInboxPath(WORKSPACE_PATH, folderPath)).resolves.toBeNull();
    await expect(resolveInboxPath(WORKSPACE_PATH, LOCAL_PATH)).resolves.toBe(INBOX_FILE);
    expect(mockStat).toHaveBeenCalledWith(fullFolderPath);
  });
});
