import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PORTABLE_HEALTH_PATH_ENV,
  PORTABLE_TRANSACTION_ID_ENV,
  createPortableHealthCoordinator,
  expectedProgramPathFor,
  readPortableHealthEnvironment,
  writePortableHealthReceipt,
  type PortableHealthReceiptV1,
} from '../src/main/update/portable-health.js';
import { PORTABLE_PROGRAM_DIRECTORY_NAME, PORTABLE_UPDATE_DIRECTORY_NAME } from '../src/main/update/portable-state.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mofang-portable-health-'));
  roots.push(root);
  return root;
}

async function makeCoordinator(
  overrides: Partial<Parameters<typeof createPortableHealthCoordinator>[0]> = {},
): Promise<{ receipts: PortableHealthReceiptV1[]; coordinator: ReturnType<typeof createPortableHealthCoordinator> }> {
  const root = await makeRoot();
  const receipts: PortableHealthReceiptV1[] = [];
  const coordinator = createPortableHealthCoordinator({
    transactionId: 'txn-1',
    healthPath: join(root, 'health', 'txn-1.json'),
    expectedProgramPath: join(root, 'program'),
    runningProgramPath: join(root, 'program'),
    runningVersion: '0.0.26',
    writeReceipt: async (receipt) => {
      receipts.push(receipt);
    },
    ...overrides,
  });
  return { receipts, coordinator };
}

describe('portable health readiness', () => {
  it('writes one receipt only after main, database, window and renderer are all ready', async () => {
    const { receipts, coordinator } = await makeCoordinator();

    coordinator.markMainReady();
    expect(receipts).toHaveLength(0);
    coordinator.markDatabaseReady();
    expect(receipts).toHaveLength(0);
    coordinator.markWindowReady();
    expect(receipts).toHaveLength(0);
    coordinator.markRendererReady();
    await vi.waitFor(() => {
      expect(receipts).toHaveLength(1);
    });

    expect(receipts[0]).toMatchObject({
      schemaVersion: 1,
      transactionId: 'txn-1',
      version: '0.0.26',
    });
    expect(receipts[0]?.programPath.endsWith('program')).toBe(true);
    expect(Number.isFinite(Date.parse(receipts[0]?.healthyAt ?? ''))).toBe(true);
  });

  it.each([
    ['main', ['markDatabaseReady', 'markWindowReady', 'markRendererReady']],
    ['database', ['markMainReady', 'markWindowReady', 'markRendererReady']],
    ['window', ['markMainReady', 'markDatabaseReady', 'markRendererReady']],
    ['renderer', ['markMainReady', 'markDatabaseReady', 'markWindowReady']],
  ])('writes nothing while the %s milestone is missing', async (_name, marks) => {
    const { receipts, coordinator } = await makeCoordinator();

    for (const mark of marks) {
      coordinator[mark as 'markMainReady']();
    }
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(receipts).toHaveLength(0);
  });

  it('writes nothing when the launcher did not hand over a transaction', async () => {
    const { receipts, coordinator } = await makeCoordinator({ transactionId: undefined });

    coordinator.markMainReady();
    coordinator.markDatabaseReady();
    coordinator.markWindowReady();
    coordinator.markRendererReady();
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(receipts).toHaveLength(0);
  });

  it('writes nothing when the launcher did not hand over a receipt path', async () => {
    const { receipts, coordinator } = await makeCoordinator({ healthPath: undefined });

    coordinator.markMainReady();
    coordinator.markDatabaseReady();
    coordinator.markWindowReady();
    coordinator.markRendererReady();
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(receipts).toHaveLength(0);
  });

  it('writes nothing when the running program is not the directory the transaction expects', async () => {
    const root = await makeRoot();
    const { receipts, coordinator } = await makeCoordinator({
      expectedProgramPath: join(root, 'somewhere-else'),
      runningProgramPath: join(root, 'program'),
    });

    coordinator.markMainReady();
    coordinator.markDatabaseReady();
    coordinator.markWindowReady();
    coordinator.markRendererReady();
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(receipts).toHaveLength(0);
  });

  it('writes the receipt exactly once even when the renderer acknowledges twice', async () => {
    const { receipts, coordinator } = await makeCoordinator();

    coordinator.markMainReady();
    coordinator.markDatabaseReady();
    coordinator.markWindowReady();
    coordinator.markRendererReady();
    coordinator.markRendererReady();
    coordinator.markMainReady();
    await vi.waitFor(() => {
      expect(receipts).toHaveLength(1);
    });

    expect(receipts).toHaveLength(1);
  });

  it('does not depend on the gateway, the network or the license state', async () => {
    const { receipts, coordinator } = await makeCoordinator();

    coordinator.markMainReady();
    coordinator.markDatabaseReady();
    coordinator.markWindowReady();
    coordinator.markRendererReady();
    await vi.waitFor(() => {
      expect(receipts).toHaveLength(1);
    });

    expect(Object.keys(receipts[0] ?? {}).sort()).toEqual([
      'healthyAt',
      'programPath',
      'schemaVersion',
      'transactionId',
      'version',
    ]);
  });
});

describe('portable health environment', () => {
  it('reads the transaction handoff the launcher passes', () => {
    expect(
      readPortableHealthEnvironment({
        [PORTABLE_TRANSACTION_ID_ENV]: 'txn-9',
        [PORTABLE_HEALTH_PATH_ENV]: 'D:/health/txn-9.json',
      }),
    ).toEqual({ transactionId: 'txn-9', healthPath: 'D:/health/txn-9.json' });
  });

  it('reports nothing to confirm when the environment is empty', () => {
    expect(readPortableHealthEnvironment({})).toEqual({});
  });

  it('ignores an empty handoff rather than writing a receipt with no identity', () => {
    expect(
      readPortableHealthEnvironment({ [PORTABLE_TRANSACTION_ID_ENV]: '', [PORTABLE_HEALTH_PATH_ENV]: '' }),
    ).toEqual({});
  });
});

describe('portable health receipt writing', () => {
  it('writes the receipt atomically and leaves no temporary file behind', async () => {
    const root = await makeRoot();
    const healthPath = join(root, 'health', 'txn-1.json');
    const receipt: PortableHealthReceiptV1 = {
      schemaVersion: 1,
      transactionId: 'txn-1',
      version: '0.0.26',
      programPath: join(root, 'program'),
      healthyAt: '2026-09-21T00:00:00.000Z',
    };

    await writePortableHealthReceipt({ healthPath, receipt });

    await expect(readdir(dirname(healthPath))).resolves.toEqual(['txn-1.json']);
    await expect(readFile(healthPath, 'utf8')).resolves.toBe(JSON.stringify(receipt));
  });

  it('creates the health directory when the launcher has not', async () => {
    const root = await makeRoot();
    const healthPath = join(root, 'nested', 'health', 'txn-2.json');
    const receipt: PortableHealthReceiptV1 = {
      schemaVersion: 1,
      transactionId: 'txn-2',
      version: '0.0.26',
      programPath: join(root, 'program'),
      healthyAt: '2026-09-21T00:00:00.000Z',
    };

    await writePortableHealthReceipt({ healthPath, receipt });
    await expect(readFile(healthPath, 'utf8')).resolves.toBe(JSON.stringify(receipt));
  });

  it('replaces an earlier receipt from the same transaction instead of appending', async () => {
    const root = await makeRoot();
    const healthPath = join(root, 'health', 'txn-3.json');
    await mkdir(dirname(healthPath), { recursive: true });
    await writeFile(healthPath, 'stale');

    const receipt: PortableHealthReceiptV1 = {
      schemaVersion: 1,
      transactionId: 'txn-3',
      version: '0.0.26',
      programPath: join(root, 'program'),
      healthyAt: '2026-09-21T00:00:00.000Z',
    };
    await writePortableHealthReceipt({ healthPath, receipt });

    await expect(readFile(healthPath, 'utf8')).resolves.toBe(JSON.stringify(receipt));
    await expect(readdir(dirname(healthPath))).resolves.toEqual(['txn-3.json']);
  });
});

describe('portable health path derivation', () => {
  it('derives the program directory the transaction expects from the receipt path', () => {
    const root = join('R:', 'delivery');
    const healthPath = join(root, PORTABLE_UPDATE_DIRECTORY_NAME, 'health', 'txn-1.json');

    expect(expectedProgramPathFor(healthPath)).toBe(join(root, PORTABLE_PROGRAM_DIRECTORY_NAME));
  });

  it('derives nothing when the launcher handed over no receipt path', () => {
    expect(expectedProgramPathFor(undefined)).toBeUndefined();
  });
});
