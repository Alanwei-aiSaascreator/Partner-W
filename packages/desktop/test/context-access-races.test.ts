import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanFolder } from '../src/main/context/file-index.js';
import { readContextFile } from '../src/main/context/file-reader.js';

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
        readContextFile(join(root, 'note.txt'), [canonicalRoot], {
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
        readContextFile(filePath, [canonicalRoot], {
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
        scanFolder(canonicalRoot, {
          testHooks: {
            afterRootValidation: () => {
              renameSync(root, movedRoot);
              symlinkSync(outside, root, process.platform === 'win32' ? 'junction' : 'dir');
            },
          },
        }),
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
        scanFolder(canonicalRoot, {
          testHooks: {
            afterEntryLstat: (entryPath) => {
              if (replaced || entryPath !== filePath) return;
              replaced = true;
              renameSync(filePath, movedPath);
              writeFileSync(filePath, 'replacement');
            },
          },
        }),
      ).toThrow(/changed|unavailable/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
