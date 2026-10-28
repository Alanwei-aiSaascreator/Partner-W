import { afterEach, describe, expect, it, vi } from 'vitest';
import { symlinkSync } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  truncate,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
  __testing,
  ImportIntegrityError,
  importTaskFiles,
  listImportedTaskFiles,
} from '../src/main/context/file-import.js';
import { readInboxFile } from '../src/main/inbox/resolve.js';

const symbolicLinkPaths = vi.hoisted(() => new Set<string>());
const zeroIdentityPaths = vi.hoisted(() => new Set<string>());
const handleTracker = vi.hoisted(() => ({ enabled: false, opened: 0, closed: 0 }));
const directoryReadFailures = vi.hoisted(() => new Set<string>());
const directoryCloseCounts = vi.hoisted(() => new Map<string, number>());
const linkFailureCodes = vi.hoisted(() => [] as string[]);
const execFileMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({ execFile: execFileMock }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    opendirSync: (path: string) => {
      const directory = actual.opendirSync(path);
      if (!directoryReadFailures.has(path)) return directory;
      return {
        readSync: () => {
          throw new Error('simulated directory read failure');
        },
        closeSync: () => {
          directoryCloseCounts.set(path, (directoryCloseCounts.get(path) ?? 0) + 1);
          directory.closeSync();
        },
      };
    },
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    copyFile: vi.fn(() => {
      throw new Error('path-based copyFile must not be used');
    }),
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (handleTracker.enabled) handleTracker.opened += 1;
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'close') {
            return async () => {
              if (handleTracker.enabled) handleTracker.closed += 1;
              return target.close();
            };
          }
          if (property === 'stat' && zeroIdentityPaths.has(String(args[0]))) {
            return async () => {
              const stats = await target.stat();
              return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, { dev: 0, ino: 0 });
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const result = await actual.lstat(...args);
      if (!symbolicLinkPaths.has(String(args[0]))) return result;
      return { ...result, isFile: () => false, isSymbolicLink: () => true };
    },
    link: async (...args: Parameters<typeof actual.link>) => {
      const code = linkFailureCodes.shift();
      if (code) throw Object.assign(new Error(`simulated ${code}`), { code });
      return actual.link(...args);
    },
  };
});

const roots: string[] = [];

async function fixture(): Promise<{ root: string; workspacePath: string; sources: string }> {
  const root = await mkdtemp(join(tmpdir(), 'clawwork-file-import-'));
  roots.push(root);
  const workspacePath = join(root, 'workspace');
  const sources = join(root, 'sources');
  await mkdir(workspacePath, { recursive: true });
  await mkdir(sources, { recursive: true });
  return { root, workspacePath, sources };
}

async function expectEmptyStaging(inbox: string): Promise<void> {
  expect((await readdir(inbox)).filter((name) => name.startsWith('.import-'))).toEqual(['.import-staging']);
  expect(await readdir(join(inbox, '.import-staging'))).toEqual([]);
}

afterEach(async () => {
  vi.restoreAllMocks();
  symbolicLinkPaths.clear();
  zeroIdentityPaths.clear();
  handleTracker.enabled = false;
  handleTracker.opened = 0;
  handleTracker.closed = 0;
  directoryReadFailures.clear();
  directoryCloseCounts.clear();
  linkFailureCodes.splice(0);
  execFileMock.mockReset();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('task file import', () => {
  it('copies multiple supported files into the task inbox and returns metadata', async () => {
    const { workspacePath, sources } = await fixture();
    const note = join(sources, 'note.txt');
    const image = join(sources, 'image.png');
    await writeFile(note, 'hello');
    await writeFile(image, Buffer.from([1, 2, 3]));

    const result = await importTaskFiles({ workspacePath, taskId: 'task-1', sourcePaths: [note, image] });

    expect(result.rejected).toEqual([]);
    expect(result.imported).toHaveLength(2);
    expect(result.imported[0]).toMatchObject({
      fileName: expect.stringMatching(/^note-.+\.txt$/),
      mimeType: 'text/plain',
      size: 5,
    });
    expect(result.imported[1]).toMatchObject({
      fileName: expect.stringMatching(/^image-.+\.png$/),
      mimeType: 'image/png',
      size: 3,
    });
    for (const item of result.imported) {
      expect(item.localPath).toBe(`task-1/inbox/${item.fileName}`);
      expect(item.localPath.split('/')).toHaveLength(3);
      await expect(readFile(join(workspacePath, item.localPath))).resolves.toBeDefined();
    }
    await expect(readInboxFile(workspacePath, result.imported[0].localPath)).resolves.toBe(
      Buffer.from('hello').toString('base64'),
    );
    const directEntries = await readdir(join(workspacePath, 'task-1', 'inbox'));
    expect(directEntries.filter((name) => name.startsWith('.import-'))).toEqual(['.import-staging']);
    expect(await readdir(join(workspacePath, 'task-1', 'inbox', '.import-staging'))).toEqual([]);
    expect(vi.mocked(copyFile)).not.toHaveBeenCalled();
  });

  it('accepts legacy Office formats while rejecting GIF and SVG', async () => {
    const { workspacePath, sources } = await fixture();
    const names = ['legacy.doc', 'legacy.xls', 'legacy.ppt', 'animation.gif', 'vector.svg'];
    await Promise.all(names.map((name) => writeFile(join(sources, name), name)));

    const result = await importTaskFiles({
      workspacePath,
      taskId: 'task-1',
      sourcePaths: names.map((name) => join(sources, name)),
    });

    expect(result.imported.map((item) => item.mimeType)).toEqual([
      'application/msword',
      'application/vnd.ms-excel',
      'application/vnd.ms-powerpoint',
    ]);
    expect(result.rejected).toEqual([
      { fileName: 'animation.gif', reason: 'unsupported' },
      { fileName: 'vector.svg', reason: 'unsupported' },
    ]);
  });

  it('imports and restores exact supported special names while rejecting other hidden files', async () => {
    const { workspacePath, sources } = await fixture();
    const names = [
      '.env',
      '.gitignore',
      '.dockerfile',
      '.editorconfig',
      '.cmake',
      '.makefile',
      'Dockerfile',
      'Makefile',
      '~$draft.docx',
      '.secret.txt',
    ];
    await Promise.all(names.map((name) => writeFile(join(sources, name), name)));

    const result = await importTaskFiles({
      workspacePath,
      taskId: 'task-1',
      sourcePaths: names.map((name) => join(sources, name)),
    });

    expect(result.imported).toHaveLength(8);
    expect(result.imported.every((item) => item.mimeType === 'text/plain')).toBe(true);
    expect(result.rejected).toEqual([
      { fileName: '~$draft.docx', reason: 'unsupported' },
      { fileName: '.secret.txt', reason: 'unsupported' },
    ]);
    await writeFile(join(workspacePath, 'task-1', 'inbox', '.env-not-an-import'), 'hidden');
    expect(
      listImportedTaskFiles(workspacePath, 'task-1')
        .map((item) => item.fileName)
        .sort(),
    ).toEqual(result.imported.map((item) => item.fileName).sort());
  });

  it('retries a bounded publish collision without overwriting the existing destination', async () => {
    const { workspacePath, sources } = await fixture();
    const source = join(sources, 'collision.txt');
    await writeFile(source, 'imported');
    let firstCandidate = '';
    let attempts = 0;

    const result = await __testing.importTaskFiles(
      { workspacePath, taskId: 'task-1', sourcePaths: [source] },
      {
        beforePublish: async ({ destinationPath }) => {
          attempts += 1;
          if (attempts !== 1) return;
          firstCandidate = destinationPath;
          await writeFile(destinationPath, 'existing');
        },
      },
    );

    expect(attempts).toBe(2);
    expect(result.rejected).toEqual([]);
    expect(result.imported).toHaveLength(1);
    expect(result.imported[0].fileName).not.toBe(basename(firstCandidate));
    await expect(readFile(firstCandidate, 'utf8')).resolves.toBe('existing');
    await expect(readFile(join(workspacePath, result.imported[0].localPath), 'utf8')).resolves.toBe('imported');
  });

  it('stops after the bounded number of publish collisions', async () => {
    const { workspacePath, sources } = await fixture();
    const source = join(sources, 'collision.txt');
    await writeFile(source, 'imported');
    let attempts = 0;

    const result = await __testing.importTaskFiles(
      { workspacePath, taskId: 'task-1', sourcePaths: [source] },
      {
        beforePublish: async ({ destinationPath }) => {
          attempts += 1;
          await writeFile(destinationPath, 'existing');
        },
      },
    );

    expect(attempts).toBe(10);
    expect(result).toEqual({ imported: [], rejected: [{ fileName: 'collision.txt', reason: 'copy-failed' }] });
  });

  it.each(['EPERM', 'ENOTSUP'])(
    'falls back to a native no-replace move when hard links are unavailable (%s)',
    async (code) => {
      const { workspacePath, sources } = await fixture();
      const source = join(sources, 'portable & [safe] file.txt');
      await writeFile(source, 'complete content');
      linkFailureCodes.push(code);

      const result = await __testing.importTaskFiles(
        { workspacePath, taskId: 'task-1', sourcePaths: [source] },
        { nativeMovePublisher: (stagingPath, destinationPath) => rename(stagingPath, destinationPath) },
      );

      expect(result.rejected).toEqual([]);
      expect(result.imported).toHaveLength(1);
      await expect(readFile(join(workspacePath, result.imported[0].localPath), 'utf8')).resolves.toBe(
        'complete content',
      );
      await expectEmptyStaging(join(workspacePath, 'task-1', 'inbox'));
    },
  );

  it('retries a native-move collision without overwriting the colliding file', async () => {
    const { workspacePath, sources } = await fixture();
    const source = join(sources, 'portable.txt');
    await writeFile(source, 'complete content');
    linkFailureCodes.push('EPERM');
    let attempts = 0;
    let collisionPath = '';

    const result = await __testing.importTaskFiles(
      { workspacePath, taskId: 'task-1', sourcePaths: [source] },
      {
        nativeMovePublisher: async (stagingPath, destinationPath) => {
          attempts += 1;
          if (attempts === 1) {
            collisionPath = destinationPath;
            await writeFile(destinationPath, 'existing');
            throw Object.assign(new Error('destination exists'), { code: 'EEXIST' });
          }
          await rename(stagingPath, destinationPath);
        },
      },
    );

    expect(attempts).toBe(2);
    expect(result.rejected).toEqual([]);
    await expect(readFile(collisionPath, 'utf8')).resolves.toBe('existing');
    await expect(readFile(join(workspacePath, result.imported[0].localPath), 'utf8')).resolves.toBe('complete content');
  });

  it('returns publish-unavailable when the native move helper fails without changing either path', async () => {
    const { workspacePath, sources } = await fixture();
    const source = join(sources, 'portable.txt');
    await writeFile(source, 'complete content');
    linkFailureCodes.push('EPERM');

    const result = await __testing.importTaskFiles(
      { workspacePath, taskId: 'task-1', sourcePaths: [source] },
      { nativeMovePublisher: () => Promise.reject(new Error('powershell.exe not found')) },
    );

    expect(result).toEqual({
      imported: [],
      rejected: [{ fileName: 'portable.txt', reason: 'publish-unavailable' }],
    });
    await expectEmptyStaging(join(workspacePath, 'task-1', 'inbox'));
  });

  it('keeps special-character paths out of the fixed PowerShell script', () => {
    const source = 'C:\\folder & one\\source [x].txt';
    const destination = 'C:\\folder & one\\target `$(x).txt';
    const args = __testing.windowsMoveArguments(source, destination);

    expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
    expect(args[3]).not.toContain(source);
    expect(args[3]).not.toContain(destination);
    expect(Buffer.from(args[4], 'base64url').toString('utf8')).toBe(source);
    expect(Buffer.from(args[5], 'base64url').toString('utf8')).toBe(destination);
  });

  it('resolves only the absolute system PowerShell even when a cwd-style fake exists', async () => {
    const { root } = await fixture();
    const systemRoot = join(root, 'Windows');
    const expected = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    await mkdir(dirname(expected), { recursive: true });
    await writeFile(expected, 'system executable');
    await writeFile(join(root, 'powershell.exe'), 'cwd fake');

    await expect(__testing.resolveWindowsPowerShellPath(systemRoot, false)).resolves.toBe(expected);
    expect(__testing.windowsMoveOptions).toMatchObject({ windowsHide: true, timeout: 15_000, maxBuffer: 64 * 1024 });
  });

  it('prefers the absolute Sysnative PowerShell path for a WOW64 process', async () => {
    const { root } = await fixture();
    const systemRoot = join(root, 'Windows');
    const expected = join(systemRoot, 'Sysnative', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    await mkdir(dirname(expected), { recursive: true });
    await writeFile(expected, 'system executable');

    await expect(__testing.resolveWindowsPowerShellPath(systemRoot, true)).resolves.toBe(expected);
  });

  it('executes only the resolved absolute system binary and never a cwd or PATH powershell', async () => {
    const { root } = await fixture();
    const systemRoot = join(root, 'Windows');
    const expected = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const cwdFake = join(root, 'powershell.exe');
    await mkdir(dirname(expected), { recursive: true });
    await writeFile(expected, 'system executable');
    await writeFile(cwdFake, 'cwd fake');
    const previousSystemRoot = process.env.SystemRoot;
    process.env.SystemRoot = systemRoot;
    execFileMock.mockImplementation((...args: unknown[]) => {
      const callback = args[3] as (error: Error) => void;
      callback(new Error('stop after executable resolution'));
    });

    try {
      await expect(__testing.nativeWindowsMove('C:\\source.txt', 'C:\\destination.txt')).rejects.toThrow(
        /executable resolution/,
      );
    } finally {
      if (previousSystemRoot === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = previousSystemRoot;
    }
    expect(execFileMock).toHaveBeenCalledWith(
      expected,
      expect.any(Array),
      expect.objectContaining({ windowsHide: true, timeout: 15_000, maxBuffer: 64 * 1024 }),
      expect.any(Function),
    );
    expect(execFileMock.mock.calls[0][0]).not.toBe('powershell.exe');
    expect(execFileMock.mock.calls[0][0]).not.toBe(cwdFake);
  });

  it('fails closed when the system PowerShell path is missing or redirected outside the system root', async () => {
    const missing = await fixture();
    await expect(__testing.resolveWindowsPowerShellPath(join(missing.root, 'Windows'), false)).rejects.toThrow(
      /PowerShell/,
    );

    const redirected = await fixture();
    const systemRoot = join(redirected.root, 'Windows');
    const powershellParent = join(systemRoot, 'System32', 'WindowsPowerShell');
    const external = join(redirected.root, 'external-powershell');
    await mkdir(join(systemRoot, 'System32'), { recursive: true });
    await mkdir(join(external, 'v1.0'), { recursive: true });
    await writeFile(join(external, 'v1.0', 'powershell.exe'), 'fake executable');
    symlinkSync(external, powershellParent, 'junction');

    await expect(__testing.resolveWindowsPowerShellPath(systemRoot, false)).rejects.toThrow(/PowerShell/);
  });

  it('cleans staging and reports publish-unavailable after a native move timeout', async () => {
    const { workspacePath, sources } = await fixture();
    const source = join(sources, 'timeout.txt');
    await writeFile(source, 'complete content');
    linkFailureCodes.push('EPERM');

    const result = await __testing.importTaskFiles(
      { workspacePath, taskId: 'task-1', sourcePaths: [source] },
      {
        nativeMovePublisher: () =>
          Promise.reject(Object.assign(new Error('native move timed out'), { code: 'ETIMEDOUT', killed: true })),
      },
    );

    expect(result.rejected).toEqual([{ fileName: 'timeout.txt', reason: 'publish-unavailable' }]);
    await expectEmptyStaging(join(workspacePath, 'task-1', 'inbox'));
  });

  it('uses unique safe names without overwriting same-name inputs or existing inbox files', async () => {
    const { workspacePath, sources } = await fixture();
    const left = join(sources, 'left');
    const right = join(sources, 'right');
    await mkdir(left, { recursive: true });
    await mkdir(right, { recursive: true });
    await writeFile(join(left, 'same.txt'), 'left');
    await writeFile(join(right, 'same.txt'), 'right');
    await mkdir(join(workspacePath, 'task-1', 'inbox'), { recursive: true });
    await writeFile(join(workspacePath, 'task-1', 'inbox', 'same.txt'), 'existing');

    const result = await importTaskFiles({
      workspacePath,
      taskId: 'task-1',
      sourcePaths: [join(left, 'same.txt'), join(right, 'same.txt')],
    });

    expect(new Set(result.imported.map((item) => item.fileName)).size).toBe(2);
    await expect(readFile(join(workspacePath, 'task-1', 'inbox', 'same.txt'), 'utf8')).resolves.toBe('existing');
    const copied = await Promise.all(
      result.imported.map((item) => readFile(join(workspacePath, item.localPath), 'utf8')),
    );
    expect(copied.sort()).toEqual(['left', 'right']);
  });

  it('removes traversal segments from names and rejects task ids that escape the workspace', async () => {
    const { workspacePath, sources } = await fixture();
    const nested = join(sources, 'nested');
    await mkdir(nested);
    const source = join(sources, 'payload.txt');
    await writeFile(source, 'safe');

    const result = await importTaskFiles({
      workspacePath,
      taskId: 'task-1',
      sourcePaths: [join(nested, '..', 'payload.txt')],
    });
    expect(result.imported[0].fileName).not.toMatch(/[\\/]/);
    expect(result.imported[0].fileName).toMatch(/^payload-.+\.txt$/);
    await expect(importTaskFiles({ workspacePath, taskId: '..', sourcePaths: [source] })).rejects.toThrow(/taskId/);
  });

  it('rejects every task id that is not one safe path component', async () => {
    const { workspacePath, sources } = await fixture();
    const source = join(sources, 'source.txt');
    await writeFile(source, 'safe');
    const unsafeTaskIds = ['.', '..', 'a/b', 'a\\b', 'a/../b', '..\\b', 'nul\0id', resolve(workspacePath, 'absolute')];

    for (const taskId of unsafeTaskIds) {
      await expect(importTaskFiles({ workspacePath, taskId, sourcePaths: [source] })).rejects.toThrow(/taskId/);
      expect(() => listImportedTaskFiles(workspacePath, taskId)).toThrow(/taskId/);
    }
  });

  it('rejects a symbolic-link source without copying it', async (context) => {
    const { workspacePath, sources } = await fixture();
    const source = join(sources, 'source.txt');
    const linked = join(sources, 'linked.txt');
    await writeFile(source, 'safe');
    try {
      symlinkSync(source, linked, 'file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        context.skip();
        return;
      }
      throw error;
    }

    const result = await importTaskFiles({ workspacePath, taskId: 'task-1', sourcePaths: [linked] });
    expect(result).toEqual({ imported: [], rejected: [{ fileName: 'linked.txt', reason: 'unavailable' }] });
    expect(listImportedTaskFiles(workspacePath, 'task-1')).toEqual([]);
  });

  it('deterministically rejects a source reported as a symbolic link', async () => {
    const { workspacePath, sources } = await fixture();
    const linked = join(sources, 'linked.txt');
    await writeFile(linked, 'safe');
    symbolicLinkPaths.add(linked);

    const result = await importTaskFiles({ workspacePath, taskId: 'task-1', sourcePaths: [linked] });
    expect(result).toEqual({ imported: [], rejected: [{ fileName: 'linked.txt', reason: 'unavailable' }] });
    expect(listImportedTaskFiles(workspacePath, 'task-1')).toEqual([]);
  });

  it('fails closed when a source handle has no strong identity', async () => {
    const { workspacePath, sources } = await fixture();
    const source = join(sources, 'zero-identity.txt');
    await writeFile(source, 'safe');
    zeroIdentityPaths.add(source);

    const result = await importTaskFiles({ workspacePath, taskId: 'task-1', sourcePaths: [source] });
    expect(result).toEqual({ imported: [], rejected: [{ fileName: 'zero-identity.txt', reason: 'unavailable' }] });
  });

  it('does not publish when the source identity changes after copy', async () => {
    const { workspacePath, sources } = await fixture();
    const source = join(sources, 'changing.txt');
    await writeFile(source, 'before');
    const result = await __testing.importTaskFiles(
      { workspacePath, taskId: 'task-1', sourcePaths: [source] },
      {
        afterChunkWritten: async () => {
          await rename(source, join(sources, 'original.txt'));
          await writeFile(source, 'replacement');
        },
      },
    );
    expect(result).toEqual({ imported: [], rejected: [{ fileName: 'changing.txt', reason: 'copy-failed' }] });
    expect(listImportedTaskFiles(workspacePath, 'task-1')).toEqual([]);
    await expectEmptyStaging(join(workspacePath, 'task-1', 'inbox'));
  });

  it('rejects without publishing an in-place same-size source rewrite during copying', async () => {
    const { workspacePath, sources } = await fixture();
    const source = join(sources, 'rewritten.txt');
    await writeFile(source, 'before');

    const result = await __testing.importTaskFiles(
      { workspacePath, taskId: 'task-1', sourcePaths: [source] },
      {
        afterChunkWritten: async () => {
          await writeFile(source, 'after!');
          const changed = new Date('2020-01-01T00:00:00Z');
          await utimes(source, changed, changed);
        },
      },
    );

    expect(result).toEqual({ imported: [], rejected: [{ fileName: 'rewritten.txt', reason: 'copy-failed' }] });
    expect(listImportedTaskFiles(workspacePath, 'task-1')).toEqual([]);
    await expectEmptyStaging(join(workspacePath, 'task-1', 'inbox'));
  });

  it('rejects without publishing a copied destination that exceeds the size limit', async () => {
    const { workspacePath, sources } = await fixture();
    const source = join(sources, 'growing.txt');
    await writeFile(source, 'small');
    const result = await __testing.importTaskFiles(
      { workspacePath, taskId: 'task-1', sourcePaths: [source] },
      {
        afterChunkWritten: async ({ destinationPath }) => {
          await truncate(destinationPath, 100 * 1024 * 1024 + 1);
        },
      },
    );
    expect(result).toEqual({ imported: [], rejected: [{ fileName: 'growing.txt', reason: 'too-large' }] });
    expect(listImportedTaskFiles(workspacePath, 'task-1')).toEqual([]);
    await expectEmptyStaging(join(workspacePath, 'task-1', 'inbox'));
  });

  it('cleans repeated near-limit failed staging files immediately', async () => {
    const { workspacePath, sources } = await fixture();
    const sourcePaths = [join(sources, 'first.txt'), join(sources, 'second.txt')];
    await Promise.all(sourcePaths.map((sourcePath) => writeFile(sourcePath, 'small')));

    const result = await __testing.importTaskFiles(
      { workspacePath, taskId: 'task-1', sourcePaths },
      {
        afterChunkWritten: async ({ destinationPath }) => {
          await truncate(destinationPath, 99 * 1024 * 1024);
          throw new Error('simulated failure after growth');
        },
      },
    );

    expect(result.rejected).toEqual([
      { fileName: 'first.txt', reason: 'copy-failed' },
      { fileName: 'second.txt', reason: 'copy-failed' },
    ]);
    await expectEmptyStaging(join(workspacePath, 'task-1', 'inbox'));
  });

  it('rejects a target whose timestamps change during hash verification', async () => {
    const { workspacePath, sources } = await fixture();
    const source = join(sources, 'target-stability.txt');
    await writeFile(source, 'stable');

    await expect(
      __testing.importTaskFiles(
        { workspacePath, taskId: 'task-1', sourcePaths: [source] },
        {
          beforeTargetHash: async ({ destinationPath }) => {
            const changed = new Date('2020-01-01T00:00:00Z');
            await utimes(destinationPath, changed, changed);
          },
        },
      ),
    ).rejects.toBeInstanceOf(ImportIntegrityError);
    expect(listImportedTaskFiles(workspacePath, 'task-1')).toEqual([]);
  });

  it('rejects an inbox replacement after validation and before target open without writing outside', async () => {
    const { root, workspacePath, sources } = await fixture();
    const source = join(sources, 'source.txt');
    const inbox = join(workspacePath, 'task-1', 'inbox');
    const heldInbox = join(root, 'held-inbox');
    const external = join(root, 'external');
    await writeFile(source, 'safe');
    await mkdir(external);

    await expect(
      __testing.importTaskFiles(
        { workspacePath, taskId: 'task-1', sourcePaths: [source] },
        {
          beforeTargetOpen: async () => {
            await rename(inbox, heldInbox);
            symlinkSync(external, inbox, 'junction');
          },
        },
      ),
    ).rejects.toBeInstanceOf(ImportIntegrityError);
    await expect(readdir(external)).resolves.toEqual([]);
  });

  it('rejects an inbox replacement immediately before publish without exposing an external file', async () => {
    const { root, workspacePath, sources } = await fixture();
    const source = join(sources, 'source.txt');
    const inbox = join(workspacePath, 'task-1', 'inbox');
    const heldInbox = join(root, 'held-inbox');
    const external = join(root, 'external');
    await writeFile(source, 'safe');
    await mkdir(external);

    await expect(
      __testing.importTaskFiles(
        { workspacePath, taskId: 'task-1', sourcePaths: [source] },
        {
          beforePublish: async () => {
            await rename(inbox, heldInbox);
            symlinkSync(external, inbox, 'junction');
          },
        },
      ),
    ).rejects.toBeInstanceOf(ImportIntegrityError);
    await expect(readdir(external)).resolves.toEqual([]);
  });

  it('does not unlink an external same-name file when inbox changes before cleanup', async () => {
    const { root, workspacePath, sources } = await fixture();
    const source = join(sources, 'source.txt');
    const inbox = join(workspacePath, 'task-1', 'inbox');
    const heldInbox = join(root, 'held-inbox');
    const external = join(root, 'external');
    await writeFile(source, 'safe');
    await mkdir(external);

    await expect(
      __testing.importTaskFiles(
        { workspacePath, taskId: 'task-1', sourcePaths: [source] },
        {
          afterChunkWritten: () => {
            throw new Error('force cleanup');
          },
          beforeCleanup: async ({ destinationPath }) => {
            const name = basename(destinationPath);
            await rename(inbox, heldInbox);
            symlinkSync(external, inbox, 'junction');
            await writeFile(join(external, name), 'keep');
          },
        },
      ),
    ).rejects.toBeInstanceOf(ImportIntegrityError);
    const externalFiles = await readdir(external);
    expect(externalFiles).toHaveLength(1);
    await expect(readFile(join(external, externalFiles[0]), 'utf8')).resolves.toBe('keep');
  });

  it('closes source, target, and cleanup handles when copying fails after target creation', async () => {
    const { workspacePath, sources } = await fixture();
    const source = join(sources, 'source.txt');
    await writeFile(source, 'safe');
    handleTracker.enabled = true;

    const result = await __testing.importTaskFiles(
      { workspacePath, taskId: 'task-1', sourcePaths: [source] },
      { afterChunkWritten: () => Promise.reject(new Error('stop')) },
    );

    expect(result.rejected).toEqual([{ fileName: 'source.txt', reason: 'copy-failed' }]);
    expect(handleTracker).toMatchObject({ opened: 3, closed: 3 });
  });

  it('rejects a task directory junction that points outside the workspace', async () => {
    const { root, workspacePath, sources } = await fixture();
    const external = join(root, 'external-task');
    const source = join(sources, 'source.txt');
    await mkdir(join(external, 'inbox'), { recursive: true });
    await writeFile(source, 'safe');
    symlinkSync(external, join(workspacePath, 'task-1'), 'junction');

    await expect(importTaskFiles({ workspacePath, taskId: 'task-1', sourcePaths: [source] })).rejects.toThrow(
      /trusted task inbox/,
    );
    expect(() => listImportedTaskFiles(workspacePath, 'task-1')).toThrow(/trusted task inbox/);
    await expect(readdir(join(external, 'inbox'))).resolves.toEqual([]);
  });

  it('rejects an inbox junction that points outside the task directory', async () => {
    const { root, workspacePath, sources } = await fixture();
    const external = join(root, 'external-inbox');
    const taskDir = join(workspacePath, 'task-1');
    const source = join(sources, 'source.txt');
    await mkdir(taskDir, { recursive: true });
    await mkdir(external, { recursive: true });
    await writeFile(source, 'safe');
    symlinkSync(external, join(taskDir, 'inbox'), 'junction');

    await expect(importTaskFiles({ workspacePath, taskId: 'task-1', sourcePaths: [source] })).rejects.toThrow(
      /trusted task inbox/,
    );
    expect(() => listImportedTaskFiles(workspacePath, 'task-1')).toThrow(/trusted task inbox/);
    await expect(readdir(external)).resolves.toEqual([]);
  });

  it('rejects unsupported, oversized, unavailable, symlink, and failed copies independently', async () => {
    const { workspacePath, sources } = await fixture();
    const good = join(sources, 'good.txt');
    const unsupported = join(sources, 'archive.zip');
    const oversized = join(sources, 'large.pdf');
    const missing = join(sources, 'gone.txt');
    const linked = join(sources, 'linked.txt');
    const copyFailure = join(sources, 'copy-failure.txt');
    await writeFile(good, 'good');
    await writeFile(unsupported, 'zip');
    await writeFile(oversized, 'pdf');
    await truncate(oversized, 100 * 1024 * 1024 + 1);
    await mkdir(linked);
    await writeFile(copyFailure, 'fail');
    const result = await __testing.importTaskFiles(
      {
        workspacePath,
        taskId: 'task-1',
        sourcePaths: [unsupported, oversized, missing, linked, copyFailure, good],
      },
      {
        beforeTargetOpen: ({ sourcePath }) => {
          if (sourcePath === copyFailure) throw new Error('simulated copy failure');
        },
      },
    );

    expect(result.imported).toHaveLength(1);
    expect(result.rejected).toEqual([
      { fileName: 'archive.zip', reason: 'unsupported' },
      { fileName: 'large.pdf', reason: 'too-large' },
      { fileName: 'gone.txt', reason: 'unavailable' },
      { fileName: 'linked.txt', reason: 'unavailable' },
      { fileName: 'copy-failure.txt', reason: 'copy-failed' },
    ]);
    expect(result.rejected.every((item) => item.fileName === basename(item.fileName))).toBe(true);
    await expect(readFile(join(workspacePath, result.imported[0].localPath), 'utf8')).resolves.toBe('good');
  });
});

describe('imported task file listing', () => {
  it('permanently ignores an incomplete staging file left by a crashed import', async () => {
    const { workspacePath } = await fixture();
    const inbox = join(workspacePath, 'task-1', 'inbox');
    const staging = join(inbox, '.import-staging');
    await mkdir(staging, { recursive: true });
    await writeFile(join(staging, '.import-deadbeef.partial'), 'never published');
    await writeFile(join(inbox, 'visible.txt'), 'published');

    expect(listImportedTaskFiles(workspacePath, 'task-1').map((item) => item.fileName)).toEqual(['visible.txt']);
  });

  it('garbage-collects expired crash residue while retaining recent partials', async () => {
    const { workspacePath } = await fixture();
    const staging = join(workspacePath, 'task-1', 'inbox', '.import-staging');
    await mkdir(staging, { recursive: true });
    const expired = join(staging, '.import-deadbeef.partial');
    const recent = join(staging, '.import-feedface.partial');
    await writeFile(expired, 'expired');
    await writeFile(recent, 'recent');
    const old = new Date('2020-01-01T00:00:00Z');
    await utimes(expired, old, old);

    await __testing.collectStagingGarbage({ workspacePath, taskId: 'task-1' });

    expect(await readdir(staging)).toEqual(['.import-feedface.partial']);
  });

  it('bounds repeated near-limit crash residue by total bytes', async () => {
    const { workspacePath } = await fixture();
    const staging = join(workspacePath, 'task-1', 'inbox', '.import-staging');
    await mkdir(staging, { recursive: true });
    for (const name of ['.import-aaaa.partial', '.import-bbbb.partial', '.import-cccc.partial']) {
      const partial = join(staging, name);
      await writeFile(partial, 'x');
      await truncate(partial, 90 * 1024 * 1024);
    }

    await __testing.collectStagingGarbage({ workspacePath, taskId: 'task-1' });

    const survivors = await readdir(staging);
    const totalBytes = (
      await Promise.all(survivors.map(async (name) => (await lstat(join(staging, name))).size))
    ).reduce((sum, size) => sum + size, 0);
    expect(totalBytes).toBeLessThanOrEqual(200 * 1024 * 1024);
    expect(survivors.length).toBeLessThan(3);
  });

  it('fails closed without deleting an external file when staging changes before garbage collection', async () => {
    const { root, workspacePath } = await fixture();
    const staging = join(workspacePath, 'task-1', 'inbox', '.import-staging');
    const heldStaging = join(root, 'held-staging');
    const external = join(root, 'external-staging');
    const name = '.import-deadbeef.partial';
    await mkdir(staging, { recursive: true });
    await mkdir(external);
    await writeFile(join(staging, name), 'expired');
    const old = new Date('2020-01-01T00:00:00Z');
    await utimes(join(staging, name), old, old);

    await expect(
      __testing.collectStagingGarbage(
        { workspacePath, taskId: 'task-1' },
        {
          beforeDelete: async () => {
            await rename(staging, heldStaging);
            symlinkSync(external, staging, 'junction');
            await writeFile(join(external, name), 'keep');
          },
        },
      ),
    ).rejects.toBeInstanceOf(ImportIntegrityError);
    await expect(readFile(join(external, name), 'utf8')).resolves.toBe('keep');
  });

  it('returns only supported regular inbox files in stable newest-first order', async () => {
    const { workspacePath } = await fixture();
    const inbox = join(workspacePath, 'task-1', 'inbox');
    await mkdir(join(inbox, 'folder'), { recursive: true });
    await writeFile(join(inbox, 'older.txt'), 'old');
    await writeFile(join(inbox, 'newer.pdf'), 'new');
    await writeFile(join(inbox, 'same-a.csv'), 'a');
    await writeFile(join(inbox, 'same-b.json'), 'b');
    await writeFile(join(inbox, '.partial.txt'), 'hidden');
    await writeFile(join(inbox, '~$draft.docx'), 'temporary');
    await writeFile(join(inbox, 'archive.zip'), 'unsupported');
    await writeFile(join(inbox, 'legacy.doc'), 'legacy');
    await writeFile(join(inbox, 'animation.gif'), 'gif');
    const older = new Date('2025-01-01T00:00:00Z');
    const newer = new Date('2025-01-03T00:00:00Z');
    const same = new Date('2025-01-02T00:00:00Z');
    await utimes(join(inbox, 'older.txt'), older, older);
    await utimes(join(inbox, 'newer.pdf'), newer, newer);
    await utimes(join(inbox, 'same-a.csv'), same, same);
    await utimes(join(inbox, 'same-b.json'), same, same);

    const result = listImportedTaskFiles(workspacePath, 'task-1');

    expect(result.map((item) => item.fileName)).toEqual([
      'legacy.doc',
      'newer.pdf',
      'same-a.csv',
      'same-b.json',
      'older.txt',
    ]);
    expect(result.map((item) => item.localPath)).toEqual([
      'task-1/inbox/legacy.doc',
      'task-1/inbox/newer.pdf',
      'task-1/inbox/same-a.csv',
      'task-1/inbox/same-b.json',
      'task-1/inbox/older.txt',
    ]);
    expect(result.map((item) => item.mimeType)).toEqual([
      'application/msword',
      'application/pdf',
      'text/csv',
      'application/json',
      'text/plain',
    ]);
  });

  it('bounds results, excludes oversized files, and uses code-point tie ordering', async () => {
    const { workspacePath } = await fixture();
    const inbox = join(workspacePath, 'task-1', 'inbox');
    await mkdir(inbox, { recursive: true });
    await Promise.all(Array.from({ length: 101 }, (_, index) => writeFile(join(inbox, `item-${index}.txt`), 'x')));
    await writeFile(join(inbox, 'Z-tie.txt'), 'z');
    await writeFile(join(inbox, 'a-tie.txt'), 'a');
    await writeFile(join(inbox, 'oversized.pdf'), 'x');
    await truncate(join(inbox, 'oversized.pdf'), 100 * 1024 * 1024 + 1);
    const same = new Date('2030-01-01T00:00:00Z');
    await utimes(join(inbox, 'Z-tie.txt'), same, same);
    await utimes(join(inbox, 'a-tie.txt'), same, same);

    const result = listImportedTaskFiles(workspacePath, 'task-1');

    expect(result).toHaveLength(100);
    expect(result.some((item) => item.fileName === 'oversized.pdf')).toBe(false);
    expect(result.slice(0, 2).map((item) => item.fileName)).toEqual(['Z-tie.txt', 'a-tie.txt']);
  });

  it('does not accept an escaping task id as a scan path', async () => {
    const { workspacePath } = await fixture();
    expect(() => listImportedTaskFiles(workspacePath, '..')).toThrow(/taskId/);
  });

  it('closes the directory handle when incremental listing fails', async () => {
    const { workspacePath } = await fixture();
    const inbox = join(workspacePath, 'task-1', 'inbox');
    await mkdir(inbox, { recursive: true });
    directoryReadFailures.add(resolve(inbox));

    expect(() => listImportedTaskFiles(workspacePath, 'task-1')).toThrow(/simulated directory read failure/);
    expect(directoryCloseCounts.get(resolve(inbox))).toBe(1);
  });
});
