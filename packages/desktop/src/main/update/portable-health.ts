import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { PORTABLE_PROGRAM_DIRECTORY_NAME } from './portable-state.js';

export const PORTABLE_TRANSACTION_ID_ENV = 'PARTNERW_PORTABLE_TRANSACTION_ID';
export const PORTABLE_HEALTH_PATH_ENV = 'PARTNERW_PORTABLE_HEALTH_PATH';

export interface PortableHealthReceiptV1 {
  schemaVersion: 1;
  transactionId: string;
  version: string;
  programPath: string;
  healthyAt: string;
}

export interface PortableHealthCoordinator {
  markMainReady(): void;
  markDatabaseReady(): void;
  markWindowReady(): void;
  markRendererReady(): void;
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string =>
    resolve(value)
      .replace(/[/\\]+$/, '')
      .toLowerCase();
  return normalize(left) === normalize(right);
}

export function readPortableHealthEnvironment(env: Record<string, string | undefined>): {
  transactionId?: string;
  healthPath?: string;
} {
  const transactionId = env[PORTABLE_TRANSACTION_ID_ENV];
  const healthPath = env[PORTABLE_HEALTH_PATH_ENV];
  return {
    ...(transactionId ? { transactionId } : {}),
    ...(healthPath ? { healthPath } : {}),
  };
}

export function expectedProgramPathFor(healthPath: string | undefined): string | undefined {
  if (healthPath === undefined) return undefined;
  return join(dirname(dirname(dirname(healthPath))), PORTABLE_PROGRAM_DIRECTORY_NAME);
}

export async function writePortableHealthReceipt(input: {
  healthPath: string;
  receipt: PortableHealthReceiptV1;
}): Promise<void> {
  await mkdir(dirname(input.healthPath), { recursive: true });
  const temporaryPath = `${input.healthPath}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(input.receipt), 'utf8');
  await rename(temporaryPath, input.healthPath);
}

export function createPortableHealthCoordinator(input: {
  transactionId?: string;
  healthPath?: string;
  expectedProgramPath?: string;
  runningProgramPath: string;
  runningVersion: string;
  writeReceipt: (receipt: PortableHealthReceiptV1) => Promise<void>;
  now?: () => Date;
}): PortableHealthCoordinator {
  let mainReady = false;
  let databaseReady = false;
  let windowReady = false;
  let rendererReady = false;
  let written = false;

  function eligible(): boolean {
    return (
      input.transactionId !== undefined &&
      input.healthPath !== undefined &&
      input.expectedProgramPath !== undefined &&
      samePath(input.expectedProgramPath, input.runningProgramPath)
    );
  }

  function confirmIfComplete(): void {
    if (written || !eligible()) return;
    if (!mainReady || !databaseReady || !windowReady || !rendererReady) return;
    const transactionId = input.transactionId as string;
    written = true;
    const now = input.now ?? ((): Date => new Date());
    void input
      .writeReceipt({
        schemaVersion: 1,
        transactionId,
        version: input.runningVersion,
        programPath: input.runningProgramPath,
        healthyAt: now().toISOString(),
      })
      .catch(() => {
        written = false;
      });
  }

  return {
    markMainReady() {
      mainReady = true;
      confirmIfComplete();
    },
    markDatabaseReady() {
      databaseReady = true;
      confirmIfComplete();
    },
    markWindowReady() {
      windowReady = true;
      confirmIfComplete();
    },
    markRendererReady() {
      rendererReady = true;
      confirmIfComplete();
    },
  };
}
