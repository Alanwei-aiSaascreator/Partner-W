import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', () => ({
  openSync: vi.fn(),
  realpathSync: vi.fn(),
  fstatSync: vi.fn(),
  readSync: vi.fn(),
  closeSync: vi.fn(),
  statSync: vi.fn(),
}));

import { readContextFile, resolveFdRealPath } from '../src/main/context/file-reader.js';
import { openSync, realpathSync, fstatSync, readSync, closeSync, statSync } from 'fs';
import { join, resolve } from 'path';

const mockOpenSync = vi.mocked(openSync);
const mockRealpathSync = vi.mocked(realpathSync);
const mockFstatSync = vi.mocked(fstatSync);
const mockReadSync = vi.mocked(readSync);
const mockCloseSync = vi.mocked(closeSync);
const mockStatSync = vi.mocked(statSync);

const FAKE_FD = 42;
const CONTEXT_DIR = resolve('mock', 'context');
const LARGE_SIZE = 11 * 1024 * 1024;
const MAX_BINARY_SIZE = 10 * 1024 * 1024;

function mockFile(filePath: string, fileSize: number, platform = process.platform) {
  mockOpenSync.mockReturnValue(FAKE_FD);
  mockRealpathSync.mockImplementation(((p: string) => {
    if (platform === 'win32') {
      return p === filePath ? filePath : p;
    }
    return p === `/dev/fd/${FAKE_FD}` ? filePath : p;
  }) as typeof realpathSync);
  const rootStat = { dev: 1, ino: 1, birthtimeMs: 1, isDirectory: () => true, isFile: () => false };
  const fileStat = { dev: 1, ino: 2, birthtimeMs: 2, size: fileSize, isDirectory: () => false, isFile: () => true };
  mockStatSync.mockImplementation(((p: string) => (p === CONTEXT_DIR ? rootStat : fileStat)) as typeof statSync);
  mockFstatSync.mockReturnValue(fileStat as ReturnType<typeof fstatSync>);
  mockReadSync.mockReturnValue(0);
  mockCloseSync.mockReturnValue(undefined);
}

beforeEach(() => {
  mockOpenSync.mockReset();
  mockRealpathSync.mockReset();
  mockFstatSync.mockReset();
  mockReadSync.mockReset();
  mockCloseSync.mockReset();
  mockStatSync.mockReset();
});

describe('readContextFile', () => {
  it('returns truncated: true for PDF files larger than 10MB', () => {
    const filePath = join(CONTEXT_DIR, 'large.pdf');
    mockFile(filePath, LARGE_SIZE);

    const result = readContextFile(filePath, [CONTEXT_DIR]);

    expect(result.truncated).toBe(true);
    expect(result.size).toBe(LARGE_SIZE);
    expect(result.content).toBeDefined();
    expect(result.mimeType).toBe('application/pdf');
    expect(result.tier).toBe('document');
    expect(mockCloseSync).toHaveBeenCalledWith(FAKE_FD);
  });

  it('returns truncated: true for image files larger than 10MB', () => {
    const filePath = join(CONTEXT_DIR, 'large.jpg');
    mockFile(filePath, LARGE_SIZE);

    const result = readContextFile(filePath, [CONTEXT_DIR]);

    expect(result.truncated).toBe(true);
    expect(result.size).toBe(LARGE_SIZE);
    expect(result.content).toBeDefined();
    expect(result.mimeType).toBe('image/jpeg');
    expect(result.tier).toBe('image');
  });

  it('returns truncated: false for files smaller than 10MB', () => {
    const smallSize = 1024 * 1024;
    const filePath = join(CONTEXT_DIR, 'small.pdf');
    mockFile(filePath, smallSize);

    const result = readContextFile(filePath, [CONTEXT_DIR]);

    expect(result.truncated).toBe(false);
    expect(result.size).toBe(smallSize);
    expect(result.content).toBeDefined();
    expect(result.mimeType).toBe('application/pdf');
    expect(result.tier).toBe('document');
  });

  it('returns content as base64 for binary files', () => {
    const filePath = join(CONTEXT_DIR, 'large.jpg');
    mockFile(filePath, LARGE_SIZE);

    const result = readContextFile(filePath, [CONTEXT_DIR]);

    expect(() => Buffer.from(result.content, 'base64')).not.toThrow();
    const decoded = Buffer.from(result.content, 'base64');
    expect(decoded.length).toBe(Math.min(LARGE_SIZE, MAX_BINARY_SIZE));
  });

  it('truncates text files larger than 100KB and appends marker', () => {
    const filePath = join(CONTEXT_DIR, 'big.ts');
    mockFile(filePath, 200 * 1024);

    const result = readContextFile(filePath, [CONTEXT_DIR]);

    expect(result.truncated).toBe(true);
    expect(result.size).toBe(200 * 1024);
    expect(result.content).toContain('\n[truncated at 100KB]');
    expect(result.tier).toBe('text');
    expect(result.mimeType).toBe('text/typescript');
  });

  it('returns full content for text files under 100KB', () => {
    const filePath = join(CONTEXT_DIR, 'small.ts');
    mockFile(filePath, 50 * 1024);

    const result = readContextFile(filePath, [CONTEXT_DIR]);

    expect(result.truncated).toBe(false);
    expect(result.size).toBe(50 * 1024);
    expect(result.content).not.toContain('[truncated');
    expect(result.tier).toBe('text');
  });

  it('rejects an outside path before opening it', () => {
    const filePath = resolve('outside', 'not-allowed.pdf');
    mockFile(filePath, 1024);

    expect(() => readContextFile(filePath, [CONTEXT_DIR])).toThrow('path outside allowed context folders');
    expect(mockCloseSync).not.toHaveBeenCalled();
  });

  it('throws for unsupported file types', () => {
    const filePath = join(CONTEXT_DIR, 'data.exe');
    mockFile(filePath, 1024);

    expect(() => readContextFile(filePath, [CONTEXT_DIR])).toThrow('unsupported file type');
    expect(mockCloseSync).toHaveBeenCalledWith(FAKE_FD);
  });

  it('fails closed when fd and path identity fields are all zero', () => {
    const filePath = join(CONTEXT_DIR, 'small.pdf');
    mockFile(filePath, 1024);
    const unstable = {
      dev: 0,
      ino: 0,
      birthtimeMs: 0,
      size: 1024,
      isDirectory: () => false,
      isFile: () => true,
    } as ReturnType<typeof fstatSync>;
    mockFstatSync.mockReturnValue(unstable);
    mockStatSync.mockImplementation(((p: string) =>
      p === CONTEXT_DIR ? { ...unstable, isDirectory: () => true, isFile: () => false } : unstable) as typeof statSync);

    expect(() => readContextFile(filePath, [CONTEXT_DIR])).toThrow(/identity|changed|unavailable/i);
    expect(mockCloseSync).toHaveBeenCalledWith(FAKE_FD);
  });

  it('reads context files on win32 without /dev/fd', () => {
    const filePath = join(CONTEXT_DIR, 'small.pdf');
    const win32Spy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    mockFile(filePath, 1024, 'win32');

    const result = readContextFile(filePath, [CONTEXT_DIR]);

    expect(result.truncated).toBe(false);
    expect(result.mimeType).toBe('application/pdf');
    expect(mockRealpathSync).toHaveBeenCalledWith(filePath);
    expect(mockRealpathSync).not.toHaveBeenCalledWith(`/dev/fd/${FAKE_FD}`);
    win32Spy.mockRestore();
  });
});

describe('resolveFdRealPath', () => {
  it('resolves via /dev/fd on linux and darwin', () => {
    const filePath = join(CONTEXT_DIR, 'doc.pdf');
    mockRealpathSync.mockImplementation(((p: string) =>
      p === `/dev/fd/${FAKE_FD}` ? filePath : p) as typeof realpathSync);

    for (const platform of ['linux', 'darwin'] as const) {
      const spy = vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
      expect(resolveFdRealPath(FAKE_FD, filePath)).toBe(filePath);
      expect(mockRealpathSync).toHaveBeenCalledWith(`/dev/fd/${FAKE_FD}`);
      spy.mockRestore();
      mockRealpathSync.mockClear();
    }
  });

  it('resolves via absolutePath on win32', () => {
    const filePath = join(CONTEXT_DIR, 'doc.pdf');
    const win32Spy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    mockRealpathSync.mockImplementation(((p: string) => p) as typeof realpathSync);

    expect(resolveFdRealPath(FAKE_FD, filePath)).toBe(filePath);
    expect(mockRealpathSync).toHaveBeenCalledWith(filePath);
    expect(mockRealpathSync).not.toHaveBeenCalledWith(`/dev/fd/${FAKE_FD}`);
    win32Spy.mockRestore();
  });
});
