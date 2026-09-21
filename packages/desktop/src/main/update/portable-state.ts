import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, parse, resolve, sep } from 'node:path';
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

    try {
      assertPortableTransactionPaths(transaction);
    } catch {
      await this.quarantine();
      return null;
    }

    this.lastUpdatedAt = Math.max(this.lastUpdatedAt, transaction.updatedAt);
    return transaction;
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

export async function recoverPortablePrepare(input: {
  store: PortableUpdateStateStore;
  transaction: PortableUpdateTransactionV1;
}): Promise<void> {
  if (!PREPARE_PHASES.includes(input.transaction.phase)) return;
  await input.store.discard(input.transaction);
}
