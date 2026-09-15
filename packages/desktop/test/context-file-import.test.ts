import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, truncate, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { importTaskFiles, listImportedTaskFiles } from '../src/main/context/file-import.js';

const copyFailurePaths = vi.hoisted(() => new Set<string>());

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    copyFile: async (...args: Parameters<typeof actual.copyFile>) => {
      if (copyFailurePaths.has(String(args[0]))) throw new Error('simulated copy failure');
      return actual.copyFile(...args);
    },
  };
});

const roots: string[] = [];

async function fixture(): Promise<{ root: string; workspacePath: string; sources: string }> {
  const root = await mkdtemp(join(tmpdir(), 'clawwork-file-import-'));
  roots.push(root);
  const workspacePath = join(root, 'workspace');
  const sources = join(root, 'sources');
  await mkdir(sources, { recursive: true });
  return { root, workspacePath, sources };
}

afterEach(async () => {
  vi.restoreAllMocks();
  copyFailurePaths.clear();
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
      await expect(readFile(join(workspacePath, item.localPath))).resolves.toBeDefined();
    }
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
    await expect(importTaskFiles({ workspacePath, taskId: '..', sourcePaths: [source] })).rejects.toThrow(/escapes/);
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
    copyFailurePaths.add(copyFailure);

    const result = await importTaskFiles({
      workspacePath,
      taskId: 'task-1',
      sourcePaths: [unsupported, oversized, missing, linked, copyFailure, good],
    });

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
    const older = new Date('2025-01-01T00:00:00Z');
    const newer = new Date('2025-01-03T00:00:00Z');
    const same = new Date('2025-01-02T00:00:00Z');
    await utimes(join(inbox, 'older.txt'), older, older);
    await utimes(join(inbox, 'newer.pdf'), newer, newer);
    await utimes(join(inbox, 'same-a.csv'), same, same);
    await utimes(join(inbox, 'same-b.json'), same, same);

    const result = listImportedTaskFiles(workspacePath, 'task-1');

    expect(result.map((item) => item.fileName)).toEqual(['newer.pdf', 'same-a.csv', 'same-b.json', 'older.txt']);
    expect(result.map((item) => item.localPath)).toEqual([
      'task-1/inbox/newer.pdf',
      'task-1/inbox/same-a.csv',
      'task-1/inbox/same-b.json',
      'task-1/inbox/older.txt',
    ]);
    expect(result.map((item) => item.mimeType)).toEqual([
      'application/pdf',
      'text/csv',
      'application/json',
      'text/plain',
    ]);
  });

  it('does not accept an escaping task id as a scan path', async () => {
    const { workspacePath } = await fixture();
    expect(() => listImportedTaskFiles(workspacePath, '..')).toThrow(/escapes/);
  });
});
