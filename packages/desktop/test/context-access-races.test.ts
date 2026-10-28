import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { __testing as fileIndexTesting, scanFolder } from '../src/main/context/file-index.js';
import { __testing as fileReaderTesting, readContextFileForSend } from '../src/main/context/file-reader.js';

describe('context access race defenses', () => {
  it('rejects a granted root replaced after validation but before opening the file', () => {
    const parent = mkdtempSync(join(tmpdir(), 'clawwork-read-root-race-'));
    const root = join(parent, 'granted');
    const movedRoot = join(parent, 'moved');
    const outside = join(parent, 'outside');
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(join(root, 'note.txt'), 'trusted');
    writeFileSync(join(outside, 'note.txt'), 'outside');
    const canonicalRoot = realpathSync.native(root);

    try {
      expect(() =>
        fileReaderTesting.readContextFileWithHooks(join(root, 'note.txt'), [canonicalRoot], {
          beforeOpen: () => {
            renameSync(root, movedRoot);
            symlinkSync(outside, root, process.platform === 'win32' ? 'junction' : 'dir');
          },
        }),
      ).toThrow(/changed|outside|unavailable/i);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('rejects a file object replaced between validation and open', () => {
    const root = mkdtempSync(join(tmpdir(), 'clawwork-read-file-race-'));
    const filePath = join(root, 'note.txt');
    const movedPath = join(root, 'old-note.txt');
    writeFileSync(filePath, 'trusted');
    const canonicalRoot = realpathSync.native(root);

    try {
      expect(() =>
        fileReaderTesting.readContextFileWithHooks(filePath, [canonicalRoot], {
          beforeOpen: () => {
            renameSync(filePath, movedPath);
            writeFileSync(filePath, 'replacement');
          },
        }),
      ).toThrow(/changed|unavailable/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a scan when the granted root changes after validation', () => {
    const parent = mkdtempSync(join(tmpdir(), 'clawwork-scan-root-race-'));
    const root = join(parent, 'granted');
    const movedRoot = join(parent, 'moved');
    const outside = join(parent, 'outside');
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(join(root, 'note.txt'), 'trusted');
    writeFileSync(join(outside, 'outside.txt'), 'outside');
    const canonicalRoot = realpathSync.native(root);

    try {
      expect(() =>
        fileIndexTesting.scanFolderWithHooks(
          canonicalRoot,
          {},
          {
            afterRootValidation: () => {
              renameSync(root, movedRoot);
              symlinkSync(outside, root, process.platform === 'win32' ? 'junction' : 'dir');
            },
          },
        ),
      ).toThrow(/changed|outside|unavailable/i);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('rejects a scan entry replaced after lstat', () => {
    const root = mkdtempSync(join(tmpdir(), 'clawwork-scan-file-race-'));
    const filePath = join(root, 'note.txt');
    const movedPath = join(root, 'old-note.txt');
    writeFileSync(filePath, 'trusted');
    const canonicalRoot = realpathSync.native(root);
    let replaced = false;

    try {
      expect(() =>
        fileIndexTesting.scanFolderWithHooks(
          canonicalRoot,
          {},
          {
            afterEntryLstat: (entryPath) => {
              if (replaced || entryPath !== filePath) return;
              replaced = true;
              renameSync(filePath, movedPath);
              writeFileSync(filePath, 'replacement');
            },
          },
        ),
      ).toThrow(/changed|unavailable/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects when a path is switched back after open but the fd remains bound to the replacement object', () => {
    const parent = mkdtempSync(join(tmpdir(), 'clawwork-read-switchback-'));
    const root = join(parent, 'granted');
    const outside = join(parent, 'outside');
    mkdirSync(root);
    mkdirSync(outside);
    const filePath = join(root, 'note.txt');
    const trustedBackup = join(root, 'trusted.txt');
    const outsideFile = join(outside, 'outside.txt');
    const outsideAfterOpen = join(outside, 'opened.txt');
    writeFileSync(filePath, 'trusted');
    writeFileSync(outsideFile, 'outside');
    const canonicalRoot = realpathSync.native(root);

    try {
      expect(() =>
        fileReaderTesting.readContextFileWithHooks(filePath, [canonicalRoot], {
          beforeOpen: () => {
            renameSync(filePath, trustedBackup);
            renameSync(outsideFile, filePath);
          },
          afterOpen: () => {
            renameSync(filePath, outsideAfterOpen);
            renameSync(trustedBackup, filePath);
          },
        }),
      ).toThrow(/changed|unavailable/i);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  /**
   * ⚠️ 2026-10-07（质量战役区 2 · P2-1）：**二进制** tier 的单文件 25MB 闸门不变 ——
   * 它在发送时整份 base64 出去，读之前就必须拒。（text tier 已放开：
   * 只内联 100KB，见下一条用例。）
   */
  it('rejects a send read when a granted **binary** file grows beyond 25MB after selection', () => {
    const root = mkdtempSync(join(tmpdir(), 'clawwork-send-size-race-'));
    const filePath = join(root, 'note.pdf');
    writeFileSync(filePath, 'x');
    const canonicalRoot = realpathSync.native(root);
    const testing = fileReaderTesting as typeof fileReaderTesting & {
      readContextFileForSendWithHooks: (
        absolutePath: string,
        contextFolders: string[],
        hooks: { afterOpen: () => void },
      ) => unknown;
    };

    try {
      expect(() =>
        testing.readContextFileForSendWithHooks(filePath, [canonicalRoot], {
          afterOpen: () => truncateSync(filePath, 25 * 1024 * 1024 + 1),
        }),
      ).toThrow(/too large/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * ⭐ 2026-10-07（质量战役区 2 · P2-1）：text tier 的 25MB 前置闸**已放开** ——
   * 30MB 的 .log 以前在"加进来"这一步就被拒（用户不知道为什么），实际只带 100KB 上模型。
   * 真机 fs（非 mock）：字节数按**实际内联字节**回报。
   */
  it('⭐ text tier：30MB 的文本可读，byteLength 按实际内联字节（~100KB）', () => {
    const root = mkdtempSync(join(tmpdir(), 'clawwork-send-text-large-'));
    const filePath = join(root, 'huge.log');
    writeFileSync(filePath, 'x');
    // 稀疏文件：快速造 30MB（不真写 30MB 数据）
    truncateSync(filePath, 30 * 1024 * 1024);
    const canonicalRoot = realpathSync.native(root);

    try {
      const result = readContextFileForSend(filePath, [canonicalRoot]);
      expect(result.tier).toBe('text');
      expect(result.size).toBe(30 * 1024 * 1024);
      expect(result.byteLength).toBeLessThan(200 * 1024);
      expect(result.byteLength).toBe(Buffer.byteLength(result.content, 'utf8'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('stops scanning at configured visited-entry and result budgets', () => {
    const root = mkdtempSync(join(tmpdir(), 'clawwork-scan-budget-'));
    for (let index = 0; index < 30; index++) writeFileSync(join(root, `file-${index}.txt`), String(index));
    const canonicalRoot = realpathSync.native(root);

    try {
      let visited = 0;
      const visitLimited = fileIndexTesting.scanFolderWithHooks(
        canonicalRoot,
        { maxVisitedEntries: 5, maxResults: 100 },
        { afterEntryLstat: () => visited++ },
      );
      expect(visited).toBe(5);
      expect(visitLimited).toHaveLength(5);

      const resultLimited = scanFolder(canonicalRoot, { maxVisitedEntries: 100, maxResults: 3 });
      expect(resultLimited).toHaveLength(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('finds a query match that appears after the first 100 safe files', () => {
    const root = mkdtempSync(join(tmpdir(), 'clawwork-scan-late-match-'));
    const orderedNames: string[] = [];
    for (let index = 0; index < 120; index++) {
      const name = `ordinary-${index.toString().padStart(3, '0')}.txt`;
      orderedNames.push(name);
      writeFileSync(join(root, name), 'ordinary');
    }
    orderedNames.push('needle-late.txt');
    writeFileSync(join(root, 'needle-late.txt'), 'match');
    const canonicalRoot = realpathSync.native(root);

    try {
      const readDirectory = vi.fn(() => orderedNames);
      const results = fileIndexTesting.scanFolderWithHooks(
        canonicalRoot,
        { query: 'needle', maxVisitedEntries: 121, maxResults: 100 },
        { readDirectory },
      );
      expect(readDirectory).toHaveBeenCalledWith(canonicalRoot);
      expect(results.map(({ fileName }) => fileName)).toEqual(['needle-late.txt']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the newest files even when they appear after the first 100 entries', () => {
    const root = mkdtempSync(join(tmpdir(), 'clawwork-scan-late-newest-'));
    const orderedNames: string[] = [];
    const oldTime = new Date('2020-01-01T00:00:00.000Z');
    for (let index = 0; index < 120; index++) {
      const name = `old-${index.toString().padStart(3, '0')}.txt`;
      const filePath = join(root, name);
      orderedNames.push(name);
      writeFileSync(filePath, 'old');
      utimesSync(filePath, oldTime, oldTime);
    }
    const newestName = 'newest-late.txt';
    const newestPath = join(root, newestName);
    orderedNames.push(newestName);
    writeFileSync(newestPath, 'newest');
    utimesSync(newestPath, new Date('2030-01-01T00:00:00.000Z'), new Date('2030-01-01T00:00:00.000Z'));
    const canonicalRoot = realpathSync.native(root);

    try {
      const readDirectory = vi.fn(() => orderedNames);
      const results = fileIndexTesting.scanFolderWithHooks(
        canonicalRoot,
        { maxVisitedEntries: 121, maxResults: 100 },
        { readDirectory },
      );
      expect(readDirectory).toHaveBeenCalledWith(canonicalRoot);
      expect(results).toHaveLength(100);
      expect(results[0]?.fileName).toBe(newestName);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
