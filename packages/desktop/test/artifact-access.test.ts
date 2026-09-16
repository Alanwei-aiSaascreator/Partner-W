import { link, mkdtemp, mkdir, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { __testing, copyArtifactToDestination, inspectArtifactFile } from '../src/main/artifact/access.js';

const roots: string[] = [];

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mofang-artifact-access-'));
  roots.push(root);
  await mkdir(join(root, 'task-1'), { recursive: true });
  return root;
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('artifact file access', () => {
  it('distinguishes available, missing, and unsafe files', async () => {
    const root = await workspace();
    await writeFile(join(root, 'task-1', 'report.txt'), 'trusted');

    await expect(inspectArtifactFile(root, 'task-1/report.txt')).resolves.toMatchObject({
      availability: 'available',
    });
    await expect(inspectArtifactFile(root, 'task-1/missing.txt')).resolves.toEqual({
      availability: 'missing',
    });
    await expect(inspectArtifactFile(root, '../outside.txt')).resolves.toEqual({ availability: 'unsafe' });
  });

  it.runIf(process.platform !== 'win32')('rejects a symlink even when it points inside the workspace', async () => {
    const root = await workspace();
    await writeFile(join(root, 'task-1', 'real.txt'), 'trusted');
    await symlink(join(root, 'task-1', 'real.txt'), join(root, 'task-1', 'alias.txt'));

    await expect(inspectArtifactFile(root, 'task-1/alias.txt')).resolves.toEqual({ availability: 'unsafe' });
  });

  it('copies an available artifact without changing the source', async () => {
    const root = await workspace();
    const source = join(root, 'task-1', 'report.txt');
    const destination = join(root, 'exported.txt');
    await writeFile(source, 'final result');

    await expect(copyArtifactToDestination(root, 'task-1/report.txt', destination)).resolves.toEqual({
      status: 'saved',
      filePath: destination,
    });
    await expect(readFile(destination, 'utf8')).resolves.toBe('final result');
    await expect(readFile(source, 'utf8')).resolves.toBe('final result');
  });

  it('atomically replaces an existing destination after the save dialog has confirmed overwrite', async () => {
    const root = await workspace();
    const destination = join(root, 'exported.txt');
    await writeFile(join(root, 'task-1', 'report.txt'), 'new result');
    await writeFile(destination, 'old result');

    await expect(copyArtifactToDestination(root, 'task-1/report.txt', destination)).resolves.toEqual({
      status: 'saved',
      filePath: destination,
    });
    await expect(readFile(destination, 'utf8')).resolves.toBe('new result');
  });

  it('rejects missing, unsafe, and directory sources', async () => {
    const root = await workspace();
    const destination = join(root, 'exported.txt');

    await expect(copyArtifactToDestination(root, 'task-1/missing.txt', destination)).rejects.toThrow(
      'artifact missing',
    );
    await expect(copyArtifactToDestination(root, '../outside.txt', destination)).rejects.toThrow('artifact unsafe');
    await expect(copyArtifactToDestination(root, 'task-1', destination)).rejects.toThrow('artifact unsafe');
  });

  it('reports a destination failure and keeps the source intact', async () => {
    const root = await workspace();
    const source = join(root, 'task-1', 'report.txt');
    await writeFile(source, 'final result');

    await expect(
      copyArtifactToDestination(root, 'task-1/report.txt', join(root, 'missing', 'out.txt')),
    ).rejects.toThrow();
    await expect(readFile(source, 'utf8')).resolves.toBe('final result');
  });

  it('keeps an existing destination intact and removes only its temp file when writing fails', async () => {
    const root = await workspace();
    const source = join(root, 'task-1', 'report.txt');
    const destination = join(root, 'exported.txt');
    await writeFile(source, 'new result');
    await writeFile(destination, 'keep me');

    await expect(
      __testing.copyArtifactToDestination(root, 'task-1/report.txt', destination, {
        writeChunk: async () => {
          throw new Error('disk full');
        },
      }),
    ).rejects.toThrow('disk full');

    await expect(readFile(destination, 'utf8')).resolves.toBe('keep me');
    expect((await readdir(root)).filter((name) => name.includes('.mofang-'))).toEqual([]);
  });

  it('rejects a destination hard-linked to the source without changing either name', async () => {
    const root = await workspace();
    const source = join(root, 'task-1', 'report.txt');
    const destination = join(root, 'hardlink.txt');
    await writeFile(source, 'do not truncate');
    await link(source, destination);

    await expect(copyArtifactToDestination(root, 'task-1/report.txt', destination)).rejects.toThrow(
      'destination matches source',
    );
    await expect(readFile(source, 'utf8')).resolves.toBe('do not truncate');
    await expect(readFile(destination, 'utf8')).resolves.toBe('do not truncate');
  });

  it('preserves an existing destination when atomic publication fails', async () => {
    const root = await workspace();
    const destination = join(root, 'exported.txt');
    await writeFile(join(root, 'task-1', 'report.txt'), 'new result');
    await writeFile(destination, 'old result');

    await expect(
      __testing.copyArtifactToDestination(root, 'task-1/report.txt', destination, {
        publish: async () => {
          const error = new Error('replace unavailable') as NodeJS.ErrnoException;
          error.code = 'EPERM';
          throw error;
        },
      }),
    ).rejects.toThrow('Could not replace the selected file safely');
    await expect(readFile(destination, 'utf8')).resolves.toBe('old result');
    expect((await readdir(root)).filter((name) => name.includes('.mofang-'))).toEqual([]);
  });

  it('detects a source path swap after opening for copy and never publishes it', async () => {
    const root = await workspace();
    const source = join(root, 'task-1', 'report.txt');
    const moved = join(root, 'task-1', 'original.txt');
    const destination = join(root, 'exported.txt');
    await writeFile(source, 'trusted');

    await expect(
      __testing.copyArtifactToDestination(root, 'task-1/report.txt', destination, {
        afterSourceOpen: async () => {
          await rename(source, moved);
          await writeFile(source, 'replacement');
        },
      }),
    ).rejects.toThrow('artifact changed while reading');
    await expect(readFile(destination, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('detects a source path swap while reading through the verified handle', async () => {
    const root = await workspace();
    const source = join(root, 'task-1', 'report.txt');
    const moved = join(root, 'task-1', 'original.txt');
    await writeFile(source, 'trusted');

    await expect(
      __testing.readVerifiedArtifactFile(root, 'task-1/report.txt', {
        afterSourceOpen: async () => {
          await rename(source, moved);
          await writeFile(source, 'replacement');
        },
      }),
    ).rejects.toThrow('artifact changed while reading');
  });
});
