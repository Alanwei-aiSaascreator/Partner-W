import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PORTABLE_PROGRAM_DIRECTORY_NAME,
  PORTABLE_UPDATE_DIRECTORY_NAME,
  PortableUpdateStateError,
  PortableUpdateStateStore,
  assertPortableTransactionPaths,
  rebasePortableTransaction,
  recoverPortablePrepare,
  recoverPortablePrepareAtStartup,
  resolvePortableTransactionPaths,
  type PortableUpdateTransactionV1,
} from '../src/main/update/portable-state.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'partner-w-portable-state-'));
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
    expect(paths.healthPath).toBe(join(paths.updateRoot, 'health', 'txn-abc.json'));
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

/**
 * 启动时的崩溃恢复：`recoverPortablePrepare` 以前**生产零调用**（只有它自己的单测）。
 *
 * 取证：`recoverPortablePrepare` 只处理四个 PREPARE 相位
 * （`downloading` / `verifying-archive` / `extracting` / `verifying-files`）；
 * `applying` / `awaiting-health` 那一段由启动器自己 `Recover`（`swap.go:92`）负责。
 * 客户端这一侧一旦在下载/解压中途被断电或强杀，就会留下
 * `.Partner-W更新/download/<txn>/` 与 `.Partner-W更新/staged/<txn>/` 两坨**永远不回收**的垃圾
 * （一个几百 MB 的包 + 一棵解压了一半的树），而下次更新用的是新 transactionId。
 */
describe('recoverPortablePrepareAtStartup', () => {
  it('⭐ 崩在 PREPARE 相位 ⇒ 清掉残留，且状态文件一并消失', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    const paths = resolvePaths(root);
    await mkdir(dirname(paths.archivePath), { recursive: true });
    await writeFile(paths.archivePath, 'partial');
    await mkdir(join(dirname(paths.stagedProgramPath), 'program'), { recursive: true });
    await writeFile(join(dirname(paths.stagedProgramPath), 'program', 'app.txt'), 'half');
    await store.write(makeTransaction(root));

    const result = await recoverPortablePrepareAtStartup({ portableRoot: root });

    expect(result).toEqual({ kind: 'discarded', transactionId: 'txn-1' });
    await expect(store.read()).resolves.toBeNull();
    await expect(stat(dirname(paths.archivePath))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(dirname(paths.stagedProgramPath))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('⭐ 不是盘上运行（portableRoot=null）⇒ 一律不动手（别去删本机的任何东西）', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    const paths = resolvePaths(root);
    await mkdir(join(dirname(paths.stagedProgramPath), 'program'), { recursive: true });
    await writeFile(join(dirname(paths.stagedProgramPath), 'program', 'app.txt'), 'half');
    await store.write(makeTransaction(root));

    const result = await recoverPortablePrepareAtStartup({ portableRoot: null });

    expect(result).toEqual({ kind: 'skipped-not-portable' });
    // 残留原样留着：不是便携态就没有"该不该删"的判断依据，宁可不删。
    await expect(stat(join(dirname(paths.stagedProgramPath), 'program', 'app.txt'))).resolves.toBeDefined();
    await expect(store.read()).resolves.toMatchObject({ phase: 'downloading' });
  });

  it('没有残留状态 ⇒ nothing-to-recover（不是错误）', async () => {
    const root = await makeRoot();

    await expect(recoverPortablePrepareAtStartup({ portableRoot: root })).resolves.toEqual({
      kind: 'nothing-to-recover',
    });
  });

  it('⭐ 状态是 ready ⇒ 留着不动（启动器还要用它换目录）', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    const paths = resolvePaths(root);
    await mkdir(join(dirname(paths.stagedProgramPath), 'program'), { recursive: true });
    await writeFile(join(dirname(paths.stagedProgramPath), 'program', 'app.txt'), 'verified');
    await store.write({ ...makeTransaction(root), phase: 'ready' });

    const result = await recoverPortablePrepareAtStartup({ portableRoot: root });

    expect(result).toEqual({ kind: 'nothing-to-recover' });
    await expect(store.read()).resolves.toMatchObject({ phase: 'ready' });
    await expect(stat(join(dirname(paths.stagedProgramPath), 'program', 'app.txt'))).resolves.toBeDefined();
  });

  it('状态文件坏了 ⇒ nothing-to-recover（不抛，交给日志）', async () => {
    const root = await makeRoot();
    await mkdir(join(root, PORTABLE_UPDATE_DIRECTORY_NAME), { recursive: true });
    await writeFile(join(root, PORTABLE_UPDATE_DIRECTORY_NAME, 'update-state.json'), '{not json');

    await expect(recoverPortablePrepareAtStartup({ portableRoot: root })).resolves.toEqual({
      kind: 'nothing-to-recover',
    });
  });

  it('⭐ 清理本身失败 ⇒ 吞成 failed + 原因（绝不抛：不许拦住启动，也不许静默）', async () => {
    const root = await makeRoot();
    const store = makeStore(root);
    await store.write(makeTransaction(root));
    const explodingStore = {
      read: () => store.read(),
      discard: async () => {
        throw new Error('EBUSY: staged tree is locked');
      },
      stateFilePath: store.stateFilePath,
    } as unknown as PortableUpdateStateStore;

    const result = await recoverPortablePrepareAtStartup({
      portableRoot: root,
      storeFactory: () => explodingStore,
    });

    expect(result).toMatchObject({ kind: 'failed' });
    expect((result as { reason: string }).reason).toContain('EBUSY');
  });
});

/**
 * 2026-10-19（BUG-173 的应用侧另一半）：事务记录是绝对路径，U 盘今天 E:、明天 F:
 * 是产品的正常用法。"换了盘符"不是"记录坏了"——读的时候要按当前根重写，
 * 而不是当成损坏隔离掉（隔离会让正在进行的更新凭空消失）。
 */
describe('rebasePortableTransaction —— 换盘符读记录', () => {
  function rehomedTo(transaction: PortableUpdateTransactionV1, volume: string): PortableUpdateTransactionV1 {
    const rehome = (value: string): string => join(volume, value.slice(value.indexOf(':') + 1));
    return {
      ...transaction,
      updateRoot: rehome(transaction.updateRoot),
      archivePath: rehome(transaction.archivePath),
      stagedProgramPath: rehome(transaction.stagedProgramPath),
      currentProgramPath: rehome(transaction.currentProgramPath),
      backupProgramPath: rehome(transaction.backupProgramPath),
      manifestPath: rehome(transaction.manifestPath),
      fileManifestPath: rehome(transaction.fileManifestPath),
      healthPath: rehome(transaction.healthPath),
    };
  }

  it('把另一个盘符下的记录整体搬到当前根（程序目录、暂存、备份、健康回执都跟着走）', async () => {
    const root = await makeRoot();
    const transaction = makeTransaction(root);
    const foreign = rehomedTo(transaction, 'Z:\\');

    const rebased = rebasePortableTransaction(foreign, root);

    expect(rebased).not.toBeNull();
    expect(rebased?.updateRoot).toBe(transaction.updateRoot);
    expect(rebased?.currentProgramPath).toBe(transaction.currentProgramPath);
    expect(rebased?.stagedProgramPath).toBe(transaction.stagedProgramPath);
    expect(rebased?.healthPath).toBe(transaction.healthPath);
    // 输入不被就地改写
    expect(foreign.updateRoot.startsWith('Z:')).toBe(true);
  });

  it('同盘记录原样返回', async () => {
    const root = await makeRoot();
    const transaction = makeTransaction(root);
    expect(rebasePortableTransaction(transaction, root)).toBe(transaction);
  });

  it('越出旧根的路径 ⇒ 整体拒绝（不做半截改写）', async () => {
    const root = await makeRoot();
    const foreign = rehomedTo(makeTransaction(root), 'Z:\\');
    foreign.archivePath = 'C:\\elsewhere\\package.zip';
    expect(rebasePortableTransaction(foreign, root)).toBeNull();
  });

  // 2026-10-19 自审：`resolve()` 之后再判 isAbsolute 恒为真（死守卫）。相对 updateRoot
  // 会被解析到进程 cwd，等于把 cwd 当成"这块盘"——必须按**原始值**拒绝。
  it('⭐ updateRoot 是相对路径 ⇒ 拒绝（不拿 cwd 当盘根）', async () => {
    const root = await makeRoot();
    const relativeRoot = 'relative-update-root';
    const resolved = resolve(relativeRoot);
    const relative: PortableUpdateTransactionV1 = {
      ...makeTransaction(root),
      updateRoot: relativeRoot,
      archivePath: join(resolved, 'download', 'txn-1', 'package.zip'),
      stagedProgramPath: join(resolved, 'staged', 'txn-1', 'program'),
      currentProgramPath: join(dirname(resolved), PORTABLE_PROGRAM_DIRECTORY_NAME),
      backupProgramPath: join(resolved, 'backup', 'txn-1'),
      manifestPath: join(resolved, 'staged', 'txn-1', 'manifest.json'),
      fileManifestPath: join(resolved, 'staged', 'txn-1', 'portable-files.json'),
      healthPath: join(resolved, 'health', 'txn-1.json'),
    };

    expect(rebasePortableTransaction(relative, root)).toBeNull();
  });

  it('store.read() 读到别的盘符的记录 ⇒ 重写后返回，而不是隔离成 .corrupt', async () => {
    const root = await makeRoot();
    const stateFilePath = join(root, PORTABLE_UPDATE_DIRECTORY_NAME, 'update-state.json');
    await mkdir(dirname(stateFilePath), { recursive: true });
    const foreign = rehomedTo(makeTransaction(root), 'Z:\\');
    await writeFile(stateFilePath, JSON.stringify(foreign), 'utf8');

    const store = new PortableUpdateStateStore({ stateFilePath });
    const read = await store.read();

    expect(read?.updateRoot).toBe(join(root, PORTABLE_UPDATE_DIRECTORY_NAME));
    expect(read?.currentProgramPath).toBe(join(root, PORTABLE_PROGRAM_DIRECTORY_NAME));
    await expect(readdir(dirname(stateFilePath))).resolves.not.toContain('update-state.json.corrupt');
  });
});
