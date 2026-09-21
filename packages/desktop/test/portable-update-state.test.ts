import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PORTABLE_PROGRAM_DIRECTORY_NAME,
  PORTABLE_UPDATE_DIRECTORY_NAME,
  PortableUpdateStateError,
  PortableUpdateStateStore,
  assertPortableTransactionPaths,
  recoverPortablePrepare,
  resolvePortableTransactionPaths,
  type PortableUpdateTransactionV1,
} from '../src/main/update/portable-state.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mofang-portable-state-'));
  roots.push(root);
  return root;
}

function resolvePaths(root: string, transactionId = 'txn-1') {
  return resolvePortableTransactionPaths({ root, transactionId });
}

function makeTransaction(root: string, transactionId = 'txn-1'): PortableUpdateTransactionV1 {
  const paths = resolvePaths(root, transactionId);
  return {
    schemaVersion: 1,
    transactionId,
    phase: 'downloading',
    currentVersion: '0.0.25',
    targetVersion: '0.0.26',
    channel: 'internal',
    ...paths,
    updatedAt: 1,
  };
}

function makeStore(root: string, now?: () => number): PortableUpdateStateStore {
  return new PortableUpdateStateStore({
    stateFilePath: join(root, PORTABLE_UPDATE_DIRECTORY_NAME, 'update-state.json'),
    ...(now === undefined ? {} : { now }),
  });
}

async function writeTree(root: string, tree: Record<string, string>): Promise<void> {
  for (const [relativePath, content] of Object.entries(tree)) {
    const target = join(root, relativePath);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, content);
  }
}

describe('portable update layout', () => {
  it('keeps the on-disk directory names the launcher and delivery audit depend on', () => {
    expect(PORTABLE_PROGRAM_DIRECTORY_NAME).toBe('\u8363\u76c8\u9b54\u65b9');
    expect(PORTABLE_UPDATE_DIRECTORY_NAME).toBe('.\u8363\u76c8\u9b54\u65b9\u66f4\u65b0');
  });

  it('derives every transaction path from the root and the transaction id', () => {
    const root = 'R:\\';
    const paths = resolvePaths(root, 'txn-abc');

    expect(paths.currentProgramPath).toBe(join(root, PORTABLE_PROGRAM_DIRECTORY_NAME));
    expect(paths.updateRoot).toBe(join(root, PORTABLE_UPDATE_DIRECTORY_NAME));
    expect(paths.archivePath).toBe(join(paths.updateRoot, 'download', 'txn-abc', 'package.zip'));
    expect(paths.stagedProgramPath).toBe(join(paths.updateRoot, 'staged', 'txn-abc', 'program'));
    expect(paths.backupProgramPath).toBe(join(paths.updateRoot, 'backup', 'txn-abc'));
    expect(paths.healthPath).toBe(join(paths.updateRoot, 'staged', 'txn-abc', 'health.json'));
    expect(paths.manifestPath).toBe(join(paths.updateRoot, 'staged', 'txn-abc', 'manifest.json'));
    expect(paths.fileManifestPath).toBe(join(paths.updateRoot, 'staged', 'txn-abc', 'portable-files.json'));
  });

  it('rejects a transaction id that could escape its transaction directory', () => {
    const root = 'R:\\';
    for (const transactionId of ['', '..', 'a/b', 'a\\b', '.hidden']) {
      expect(() => resolvePaths(root, transactionId)).toThrow(PortableUpdateStateError);
    }
  });

  it('accepts a transaction whose paths all live on one volume outside the protected siblings', async () => {
    const root = await makeRoot();
    const transaction = makeTransaction(root);
    expect(() => assertPortableTransactionPaths(transaction)).not.toThrow();
  });

  it('rejects a transaction whose paths straddle two volumes', () => {
    const root = 'R:\\';
    const transaction = makeTransaction(root);
    const volumeOf = (target: string): string => (target.startsWith('R:\\') ? 'R:' : 'S:');

    expect(() => assertPortableTransactionPaths({ ...transaction, volumeOf })).not.toThrow();
    expect(() =>
      assertPortableTransactionPaths({
        ...transaction,
        backupProgramPath: 'S:\\elsewhere\\backup',
        volumeOf,
      }),
    ).toThrow(PortableUpdateStateError);
  });

  it('rejects a transaction that points at the protected data or workspace directories', async () => {
    const root = await makeRoot();
    const transaction = makeTransaction(root);

    expect(() =>
      assertPortableTransactionPaths({
        ...transaction,
        stagedProgramPath: join(root, '\u8363\u76c8\u9b54\u65b9-\u8fd0\u884c\u6570\u636e', 'staged'),
      }),
    ).toThrow(PortableUpdateStateError);
    expect(() =>
      assertPortableTransactionPaths({
        ...transaction,
        currentProgramPath: join(root, '\u8363\u76c8\u9b54\u65b9\u5de5\u4f5c\u533a'),
      }),
    ).toThrow(PortableUpdateStateError);
  });

  it('requires the staged, archive and backup paths to stay inside the update root', async () => {
    const root = await makeRoot();
    const transaction = makeTransaction(root);

    expect(() => assertPortableTransactionPaths({ ...transaction, archivePath: join(root, 'package.zip') })).toThrow(
      PortableUpdateStateError,
    );
    expect(() => assertPortableTransactionPaths({ ...transaction, stagedProgramPath: join(root, 'staged') })).toThrow(
      PortableUpdateStateError,
    );
  });
});

describe('portable update state store', () => {
  it('reports no transaction when the state file is absent', async () => {
    const root = await makeRoot();
    await expect(makeStore(root).read()).resolves.toBeNull();
  });

  it('writes atomically and leaves no temporary file behind', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    const transaction = makeTransaction(root);

    await store.write(transaction);

    const directory = join(root, PORTABLE_UPDATE_DIRECTORY_NAME);
    const entries = await readdir(directory);
    expect(entries).toEqual(['update-state.json']);
    await expect(store.read()).resolves.toMatchObject({ transactionId: 'txn-1', phase: 'downloading' });
  });

  it('keeps updatedAt strictly increasing even when the clock does not', async () => {
    const root = await makeRoot();
    const ticks = [5000, 4000, 4000];
    let index = 0;
    const store = makeStore(root, () => ticks[Math.min(index++, ticks.length - 1)] ?? 0);
    const transaction = makeTransaction(root);

    const first = await store.write(transaction);
    const second = await store.write({ ...transaction, phase: 'extracting' });

    expect(first.updatedAt).toBe(5000);
    expect(second.updatedAt).toBeGreaterThan(first.updatedAt);
    await expect(store.read()).resolves.toMatchObject({ updatedAt: second.updatedAt, phase: 'extracting' });
  });

  it('quarantines corrupt JSON instead of treating it as a transaction', async () => {
    const root = await makeRoot();
    const directory = join(root, PORTABLE_UPDATE_DIRECTORY_NAME);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'update-state.json'), '{ not json');

    const store = makeStore(root);
    await expect(store.read()).resolves.toBeNull();
    const entries = await readdir(directory);
    expect(entries).toContain('update-state.json.corrupt');
  });

  it('ignores and quarantines a state file whose schema or paths are unusable', async () => {
    const root = await makeRoot();
    const directory = join(root, PORTABLE_UPDATE_DIRECTORY_NAME);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'update-state.json'),
      JSON.stringify({ schemaVersion: 99, transactionId: 'txn-1' }),
    );

    await expect(makeStore(root).read()).resolves.toBeNull();
    await expect(readdir(directory)).resolves.toContain('update-state.json.corrupt');
  });

  it('refuses to persist a transaction that failed layout validation', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    const transaction = makeTransaction(root);

    await expect(
      store.write({ ...transaction, currentProgramPath: join(root, 'somewhere-else') }),
    ).rejects.toBeInstanceOf(PortableUpdateStateError);
    await expect(store.read()).resolves.toBeNull();
  });

  it('cleans only the transaction it owns and never the update root', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    const transaction = makeTransaction(root);
    await store.write(transaction);

    await writeTree(root, {
      [join(PORTABLE_UPDATE_DIRECTORY_NAME, 'staged', 'txn-1', 'program', 'app.txt')]: 'mine',
      [join(PORTABLE_UPDATE_DIRECTORY_NAME, 'download', 'txn-1', 'package.zip')]: 'mine',
      [join(PORTABLE_UPDATE_DIRECTORY_NAME, 'staged', 'txn-2', 'program', 'app.txt')]: 'other',
      [join(PORTABLE_UPDATE_DIRECTORY_NAME, 'logs', 'launcher.log')]: 'keep',
      '\u8363\u76c8\u9b54\u65b9-\u8fd0\u884c\u6570\u636e/keep.bin': 'keep',
    });

    await store.discard(transaction);

    const updateRoot = join(root, PORTABLE_UPDATE_DIRECTORY_NAME);
    await expect(stat(join(updateRoot, 'staged', 'txn-1'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(updateRoot, 'download', 'txn-1'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(updateRoot, 'staged', 'txn-2', 'program', 'app.txt'))).resolves.toBeDefined();
    await expect(stat(join(updateRoot, 'logs', 'launcher.log'))).resolves.toBeDefined();
    await expect(
      stat(join(root, '\u8363\u76c8\u9b54\u65b9-\u8fd0\u884c\u6570\u636e', 'keep.bin')),
    ).resolves.toBeDefined();
    await expect(store.read()).resolves.toBeNull();
  });

  it('refuses to discard a transaction whose paths were not validated', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    const transaction = makeTransaction(root);
    await writeTree(root, {
      [join(PORTABLE_UPDATE_DIRECTORY_NAME, 'staged', 'txn-1', 'program', 'app.txt')]: 'mine',
    });

    await expect(
      store.discard({ ...transaction, stagedProgramPath: join(root, PORTABLE_UPDATE_DIRECTORY_NAME, 'staged') }),
    ).rejects.toBeInstanceOf(PortableUpdateStateError);
    await expect(
      stat(join(root, PORTABLE_UPDATE_DIRECTORY_NAME, 'staged', 'txn-1', 'program', 'app.txt')),
    ).resolves.toBeDefined();
  });
});

describe('portable prepare recovery', () => {
  it('discards a stale prepare transaction and clears the state file', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    const transaction = { ...makeTransaction(root), phase: 'extracting' as const };
    await store.write(transaction);
    await writeTree(root, {
      [join(PORTABLE_UPDATE_DIRECTORY_NAME, 'staged', 'txn-1', 'program', 'half.txt')]: 'partial',
    });

    await recoverPortablePrepare({ store, transaction });

    await expect(store.read()).resolves.toBeNull();
    await expect(stat(join(root, PORTABLE_UPDATE_DIRECTORY_NAME, 'staged', 'txn-1'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('leaves a ready transaction alone so the launcher can still apply it', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    const transaction = { ...makeTransaction(root), phase: 'ready' as const };
    await store.write(transaction);
    await writeTree(root, {
      [join(PORTABLE_UPDATE_DIRECTORY_NAME, 'staged', 'txn-1', 'program', 'app.txt')]: 'staged',
    });

    await recoverPortablePrepare({ store, transaction });

    await expect(store.read()).resolves.toMatchObject({ phase: 'ready' });
    await expect(
      stat(join(root, PORTABLE_UPDATE_DIRECTORY_NAME, 'staged', 'txn-1', 'program', 'app.txt')),
    ).resolves.toBeDefined();
  });

  it('is idempotent when the stale stage directories are already gone', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    const transaction = { ...makeTransaction(root), phase: 'downloading' as const };
    await store.write(transaction);

    await recoverPortablePrepare({ store, transaction });
    await recoverPortablePrepare({ store, transaction });
    await recoverPortablePrepare({ store, transaction });

    await expect(store.read()).resolves.toBeNull();
  });
});

describe('portable state redaction', () => {
  it('never persists a public state carrying paths, urls or signature material', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    const transaction = makeTransaction(root);
    await store.write(transaction);

    const raw = await readFile(join(root, PORTABLE_UPDATE_DIRECTORY_NAME, 'update-state.json'), 'utf8');
    expect(JSON.parse(raw)).toMatchObject({ transactionId: 'txn-1' });
    expect(raw).not.toContain('signature');
  });
});
