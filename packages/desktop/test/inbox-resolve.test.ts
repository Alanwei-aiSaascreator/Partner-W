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
import { readInboxFile, readInboxFileForSend, resolveInboxPath } from '../src/main/inbox/resolve.js';

const mockOpen = vi.mocked(open);
const mockRealpath = vi.mocked(realpath);
const mockStat = vi.mocked(stat);
const mockRealpathSync = vi.mocked(realpathSync);
const WORKSPACE_PATH = resolve('workspace-fixture');
const LOCAL_PATH = join('task-1', 'inbox', 'file.txt');
const INBOX_DIR = join(WORKSPACE_PATH, 'task-1', 'inbox');
const INBOX_FILE = join(INBOX_DIR, 'file.txt');
const OUTSIDE_FILE = resolve('outside-fixture', 'passwd');

function fileStats(dev: number, ino: number, size = 1): { dev: number; ino: number; size: number; isFile: () => true } {
  return { dev, ino, size, isFile: () => true };
}

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
      stat: vi.fn().mockResolvedValue(fileStats(1, 2)),
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
    mockStat.mockResolvedValue(fileStats(1, 2) as Awaited<ReturnType<typeof stat>>);

    await expect(readInboxFile(WORKSPACE_PATH, LOCAL_PATH)).resolves.toBe('aGVsbG8=');
    expect(readFile).toHaveBeenCalledWith({ encoding: 'base64' });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('rejects opened fds that resolve outside the inbox dir', async () => {
    const readFile = vi.fn().mockResolvedValue('aGVsbG8=');
    const close = vi.fn().mockResolvedValue(undefined);
    mockOpen.mockResolvedValue({
      fd: 42,
      stat: vi.fn().mockResolvedValue(fileStats(1, 2)),
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

  it('fails closed when the opened handle has no strong identity', async () => {
    const readFile = vi.fn().mockResolvedValue('aGVsbG8=');
    const close = vi.fn().mockResolvedValue(undefined);
    mockOpen.mockResolvedValue({
      fd: 42,
      stat: vi.fn().mockResolvedValue(fileStats(0, 0)),
      readFile,
      close,
    } as unknown as Awaited<ReturnType<typeof open>>);

    await expect(readInboxFile(WORKSPACE_PATH, LOCAL_PATH)).resolves.toBeNull();
    expect(readFile).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('rejects a Windows-style path swap whose final target identity differs from the opened handle', async () => {
    const readFile = vi.fn().mockResolvedValue('aGVsbG8=');
    const close = vi.fn().mockResolvedValue(undefined);
    mockOpen.mockResolvedValue({
      fd: 42,
      stat: vi.fn().mockResolvedValue(fileStats(1, 2)),
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
    mockStat.mockResolvedValue(fileStats(1, 3) as Awaited<ReturnType<typeof stat>>);

    await expect(readInboxFile(WORKSPACE_PATH, LOCAL_PATH)).resolves.toBeNull();
    expect(readFile).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('rejects a final path identity change immediately before reading', async () => {
    const readFile = vi.fn().mockResolvedValue('aGVsbG8=');
    const close = vi.fn().mockResolvedValue(undefined);
    mockOpen.mockResolvedValue({
      fd: 42,
      stat: vi.fn().mockResolvedValue(fileStats(1, 2)),
      readFile,
      close,
    } as unknown as Awaited<ReturnType<typeof open>>);
    mockRealpath.mockImplementation(async (path) => String(path));
    mockRealpathSync.mockReturnValue(INBOX_FILE);
    mockStat
      .mockResolvedValueOnce(fileStats(1, 2) as Awaited<ReturnType<typeof stat>>)
      .mockResolvedValueOnce(fileStats(1, 3) as Awaited<ReturnType<typeof stat>>);

    await expect(readInboxFile(WORKSPACE_PATH, LOCAL_PATH)).resolves.toBeNull();
    expect(readFile).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('rejects a send read when an inbox file grows beyond 25MB after it is opened', async () => {
    const readFile = vi.fn().mockResolvedValue('oversized');
    const close = vi.fn().mockResolvedValue(undefined);
    const handleStat = vi
      .fn()
      .mockResolvedValueOnce(fileStats(1, 2, 1))
      .mockResolvedValueOnce(fileStats(1, 2, 25 * 1024 * 1024 + 1));
    mockOpen.mockResolvedValue({ fd: 42, stat: handleStat, readFile, close } as unknown as Awaited<
      ReturnType<typeof open>
    >);
    mockRealpath.mockImplementation(async (path) => String(path));
    mockRealpathSync.mockReturnValue(INBOX_FILE);
    mockStat
      .mockResolvedValueOnce(fileStats(1, 2, 1) as Awaited<ReturnType<typeof stat>>)
      .mockResolvedValueOnce(fileStats(1, 2, 25 * 1024 * 1024 + 1) as Awaited<ReturnType<typeof stat>>);
    await expect(readInboxFileForSend(WORKSPACE_PATH, LOCAL_PATH, 25 * 1024 * 1024)).resolves.toBeNull();
    expect(readFile).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('uses bounded short reads until the opened file size is filled', async () => {
    const bytes = Buffer.from('hello');
    const read = vi
      .fn()
      .mockImplementationOnce(async (buffer: Buffer, offset: number) => {
        bytes.copy(buffer, offset, 0, 2);
        return { bytesRead: 2, buffer };
      })
      .mockImplementationOnce(async (buffer: Buffer, offset: number) => {
        bytes.copy(buffer, offset, 2);
        return { bytesRead: 3, buffer };
      });
    const close = vi.fn().mockResolvedValue(undefined);
    const handleStat = vi.fn().mockResolvedValue(fileStats(1, 2, bytes.length));
    mockOpen.mockResolvedValue({ fd: 42, stat: handleStat, read, close } as unknown as Awaited<
      ReturnType<typeof open>
    >);
    mockRealpath.mockImplementation(async (path) => String(path));
    mockRealpathSync.mockReturnValue(INBOX_FILE);
    mockStat.mockResolvedValue(fileStats(1, 2, bytes.length) as Awaited<ReturnType<typeof stat>>);

    await expect(readInboxFileForSend(WORKSPACE_PATH, LOCAL_PATH, 25 * 1024 * 1024)).resolves.toEqual({
      content: bytes.toString('base64'),
      byteLength: bytes.length,
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls[0]?.[2]).toBe(5);
    expect(read.mock.calls[1]?.[2]).toBe(3);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('rejects growth after a bounded read and still closes the handle', async () => {
    const read = vi.fn(async (buffer: Buffer) => {
      buffer[0] = 120;
      return { bytesRead: 1, buffer };
    });
    const close = vi.fn().mockResolvedValue(undefined);
    const handleStat = vi
      .fn()
      .mockResolvedValueOnce(fileStats(1, 2, 1))
      .mockResolvedValueOnce(fileStats(1, 2, 1))
      .mockResolvedValueOnce(fileStats(1, 2, 2));
    mockOpen.mockResolvedValue({ fd: 42, stat: handleStat, read, close } as unknown as Awaited<
      ReturnType<typeof open>
    >);
    mockRealpath.mockImplementation(async (path) => String(path));
    mockRealpathSync.mockReturnValue(INBOX_FILE);
    mockStat.mockResolvedValue(fileStats(1, 2, 1) as Awaited<ReturnType<typeof stat>>);

    await expect(readInboxFileForSend(WORKSPACE_PATH, LOCAL_PATH, 25 * 1024 * 1024)).resolves.toBeNull();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('rejects an early zero-byte read and still closes the handle', async () => {
    const read = vi.fn(async (buffer: Buffer) => ({ bytesRead: 0, buffer }));
    const close = vi.fn().mockResolvedValue(undefined);
    const handleStat = vi.fn().mockResolvedValue(fileStats(1, 2, 1));
    mockOpen.mockResolvedValue({ fd: 42, stat: handleStat, read, close } as unknown as Awaited<
      ReturnType<typeof open>
    >);
    mockRealpath.mockImplementation(async (path) => String(path));
    mockRealpathSync.mockReturnValue(INBOX_FILE);
    mockStat.mockResolvedValue(fileStats(1, 2, 1) as Awaited<ReturnType<typeof stat>>);

    await expect(readInboxFileForSend(WORKSPACE_PATH, LOCAL_PATH, 25 * 1024 * 1024)).resolves.toBeNull();
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
    // ⚠️ 参数里带上 `{ bigint: true }` 是**故意钉死**的，不是顺手抄的实现细节：
    //    `ino` 是 64 位，用 Number 版读会让"相邻的两个文件"舍入成同一个身份
    //    ⇒ "这个文件被换过吗"答成"没换"（fail-open，见 `util/file-identity.ts`）。
    //    这条断言原来只写 `(fullFolderPath)` —— 那样**改回 Number 也照样绿**。
    expect(mockStat).toHaveBeenCalledWith(fullFolderPath, { bigint: true });
  });
});
