import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import { readOpenClawMediaFile } from '../src/main/media/resolve.js';

const mockOpen = vi.mocked(open);
const mockRealpath = vi.mocked(realpath);
const mockStat = vi.mocked(stat);
const mockRealpathSync = vi.mocked(realpathSync);
const previousStateDir = process.env.OPENCLAW_STATE_DIR;
const STATE_DIR = resolve('openclaw-state-fixture');
const MEDIA_ROOT = join(STATE_DIR, 'media');
const MEDIA_FILE = join(MEDIA_ROOT, 'tool-image-generation', 'out.png');
const OUTSIDE_FILE = resolve('outside-fixture', 'passwd');

describe('OpenClaw media file access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENCLAW_STATE_DIR = STATE_DIR;
  });

  afterEach(() => {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
  });

  it('reads opened image fds inside the OpenClaw media root', async () => {
    const readFile = vi.fn().mockResolvedValue('aW1hZ2U=');
    const close = vi.fn().mockResolvedValue(undefined);
    const openedStat = { dev: 1, ino: 2, isFile: () => true, size: 1024 };
    mockOpen.mockResolvedValue({
      fd: 42,
      stat: vi.fn().mockResolvedValue(openedStat),
      readFile,
      close,
    } as unknown as Awaited<ReturnType<typeof open>>);
    mockRealpath.mockImplementation(async (path) => {
      if (path === MEDIA_ROOT) return MEDIA_ROOT;
      if (path === MEDIA_FILE) return MEDIA_FILE;
      throw new Error(`unexpected path ${path}`);
    });
    mockRealpathSync.mockReturnValue(MEDIA_FILE);
    mockStat.mockResolvedValue(openedStat as Awaited<ReturnType<typeof stat>>);

    await expect(readOpenClawMediaFile(MEDIA_FILE)).resolves.toBe('aW1hZ2U=');
    expect(readFile).toHaveBeenCalledWith({ encoding: 'base64' });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('rejects opened fds outside the OpenClaw media root', async () => {
    const readFile = vi.fn().mockResolvedValue('c2VjcmV0');
    const close = vi.fn().mockResolvedValue(undefined);
    const openedStat = { dev: 1, ino: 2, isFile: () => true, size: 1024 };
    mockOpen.mockResolvedValue({
      fd: 42,
      stat: vi.fn().mockResolvedValue(openedStat),
      readFile,
      close,
    } as unknown as Awaited<ReturnType<typeof open>>);
    mockRealpath.mockImplementation(async (path) => {
      if (path === MEDIA_ROOT) return MEDIA_ROOT;
      if (path === MEDIA_FILE) return OUTSIDE_FILE;
      throw new Error(`unexpected path ${path}`);
    });
    mockRealpathSync.mockReturnValue(OUTSIDE_FILE);
    mockStat.mockResolvedValue(openedStat as Awaited<ReturnType<typeof stat>>);

    await expect(readOpenClawMediaFile(MEDIA_FILE)).resolves.toBeNull();
    expect(readFile).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('rejects non-image extensions before reading', async () => {
    const readFile = vi.fn().mockResolvedValue('c2VjcmV0');
    const close = vi.fn().mockResolvedValue(undefined);
    mockOpen.mockResolvedValue({
      fd: 42,
      stat: vi.fn().mockResolvedValue({ isFile: () => true, size: 1024 }),
      readFile,
      close,
    } as unknown as Awaited<ReturnType<typeof open>>);
    mockRealpath.mockResolvedValue(MEDIA_ROOT);
    const nonImageFile = join(MEDIA_ROOT, 'secret.txt');
    mockRealpathSync.mockReturnValue(nonImageFile);

    await expect(readOpenClawMediaFile(nonImageFile)).resolves.toBeNull();
    expect(mockOpen).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it('rejects paths outside the media root before opening them', async () => {
    await expect(readOpenClawMediaFile(resolve('outside-fixture', 'out.png'))).resolves.toBeNull();
    expect(mockOpen).not.toHaveBeenCalled();
  });

  it('falls back to the requested real path when macOS keeps dev fd aliases unresolved', async () => {
    const darwinSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    const readFile = vi.fn().mockResolvedValue('aW1hZ2U=');
    const close = vi.fn().mockResolvedValue(undefined);
    const openedStat = { dev: 1, ino: 2, isFile: () => true, size: 1024 };
    mockOpen.mockResolvedValue({
      fd: 42,
      stat: vi.fn().mockResolvedValue(openedStat),
      readFile,
      close,
    } as unknown as Awaited<ReturnType<typeof open>>);
    mockRealpath.mockImplementation(async (path) => {
      if (path === MEDIA_ROOT) return MEDIA_ROOT;
      if (path === MEDIA_FILE) return MEDIA_FILE;
      throw new Error(`unexpected path ${path}`);
    });
    mockRealpathSync.mockReturnValue('/dev/fd/42');
    mockStat.mockResolvedValue(openedStat as Awaited<ReturnType<typeof stat>>);

    await expect(readOpenClawMediaFile(MEDIA_FILE)).resolves.toBe('aW1hZ2U=');
    expect(readFile).toHaveBeenCalledWith({ encoding: 'base64' });
    expect(close).toHaveBeenCalledTimes(1);
    darwinSpy.mockRestore();
  });

  it('rejects paths that change between open and realpath fallback', async () => {
    const readFile = vi.fn().mockResolvedValue('c2VjcmV0');
    const close = vi.fn().mockResolvedValue(undefined);
    const openedStat = { dev: 1, ino: 2, isFile: () => true, size: 1024 };
    mockOpen.mockResolvedValue({
      fd: 42,
      stat: vi.fn().mockResolvedValue(openedStat),
      readFile,
      close,
    } as unknown as Awaited<ReturnType<typeof open>>);
    mockRealpath.mockImplementation(async (path) => {
      if (path === MEDIA_ROOT) return MEDIA_ROOT;
      if (path === MEDIA_FILE) return MEDIA_FILE;
      throw new Error(`unexpected path ${path}`);
    });
    mockRealpathSync.mockReturnValue('/dev/fd/42');
    mockStat.mockResolvedValue({ dev: 1, ino: 3, isFile: () => true, size: 1024 } as Awaited<ReturnType<typeof stat>>);

    await expect(readOpenClawMediaFile(MEDIA_FILE)).resolves.toBeNull();
    expect(readFile).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
