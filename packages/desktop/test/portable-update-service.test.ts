import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalizeJson, type PortableUpdatePublicState } from '@clawwork/shared';
import { PortableUpdateFailure } from '../src/main/update/portable-manifest.js';
import { PortableUpdateStateStore } from '../src/main/update/portable-state.js';
import { createPortableUpdateService } from '../src/main/update/portable-update-service.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mofang-portable-service-'));
  roots.push(root);
  return root;
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const PUBLIC_KEY_BASE64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

const FILE_MANIFEST = { schemaVersion: 1, version: '0.0.26', files: [] } as const;

function sha256Canonical(value: unknown): string {
  return createHash('sha256').update(canonicalizeJson(value), 'utf8').digest('hex');
}

function signedManifest(
  version = '0.0.26',
  fileManifestSha256 = sha256Canonical(FILE_MANIFEST),
): Record<string, unknown> {
  const payload = {
    schemaVersion: 1,
    channel: 'internal',
    version,
    minLauncherVersion: '1.0.0',
    packageUrl: `https://api.rongyinghudong.com/updates/internal/${version}/portable.zip`,
    packageSize: 1024,
    packageSha256: 'a'.repeat(64),
    fileManifestSha256,
    publishedAt: '2026-09-21T00:00:00.000Z',
    mandatory: false,
  };
  const signature = sign(null, Buffer.from(canonicalizeJson(payload), 'utf8'), privateKey).toString('base64');
  return { ...payload, signature };
}

interface Harness {
  root: string;
  service: ReturnType<typeof createPortableUpdateService>;
  phases: PortableUpdatePublicState[];
  calls: string[];
  downloadPackage: ReturnType<typeof vi.fn>;
  extractPackage: ReturnType<typeof vi.fn>;
  verifyTree: ReturnType<typeof vi.fn>;
  startLauncher: ReturnType<typeof vi.fn>;
  quit: ReturnType<typeof vi.fn>;
}

async function makeHarness(
  overrides: {
    manifest?: Record<string, unknown> | (() => Promise<unknown>);
    downloadPackage?: (input: { signal: AbortSignal; onProgress: (t: number, total: number) => void }) => Promise<void>;
    extractPackage?: () => Promise<{ programRoot: string }>;
    verifyTree?: () => Promise<void>;
  } = {},
): Promise<Harness> {
  const root = await makeRoot();
  const phases: PortableUpdatePublicState[] = [];
  const calls: string[] = [];
  const manifest = overrides.manifest ?? signedManifest();

  const downloadPackage = vi.fn(
    overrides.downloadPackage ??
      (async (input: { onProgress: (t: number, total: number) => void }) => {
        calls.push('download');
        input.onProgress(512, 1024);
        input.onProgress(1024, 1024);
      }),
  );
  const extractPackage = vi.fn(
    overrides.extractPackage ??
      (async () => {
        calls.push('extract');
        return { programRoot: join(root, 'staged', 'program') };
      }),
  );
  const verifyTree = vi.fn(
    overrides.verifyTree ??
      (async () => {
        calls.push('verify-tree');
      }),
  );
  const startLauncher = vi.fn(async () => {
    calls.push('launcher');
  });
  const quit = vi.fn(() => {
    calls.push('quit');
  });

  let tick = 1000;
  const service = createPortableUpdateService({
    root,
    currentVersion: '0.0.25',
    channel: 'internal',
    launcherVersion: '1.0.0',
    publicKeyBase64: PUBLIC_KEY_BASE64,
    stateStore: new PortableUpdateStateStore({
      stateFilePath: join(root, '.state', 'update-state.json'),
      now: () => (tick += 1),
    }),
    fetchManifest: typeof manifest === 'function' ? manifest : async () => manifest,
    fetchFileManifest: async () => FILE_MANIFEST,
    downloadPackage: downloadPackage as never,
    extractPackage: extractPackage as never,
    verifyTree: verifyTree as never,
    now: () => (tick += 1),
    createTransactionId: () => 'txn-fixed',
    startLauncher: startLauncher as never,
    quit,
  });
  service.subscribe((state) => phases.push(state));
  return { root, service, phases, calls, downloadPackage, extractPackage, verifyTree, startLauncher, quit };
}

describe('portable update service check', () => {
  it('reports available for a newer signed manifest without starting a download', async () => {
    const harness = await makeHarness();

    const state = await harness.service.check();

    expect(state).toMatchObject({ phase: 'available', currentVersion: '0.0.25', targetVersion: '0.0.26' });
    expect(harness.downloadPackage).not.toHaveBeenCalled();
    expect(harness.calls).not.toContain('download');
  });

  it('stays idle when the signed manifest is not newer', async () => {
    const harness = await makeHarness({ manifest: signedManifest('0.0.25') });
    await expect(harness.service.check()).resolves.toMatchObject({ phase: 'idle' });
    expect(harness.downloadPackage).not.toHaveBeenCalled();
  });

  it('refuses a manifest with a broken signature and never retries it', async () => {
    const broken = { ...signedManifest(), packageSize: 2048 };
    const harness = await makeHarness({ manifest: broken });

    await expect(harness.service.check()).resolves.toMatchObject({
      phase: 'error',
      errorCode: 'signature-invalid',
    });
    await expect(harness.service.prepare()).resolves.toEqual({ ok: false, errorCode: 'signature-invalid' });
    expect(harness.downloadPackage).not.toHaveBeenCalled();
  });

  it('reports a network failure on check and succeeds on the next attempt', async () => {
    let attempt = 0;
    const harness = await makeHarness({
      manifest: async () => {
        attempt += 1;
        if (attempt === 1) throw new PortableUpdateFailure('network');
        return signedManifest();
      },
    });

    await expect(harness.service.check()).resolves.toMatchObject({ phase: 'error', errorCode: 'network' });
    await expect(harness.service.check()).resolves.toMatchObject({ phase: 'available' });
  });
});

describe('portable update service prepare', () => {
  it('refuses to prepare before the caller asked for it', async () => {
    const harness = await makeHarness();
    await harness.service.check();

    expect(harness.downloadPackage).not.toHaveBeenCalled();
    expect(harness.extractPackage).not.toHaveBeenCalled();
    expect(harness.verifyTree).not.toHaveBeenCalled();
  });

  it('runs download, extraction and tree verification in order and only then reports ready', async () => {
    const harness = await makeHarness();
    await harness.service.check();

    await expect(harness.service.prepare()).resolves.toEqual({ ok: true });

    expect(harness.calls).toEqual(['download', 'extract', 'verify-tree']);
    expect(harness.service.getState()).toMatchObject({ phase: 'ready', targetVersion: '0.0.26' });
    const readyIndex = harness.phases.findIndex((phase) => phase.phase === 'ready');
    expect(readyIndex).toBeGreaterThan(-1);
    expect(harness.phases.slice(0, readyIndex).map((state) => state.phase)).toEqual(
      expect.arrayContaining(['downloading', 'verifying-archive', 'extracting', 'verifying-files']),
    );
  });

  it('reports download progress as transferred and total bytes', async () => {
    const harness = await makeHarness();
    await harness.service.check();
    await harness.service.prepare();

    const downloading = harness.phases.filter((state) => state.phase === 'downloading');
    expect(downloading.length).toBeGreaterThan(0);
    expect(downloading.at(-1)).toMatchObject({ transferred: 1024, total: 1024, percent: 100 });
  });

  it('never reports ready when the exact tree verification fails', async () => {
    const harness = await makeHarness({
      verifyTree: async () => {
        harness.calls.push('verify-tree');
        throw new PortableUpdateFailure('file-integrity');
      },
    });
    await harness.service.check();

    await expect(harness.service.prepare()).resolves.toEqual({ ok: false, errorCode: 'file-integrity' });
    expect(harness.phases.some((state) => state.phase === 'ready')).toBe(false);
    expect(harness.service.getState()).toMatchObject({ phase: 'error', errorCode: 'file-integrity' });
  });

  it('never reports ready when the archive verification fails', async () => {
    const harness = await makeHarness({
      extractPackage: async () => {
        harness.calls.push('extract');
        throw new PortableUpdateFailure('archive-unsafe');
      },
    });
    await harness.service.check();

    await expect(harness.service.prepare()).resolves.toEqual({ ok: false, errorCode: 'archive-unsafe' });
    expect(harness.verifyTree).not.toHaveBeenCalled();
    expect(harness.phases.some((state) => state.phase === 'ready')).toBe(false);
  });

  it('deduplicates concurrent prepare calls into one download', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = await makeHarness({
      downloadPackage: async (input) => {
        harness.calls.push('download');
        await gate;
        input.onProgress(1024, 1024);
      },
    });
    await harness.service.check();

    const first = harness.service.prepare();
    const second = harness.service.prepare();
    release?.();
    const results = await Promise.all([first, second]);

    expect(results).toEqual([{ ok: true }, { ok: true }]);
    expect(harness.downloadPackage).toHaveBeenCalledTimes(1);
  });

  it('allows a retry after a failed download', async () => {
    let attempt = 0;
    const harness = await makeHarness({
      downloadPackage: async (input) => {
        attempt += 1;
        harness.calls.push('download');
        if (attempt === 1) throw new PortableUpdateFailure('network');
        input.onProgress(1024, 1024);
      },
    });
    await harness.service.check();

    await expect(harness.service.prepare()).resolves.toEqual({ ok: false, errorCode: 'network' });
    await expect(harness.service.prepare()).resolves.toEqual({ ok: true });
    expect(harness.downloadPackage).toHaveBeenCalledTimes(2);
  });
});

describe('portable update service cancel and restart', () => {
  it('cancels an in-flight download and returns to a retryable state', async () => {
    let abortObserved = false;
    const harness = await makeHarness({
      downloadPackage: (input) =>
        new Promise((_resolve, reject) => {
          input.signal.addEventListener('abort', () => {
            abortObserved = true;
            reject(new PortableUpdateFailure('cancelled'));
          });
        }),
    });
    await harness.service.check();
    const pending = harness.service.prepare();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.service.cancel()).toEqual({ ok: true });
    await expect(pending).resolves.toEqual({ ok: false, errorCode: 'cancelled' });

    expect(abortObserved).toBe(true);
    expect(harness.service.getState().phase).not.toBe('ready');
  });

  it('refuses a restart request unless the transaction is ready', async () => {
    const harness = await makeHarness();
    await harness.service.check();

    await expect(harness.service.requestRestart()).resolves.toEqual({
      ok: false,
      errorCode: 'manifest-invalid',
    });
    expect(harness.startLauncher).not.toHaveBeenCalled();
    expect(harness.quit).not.toHaveBeenCalled();
  });

  it('hands a ready transaction to the launcher and only then quits', async () => {
    const harness = await makeHarness();
    await harness.service.check();
    await harness.service.prepare();

    await expect(harness.service.requestRestart()).resolves.toEqual({ ok: true });

    expect(harness.calls).toEqual(['download', 'extract', 'verify-tree', 'launcher', 'quit']);
    expect(harness.startLauncher).toHaveBeenCalledWith(expect.stringContaining(join('.state', 'update-state.json')));
  });

  it('does not quit when the launcher cannot be started', async () => {
    const harness = await makeHarness();
    harness.startLauncher.mockRejectedValueOnce(new PortableUpdateFailure('launcher-start-failed'));
    await harness.service.check();
    await harness.service.prepare();

    await expect(harness.service.requestRestart()).resolves.toEqual({
      ok: false,
      errorCode: 'launcher-start-failed',
    });
    expect(harness.quit).not.toHaveBeenCalled();
  });
});

describe('portable update service public state', () => {
  it('publishes only redacted fields to subscribers', async () => {
    const harness = await makeHarness();
    await harness.service.check();
    await harness.service.prepare();

    for (const state of harness.phases) {
      for (const key of Object.keys(state)) {
        expect(key).not.toMatch(/token|password|key|path|url|signature/i);
      }
    }
  });
});
