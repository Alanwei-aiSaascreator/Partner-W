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
import { __testing, readOpenClawMediaFile } from '../src/main/media/resolve.js';

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

/**
 * 身份判定 —— `media/resolve.ts` 里那段 `isSameFile`。
 *
 * ⚠️ 为什么只能函数层钉：要构造"只有 dev/ino 不同"的形态，size/mtime 能对齐，
 *    但这里比对的就是 dev/ino 本身，真文件上没法让它们"只差 1"。
 *    （`ino` 是 64 位，Node 用 Number 暴露 ⇒ 超过 2^53 后相邻值舍入成同一个。）
 *
 * 这个判定的用途是"重算出来的真实路径还是我刚打开的那个文件吗" ——
 * 答错就是把**另一份文件**当成允许的媒体发出去，而且**不报错**。
 */
describe('媒体路径的文件身份（64 位 ino 不许丢精度）', () => {
  const statsWith = (ino: bigint, dev = 1n): Parameters<typeof __testing.isSameFile>[0] =>
    ({ dev, ino }) as Parameters<typeof __testing.isSameFile>[0];

  it('⭐ 两个不同的 64 位 ino 转成 number 后相等 ⇒ 必须判为**不同**文件', () => {
    expect(Number(10977524094393692n) === Number(10977524094393693n), '前提：舍入后相等').toBe(true);

    expect(__testing.isSameFile(statsWith(10977524094393692n), statsWith(10977524094393693n))).toBe(false);
  });

  it('同一个文件必须判为相同', () => {
    const ino = 39125021765459235n;
    expect(__testing.isSameFile(statsWith(ino), statsWith(ino))).toBe(true);
  });

  it('换卷（dev 不同）即使 ino 一样也要判为不同', () => {
    expect(__testing.isSameFile(statsWith(7n, 1n), statsWith(7n, 2n))).toBe(false);
  });

  it('身份为 0（文件系统没给）⇒ 判为"不是同一个"（保守）', () => {
    expect(__testing.isSameFile(statsWith(0n), statsWith(0n))).toBe(false);
  });
});
