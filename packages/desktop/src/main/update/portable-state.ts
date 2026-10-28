import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import type { PortableUpdateChannel, PortableUpdateErrorCode, PortableUpdatePhase } from '@clawwork/shared';

export const PORTABLE_PROGRAM_DIRECTORY_NAME = '\u8363\u76c8\u9b54\u65b9';
export const PORTABLE_UPDATE_DIRECTORY_NAME = '.\u8363\u76c8\u9b54\u65b9\u66f4\u65b0';
export const PORTABLE_DATA_DIRECTORY_NAME = '\u8363\u76c8\u9b54\u65b9-\u8fd0\u884c\u6570\u636e';
export const PORTABLE_WORKSPACE_DIRECTORY_NAME = '\u8363\u76c8\u9b54\u65b9\u5de5\u4f5c\u533a';
export const PORTABLE_UPDATE_STATE_SCHEMA_VERSION = 1;

const TRANSACTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PREPARE_PHASES: readonly PortableUpdatePhase[] = [
  'downloading',
  'verifying-archive',
  'extracting',
  'verifying-files',
];

export class PortableUpdateStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PortableUpdateStateError';
  }
}

export interface PortableUpdateTransactionPaths {
  updateRoot: string;
  archivePath: string;
  stagedProgramPath: string;
  currentProgramPath: string;
  backupProgramPath: string;
  manifestPath: string;
  fileManifestPath: string;
  healthPath: string;
}

export interface PortableUpdateTransactionV1 extends PortableUpdateTransactionPaths {
  schemaVersion: 1;
  transactionId: string;
  phase: PortableUpdatePhase;
  currentVersion: string;
  targetVersion: string;
  channel: PortableUpdateChannel;
  errorCode?: PortableUpdateErrorCode;
  updatedAt: number;
}

function compareKey(target: string): string {
  return resolve(target)
    .replace(/[/\\]+$/, '')
    .toLowerCase();
}

function isInsideOrEqual(parent: string, child: string): boolean {
  const parentKey = compareKey(parent);
  const childKey = compareKey(child);
  return childKey === parentKey || childKey.startsWith(`${parentKey}${sep}`);
}

function defaultVolumeOf(target: string): string {
  return parse(resolve(target)).root.toLowerCase();
}

export function resolvePortableTransactionPaths(input: {
  root: string;
  transactionId: string;
}): PortableUpdateTransactionPaths {
  if (!TRANSACTION_ID_PATTERN.test(input.transactionId) || input.transactionId.includes('..')) {
    throw new PortableUpdateStateError('invalid transaction id');
  }
  const updateRoot = join(input.root, PORTABLE_UPDATE_DIRECTORY_NAME);
  const stageRoot = join(updateRoot, 'staged', input.transactionId);
  return {
    updateRoot,
    archivePath: join(updateRoot, 'download', input.transactionId, 'package.zip'),
    stagedProgramPath: join(stageRoot, 'program'),
    currentProgramPath: join(input.root, PORTABLE_PROGRAM_DIRECTORY_NAME),
    backupProgramPath: join(updateRoot, 'backup', input.transactionId),
    manifestPath: join(stageRoot, 'manifest.json'),
    fileManifestPath: join(stageRoot, 'portable-files.json'),
    healthPath: join(updateRoot, 'health', `${input.transactionId}.json`),
  };
}

export function assertPortableTransactionPaths(
  input: PortableUpdateTransactionV1 & { volumeOf?: (target: string) => string },
): void {
  if (!TRANSACTION_ID_PATTERN.test(input.transactionId) || input.transactionId.includes('..')) {
    throw new PortableUpdateStateError('invalid transaction id');
  }

  const updateRoot = input.updateRoot;
  const stageRoot = join(updateRoot, 'staged', input.transactionId);
  const expected: ReadonlyArray<readonly [keyof PortableUpdateTransactionPaths, string]> = [
    ['archivePath', join(updateRoot, 'download', input.transactionId, 'package.zip')],
    ['stagedProgramPath', join(stageRoot, 'program')],
    ['backupProgramPath', join(updateRoot, 'backup', input.transactionId)],
    ['manifestPath', join(stageRoot, 'manifest.json')],
    ['fileManifestPath', join(stageRoot, 'portable-files.json')],
    ['healthPath', join(updateRoot, 'health', `${input.transactionId}.json`)],
  ];
  for (const [key, expectedPath] of expected) {
    if (compareKey(input[key]) !== compareKey(expectedPath)) {
      throw new PortableUpdateStateError(`unexpected ${key}`);
    }
  }

  if (basename(input.currentProgramPath) !== PORTABLE_PROGRAM_DIRECTORY_NAME) {
    throw new PortableUpdateStateError('unexpected currentProgramPath');
  }
  if (compareKey(dirname(input.currentProgramPath)) !== compareKey(dirname(updateRoot))) {
    throw new PortableUpdateStateError('currentProgramPath is not a sibling of the update root');
  }

  const root = dirname(updateRoot);
  const protectedTargets = [join(root, PORTABLE_DATA_DIRECTORY_NAME), join(root, PORTABLE_WORKSPACE_DIRECTORY_NAME)];
  const writable: string[] = [
    input.archivePath,
    input.stagedProgramPath,
    input.manifestPath,
    input.fileManifestPath,
    input.healthPath,
  ];
  for (const target of writable) {
    for (const protectedTarget of protectedTargets) {
      if (isInsideOrEqual(protectedTarget, target)) {
        throw new PortableUpdateStateError('transaction path targets a protected directory');
      }
      if (isInsideOrEqual(target, protectedTarget)) {
        throw new PortableUpdateStateError('transaction path contains a protected directory');
      }
    }
  }

  const volumeOf = input.volumeOf ?? defaultVolumeOf;
  const volumes = new Set([updateRoot, ...writable].map((target) => volumeOf(target)));
  if (volumes.size > 1) {
    throw new PortableUpdateStateError('transaction paths straddle more than one volume');
  }
}

/**
 * 把一条**写在别的盘符下**的事务记录挪到当前根（2026-10-19，与启动器的
 * `RebaseTransaction` 同一条纪律）。
 *
 * 为什么应用侧也要做：记录是绝对路径，U 盘今天在 E:、明天在 F: 是产品的正常用法。
 * 读的时候不改写，后续任何"续传/清场"都会拿着 E: 的路径去操作 F: 的盘 —— 失败信息
 * 还会被当成"更新坏了"。启动器那侧已经会在启动时重写；这里保证**应用先于启动器**
 * 读到同一条记录时也不会走错。
 *
 * 判据同样是"只做整体重写"：任何一条路径越出旧根、或程序目录不是旧根的兄弟，
 * 就返回 null（调用方按既有策略隔离这条记录），绝不做半截改写。
 */
export function rebasePortableTransaction(
  transaction: PortableUpdateTransactionV1,
  root: string,
): PortableUpdateTransactionV1 | null {
  // ⚠️ 必须先按**原始值**判绝对：`resolve()` 会把相对路径锚到进程 cwd，
  //    之后再 `isAbsolute` 恒为真 —— 等于把 cwd 当成"这块盘"（2026-10-19 自审）。
  if (!isAbsolute(transaction.updateRoot) || !isAbsolute(root)) return null;
  const recordedRoot = resolve(transaction.updateRoot);
  const currentRoot = resolve(join(root, PORTABLE_UPDATE_DIRECTORY_NAME));
  if (compareKey(recordedRoot) === compareKey(currentRoot)) return transaction;

  const move = (value: string): string | null => {
    const relativePath = relative(recordedRoot, resolve(value));
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) return null;
    return join(currentRoot, relativePath);
  };

  const rebased: PortableUpdateTransactionV1 = {
    ...transaction,
    updateRoot: currentRoot,
    archivePath: '',
    stagedProgramPath: '',
    backupProgramPath: '',
    manifestPath: '',
    fileManifestPath: '',
    healthPath: '',
  };
  for (const key of [
    'archivePath',
    'stagedProgramPath',
    'backupProgramPath',
    'manifestPath',
    'fileManifestPath',
    'healthPath',
  ] as const) {
    const next = move(transaction[key]);
    if (next === null) return null;
    rebased[key] = next;
  }

  if (compareKey(dirname(transaction.currentProgramPath)) !== compareKey(dirname(recordedRoot))) return null;
  rebased.currentProgramPath = join(root, basename(transaction.currentProgramPath));

  try {
    assertPortableTransactionPaths(rebased);
  } catch {
    return null;
  }
  return rebased;
}

function parseTransaction(value: unknown): PortableUpdateTransactionV1 | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== PORTABLE_UPDATE_STATE_SCHEMA_VERSION) return null;
  const stringFields = [
    'transactionId',
    'phase',
    'currentVersion',
    'targetVersion',
    'channel',
    'updateRoot',
    'archivePath',
    'stagedProgramPath',
    'currentProgramPath',
    'backupProgramPath',
    'manifestPath',
    'fileManifestPath',
    'healthPath',
  ];
  for (const field of stringFields) {
    if (typeof record[field] !== 'string') return null;
  }
  if (typeof record.updatedAt !== 'number' || !Number.isFinite(record.updatedAt)) return null;
  if (record.errorCode !== undefined && typeof record.errorCode !== 'string') return null;
  return record as unknown as PortableUpdateTransactionV1;
}

export class PortableUpdateStateStore {
  readonly stateFilePath: string;

  private readonly now: () => number;
  private lastUpdatedAt = 0;

  constructor(input: { stateFilePath: string; now?: () => number }) {
    this.stateFilePath = input.stateFilePath;
    this.now = input.now ?? Date.now;
  }

  async read(): Promise<PortableUpdateTransactionV1 | null> {
    let raw: string;
    try {
      raw = await readFile(this.stateFilePath, 'utf8');
    } catch {
      return null;
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      await this.quarantine();
      return null;
    }

    const transaction = parseTransaction(decoded);
    if (transaction === null) {
      await this.quarantine();
      return null;
    }

    // ⚠️ 记录可能是**另一个盘符**下写的（U 盘换机是正常用法）。先按当前根重写，
    //    重写不了才隔离 —— "换个盘符"不是"记录坏了"。
    const rebased = rebasePortableTransaction(transaction, dirname(dirname(this.stateFilePath)));
    if (rebased === null) {
      await this.quarantine();
      return null;
    }

    try {
      assertPortableTransactionPaths(rebased);
    } catch {
      await this.quarantine();
      return null;
    }

    this.lastUpdatedAt = Math.max(this.lastUpdatedAt, rebased.updatedAt);
    return rebased;
  }

  async write(transaction: PortableUpdateTransactionV1): Promise<PortableUpdateTransactionV1> {
    assertPortableTransactionPaths(transaction);
    const persisted: PortableUpdateTransactionV1 = {
      ...transaction,
      updatedAt: Math.max(this.now(), this.lastUpdatedAt + 1),
    };
    await mkdir(dirname(this.stateFilePath), { recursive: true });
    const temporaryPath = `${this.stateFilePath}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(persisted), 'utf8');
    await rename(temporaryPath, this.stateFilePath);
    this.lastUpdatedAt = persisted.updatedAt;
    return persisted;
  }

  async discard(transaction: PortableUpdateTransactionV1): Promise<void> {
    assertPortableTransactionPaths(transaction);
    await rm(dirname(transaction.archivePath), { recursive: true, force: true });
    await rm(dirname(transaction.stagedProgramPath), { recursive: true, force: true });
    const current = await this.read();
    if (current !== null && current.transactionId === transaction.transactionId) {
      await rm(this.stateFilePath, { force: true });
    }
  }

  private async quarantine(): Promise<void> {
    const corruptPath = `${this.stateFilePath}.corrupt`;
    try {
      await rm(corruptPath, { force: true });
      await rename(this.stateFilePath, corruptPath);
    } catch {
      return;
    }
  }
}

/**
 * 只处理四个 **PREPARE** 相位。`applying` / `awaiting-health` 那一段由启动器自己
 * `Recover`（`launcher/internal/update/swap.go:92`）负责，这里**不能**碰：
 * `ready` 的事务是"已经验完、就等重启换目录"的成果，删掉等于把用户的下载白扔。
 *
 * @returns 真的清掉了才 `true`（相位不在清单里 ⇒ `false`，什么都没动）。
 */
export async function recoverPortablePrepare(input: {
  store: PortableUpdateStateStore;
  transaction: PortableUpdateTransactionV1;
}): Promise<boolean> {
  if (!PREPARE_PHASES.includes(input.transaction.phase)) return false;
  await input.store.discard(input.transaction);
  return true;
}

/** 更新状态文件名（`<盘根>\.Partner-W更新\update-state.json`）。 */
export const PORTABLE_UPDATE_STATE_FILE_NAME = 'update-state.json';

/**
 * 状态文件的**唯一**算法。以前这个拼接在 `ipc/update-handlers.ts` 里又写了一遍 ——
 * 装配服务与启动恢复必须指同一个文件，两处各拼一次迟早会漂。
 */
export function portableUpdateStateFilePath(root: string): string {
  return join(root, PORTABLE_UPDATE_DIRECTORY_NAME, PORTABLE_UPDATE_STATE_FILE_NAME);
}

export type PortablePrepareRecoveryResult =
  | { kind: 'skipped-not-portable' }
  | { kind: 'nothing-to-recover' }
  | { kind: 'discarded'; transactionId: string }
  | { kind: 'failed'; reason: string };

/**
 * 启动时的崩溃恢复：把上一次**在下载/解压中途**死掉留下的垃圾清掉。
 *
 * 为什么需要它（2026-09-23 取证）：`recoverPortablePrepare` **生产零调用** ——
 * 只有它自己的单测引用了它。于是客户端在 PREPARE 阶段被断电/强杀时，
 * `.Partner-W更新/download/<txn>/`（几百 MB 的包）与 `staged/<txn>/`（解压了一半的树）
 * 会**永远留着**：下次更新用的是新的 transactionId，没有任何东西会回收它们。
 *
 * 两条硬约束：
 *  1. **非便携态一律不动手**（`portableRoot === null` ⇒ 直接跳过）。没有"这是不是盘上运行"
 *     的判断依据时，宁可不删 —— 本机共享目录里可能有另一个副本正等着用的东西。
 *  2. **绝不抛**：启动序列不能被它拦住。失败收成 `{ kind: 'failed', reason }`，
 *     由调用方写进调试日志（吞掉，但不静默）。
 */
export async function recoverPortablePrepareAtStartup(input: {
  portableRoot: string | null;
  /** 注入点：单测用来造"清理本身失败"。 */
  storeFactory?: (stateFilePath: string) => PortableUpdateStateStore;
}): Promise<PortablePrepareRecoveryResult> {
  if (input.portableRoot === null) return { kind: 'skipped-not-portable' };

  const stateFilePath = portableUpdateStateFilePath(input.portableRoot);
  const store =
    input.storeFactory === undefined
      ? new PortableUpdateStateStore({ stateFilePath })
      : input.storeFactory(stateFilePath);

  try {
    const transaction = await store.read();
    if (transaction === null) return { kind: 'nothing-to-recover' };
    const discarded = await recoverPortablePrepare({ store, transaction });
    return discarded ? { kind: 'discarded', transactionId: transaction.transactionId } : { kind: 'nothing-to-recover' };
  } catch (error) {
    return { kind: 'failed', reason: (error as Error | null)?.message ?? String(error) };
  }
}
