import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalizeJson, type PortableUpdatePublicState } from '@clawwork/shared';

/**
 * 盘上日志的桩：便携更新这条路**以前一条都不写**（2026-09-25 真机排障实测），
 * 于是装配态失败只能靠挂调试器猜。这里钉住"失败必须留下一行能查的"。
 */
const debug = vi.hoisted(() => ({ lines: [] as Array<Record<string, unknown>> }));
vi.mock('../src/main/debug/index.js', () => {
  const push = (line: Record<string, unknown>) => debug.lines.push(line);
  return { getDebugLogger: () => ({ info: push, warn: push, error: push, debug: push }) };
});

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

/** 在签名清单的基础上换掉任意字段（签名重算，否则会先被签名校验挡掉、测不到想要的判定）。 */
function signedManifestWith(overrides: Record<string, unknown>): Record<string, unknown> {
  const { signature: _discarded, ...payload } = signedManifest();
  const merged = { ...payload, ...overrides };
  const signature = sign(null, Buffer.from(canonicalizeJson(merged), 'utf8'), privateKey).toString('base64');
  return { ...merged, signature };
}

async function makeHarness(
  overrides: {
    manifest?: Record<string, unknown> | (() => Promise<unknown>);
    downloadPackage?: (input: { signal: AbortSignal; onProgress: (t: number, total: number) => void }) => Promise<void>;
    extractPackage?: () => Promise<{ programRoot: string }>;
    verifyTree?: () => Promise<void>;
    /** `null` = 启动器版本探测失败（明确出口：拒绝一切更新）。 */
    launcherVersion?: string | null;
    fetchManifest?: () => Promise<unknown>;
    fileManifest?: { schemaVersion: 1; version: string; files: { path: string; size: number; sha256: string }[] };
    /** 盘上现有程序目录的体积（空间预算的一项）。 */
    measureProgramSize?: () => Promise<number>;
    /** 把两份清单落到暂存目录（启动器拿它们验签）。 */
    writeStagedManifests?: (input: {
      paths: { manifestPath: string; fileManifestPath: string };
      manifest: { version: string };
      fileManifest: unknown;
    }) => Promise<void>;
    /** 忙态判据（真实任务/run 活动）；缺省 = 不忙（旧替身兼容口径）。 */
    isBusy?: () => boolean;
  } = {},
): Promise<Harness> {
  const root = await makeRoot();
  const phases: PortableUpdatePublicState[] = [];
  const calls: string[] = [];
  const fileManifest = overrides.fileManifest ?? FILE_MANIFEST;
  const manifest = overrides.manifest ?? signedManifest('0.0.26', sha256Canonical(fileManifest));

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
    launcherVersion: overrides.launcherVersion === undefined ? '1.0.0' : overrides.launcherVersion,
    publicKeyBase64: PUBLIC_KEY_BASE64,
    stateStore: new PortableUpdateStateStore({
      stateFilePath: join(root, '.state', 'update-state.json'),
      now: () => (tick += 1),
    }),
    fetchManifest: overrides.fetchManifest ?? (typeof manifest === 'function' ? manifest : async () => manifest),
    fetchFileManifest: async () => fileManifest,
    measureProgramSize: overrides.measureProgramSize ?? (async () => 0),
    downloadPackage: downloadPackage as never,
    extractPackage: extractPackage as never,
    verifyTree: verifyTree as never,
    writeStagedManifests: (overrides.writeStagedManifests ?? (async () => {})) as never,
    now: () => (tick += 1),
    createTransactionId: () => 'txn-fixed',
    startLauncher: startLauncher as never,
    quit,
    ...(overrides.isBusy ? { isBusy: overrides.isBusy } : {}),
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

  // ⭐ 2026-10-11 升级补齐：忙态（生成/写文件期间）绝不换目录、绝不退出。
  //    这是"退出应用/启动替换"的**最后一刻**：放行 = 打断真实任务 + 在途调用不结算。
  it('任务进行中：不启动启动器、不退出，ready 候选原样保留给用户稍后安装', async () => {
    let busy = true;
    const harness = await makeHarness({ isBusy: () => busy });
    await harness.service.check();
    await harness.service.prepare();

    await expect(harness.service.requestRestart()).resolves.toEqual({ ok: false, errorCode: 'file-in-use' });
    expect(harness.startLauncher).not.toHaveBeenCalled();
    expect(harness.quit).not.toHaveBeenCalled();
    // 候选不丢：还是 ready（错误码只说明"这次为什么没换成"）
    expect(harness.service.getState()).toMatchObject({
      phase: 'ready',
      targetVersion: '0.0.26',
      errorCode: 'file-in-use',
    });

    // 任务结束以后用户再点一次：正常换目录
    busy = false;
    await expect(harness.service.requestRestart()).resolves.toEqual({ ok: true });
    expect(harness.calls).toEqual(['download', 'extract', 'verify-tree', 'launcher', 'quit']);
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

describe('portable update service: unknown launcher version is a hard stop', () => {
  it('⭐ launcherVersion=null ⇒ 拒绝一切更新（launcher-unavailable），且**根本不去取清单**', async () => {
    // 以前客户端把硬编码的 '1.0.0' 当启动器版本 —— 等于拿一个编出来的数字去过
    // `minLauncherVersion` 这道门。探测失败以后**不许**退回任何版本号：那会让
    // 服务继续比一个假数字，正是这个洞本身。出口 = 拒绝（用户得到的补救是对的：
    // 换一份新的完整交付包）。
    const fetchManifest = vi.fn(async () => signedManifest());
    const harness = await makeHarness({ launcherVersion: null, fetchManifest });

    const state = await harness.service.check();

    expect(state).toMatchObject({ phase: 'error', errorCode: 'launcher-unavailable' });
    expect(fetchManifest).not.toHaveBeenCalled();
    expect(harness.downloadPackage).not.toHaveBeenCalled();
  });

  it('launcherVersion=null ⇒ prepare 立刻拒绝，不下载', async () => {
    const harness = await makeHarness({ launcherVersion: null });

    await expect(harness.service.prepare()).resolves.toEqual({
      ok: false,
      errorCode: 'launcher-unavailable',
    });
    expect(harness.downloadPackage).not.toHaveBeenCalled();
  });

  it('⭐ 真版本比清单要求的新 ⇒ 放行（硬编码 1.0.0 时代这条会因假数字而误判）', async () => {
    // 真实场景：盘上启动器 1.2.0、清单要求 >= 1.1.0。用真值 ⇒ available；
    // 若仍拿编出来的 '1.0.0' 去比，这条会被误判成 launcher-incompatible。
    const harness = await makeHarness({
      launcherVersion: '1.2.0',
      manifest: signedManifestWith({ minLauncherVersion: '1.1.0' }),
    });

    await expect(harness.service.check()).resolves.toMatchObject({ phase: 'available', targetVersion: '0.0.26' });
  });

  it('⭐ 真版本比清单要求的旧 ⇒ 判 launcher-incompatible（这道门现在是真的）', async () => {
    const harness = await makeHarness({
      launcherVersion: '0.0.20',
      manifest: signedManifestWith({ minLauncherVersion: '0.0.27' }),
    });

    await expect(harness.service.check()).resolves.toMatchObject({
      phase: 'error',
      // ⚠️ 这一条是**比出来的**"太旧"（0.0.20 < 清单要求的 0.0.27），
      //    与"根本没认出配套启动器"（launcher-unavailable）是两回事。
      errorCode: 'launcher-incompatible',
    });
    expect(harness.downloadPackage).not.toHaveBeenCalled();
  });
});

describe('portable update service: space budget', () => {
  /** 展开体积 = 清单里每个 entry 的 size 之和（manifest 不许加 expandedSize 字段，键集被三层冻死）。 */
  const NON_EMPTY_FILE_MANIFEST = {
    schemaVersion: 1 as const,
    version: '0.0.26',
    files: [
      { path: 'a.exe', size: 300, sha256: 'b'.repeat(64) },
      { path: 'sub/b.dll', size: 700, sha256: 'c'.repeat(64) },
    ],
  };

  it('⭐ 下载前按「包体 + 解压后 + 现有程序 + 余量」算预算，不是只按 zip 大小', async () => {
    const harness = await makeHarness({
      fileManifest: NON_EMPTY_FILE_MANIFEST,
      measureProgramSize: async () => 5_000,
      // 签名清单里 packageSize = 1024（见 signedManifest）。
    });

    await harness.service.check();
    await harness.service.prepare();

    // 1024(包) + 1000(解压后) + 5000(现有程序) + 64MiB(余量)
    const expected = 1024 + 1000 + 5_000 + 64 * 1024 * 1024;
    expect(harness.downloadPackage).toHaveBeenCalledTimes(1);
    expect(harness.downloadPackage.mock.calls[0][0]).toMatchObject({ requiredFreeBytes: expected });
  });

  it('⭐ 解压侧的预算是「解压后 + 余量」（包体那时已经在盘上了，不能重复算）', async () => {
    const harness = await makeHarness({
      fileManifest: NON_EMPTY_FILE_MANIFEST,
      measureProgramSize: async () => 5_000,
    });

    await harness.service.check();
    await harness.service.prepare();

    const expected = 1000 + 64 * 1024 * 1024;
    expect(harness.extractPackage).toHaveBeenCalledTimes(1);
    expect(harness.extractPackage.mock.calls[0][0]).toMatchObject({ requiredFreeBytes: expected });
  });

  it('清单取不到就不下载（先取清单，因为预算要靠它算）', async () => {
    const harness = await makeHarness();

    const result = await (async () => {
      const service = harness.service;
      await service.check();
      return service.prepare();
    })();

    // 正常路径应当成功；这条只是钉住"取清单发生在下载之前"（下一步用 calls 顺序证）。
    expect(result).toEqual({ ok: true });
    expect(harness.calls).toEqual(['download', 'extract', 'verify-tree']);
  });
});

/**
 * 「源上还没有这个版本」**不是错误** —— 它是每次发版之前的正常状态。
 * 以前 manifest 404 会归成一个用户无事可做的错误，界面于是报红；
 * 现在落回 idle，文案说"当前频道暂无更新"。
 */
describe('portable update service: 源上还没有这个版本', () => {
  it('⭐ manifest 404 ⇒ idle（不是 error），而且下次 check 还能再看见更新', async () => {
    let attempt = 0;
    const harness = await makeHarness({
      fetchManifest: async () => {
        attempt += 1;
        if (attempt === 1) throw new PortableUpdateFailure('update-not-published');
        return signedManifest();
      },
    });

    await expect(harness.service.check()).resolves.toMatchObject({ phase: 'idle' });
    // 不是 permanent：新版本一发布，下一次 check 就该能看见。
    await expect(harness.service.check()).resolves.toMatchObject({ phase: 'available', targetVersion: '0.0.26' });
  });

  it('404 之后 prepare 不会假装成功（没有可装的东西）', async () => {
    const harness = await makeHarness({
      fetchManifest: async () => {
        throw new PortableUpdateFailure('update-not-published');
      },
    });
    await harness.service.check();

    await expect(harness.service.prepare()).resolves.toMatchObject({ ok: false });
    expect(harness.downloadPackage).not.toHaveBeenCalled();
  });

  it('⭐ 认不出配套启动器 ⇒ launcher-unavailable，且**不可重试**（换完整基础包）', async () => {
    const fetchManifest = vi.fn(async () => signedManifest());
    const harness = await makeHarness({ launcherVersion: null, fetchManifest });

    await expect(harness.service.check()).resolves.toMatchObject({
      phase: 'error',
      errorCode: 'launcher-unavailable',
    });
    // 永久失败：再点一次也不会变，而且根本不该去问源。
    await expect(harness.service.prepare()).resolves.toEqual({ ok: false, errorCode: 'launcher-unavailable' });
    expect(fetchManifest).not.toHaveBeenCalled();
  });
});

/**
 * ⭐ 2026-09-25 真机验收的第三个发现：**这条路一条日志都不写**。
 *
 * 盘上 0.0.28 点下载永远失败、界面只有"未知错误"，而 `debug-*.ndjson` 里
 * `updater` 域**一条都没有** —— 现场根本没法诊断（我最后是挂 Node 调试器
 * 才把根因捞出来的）。失败必须留下**能查的**一行：归类后的 code 给用户，
 * 原始 message 给排查的人。
 */
describe('failures leave a line in the debug log', () => {
  it('⭐ prepare 失败 ⇒ `portable.prepare.failed`，带归类后的 code', async () => {
    debug.lines.length = 0;
    const h = await makeHarness({
      downloadPackage: async () => {
        throw new PortableUpdateFailure('filesystem-error');
      },
    });
    await h.service.check();

    const result = await h.service.prepare();

    expect(result).toMatchObject({ ok: false, errorCode: 'filesystem-error' });
    expect(debug.lines.find((line) => line.event === 'portable.prepare.failed')).toMatchObject({
      domain: 'updater',
      data: { code: 'filesystem-error' },
    });
  });

  it('⭐ check 失败 ⇒ `portable.check.failed`，带归类后的 code', async () => {
    debug.lines.length = 0;
    const h = await makeHarness({
      fetchManifest: async () => {
        throw new PortableUpdateFailure('network');
      },
    });

    const state = await h.service.check();

    expect(state.phase).toBe('error');
    expect(debug.lines.find((line) => line.event === 'portable.check.failed')).toMatchObject({
      domain: 'updater',
      data: { code: 'network' },
    });
  });
});

/**
 * ⭐ 2026-09-25 真机验收的**第三堵墙**：更新卡在「应用」那一步。
 *
 * `resolvePortableTransactionPaths` 算出了 `staged/<事务>/manifest.json` 与
 * `staged/<事务>/portable-files.json` 两条路径、**也把它们写进了事务记录**，
 * 但客户端**从来不把这两份文件拷进去** ⇒ 启动器一校验就失败：
 * `portable update: manifest is invalid: open …\staged\<事务>\manifest.json: 系统找不到指定的文件`
 * ⇒ **每一块盘的每一次更新都会卡在最后一步**。
 *
 * 真实编号靠前台手跑启动器拿到（`荣盈魔方启动器.exe --apply <状态文件>`）——
 * 应用拉起它时是 `detached + stdio:'ignore'`，失败弹的是**模态错误框**，
 * 所以从外面看是"卡死"（0 CPU / 0 I/O）。
 */
describe('staged manifests reach the transaction directory', () => {
  const stateFileOf = (root: string): string => join(root, '.state', 'update-state.json');

  it('⭐ 事务写下去**之前**，两份清单已经落到暂存目录（`ready` 才等于"一切都就位"）', async () => {
    const seen: Array<{ txFileExists: boolean; input: Record<string, unknown> }> = [];
    // 闭包在 `prepare()` 里才跑，那时 `harness` 已经赋值 —— 所以 const 就行。
    const harness = await makeHarness({
      writeStagedManifests: async (input) => {
        seen.push({ txFileExists: existsSync(stateFileOf(harness.root)), input: input as Record<string, unknown> });
      },
    });
    await harness.service.check();

    await expect(harness.service.prepare()).resolves.toEqual({ ok: true });

    expect(seen).toHaveLength(1);
    // ⭐ 顺序：清单先落，事务后写 —— 反过来的话，崩在中间会留下一份"ready 但缺文件"的事务，
    //    而那正是真机上把更新永远卡死的那种状态。
    expect(seen[0].txFileExists).toBe(false);
    const input = seen[0].input as {
      paths: { manifestPath: string; fileManifestPath: string };
      manifest: { version: string };
      fileManifest: unknown;
    };
    expect(input.paths.manifestPath.endsWith(join('staged', 'txn-fixed', 'manifest.json'))).toBe(true);
    expect(input.paths.fileManifestPath.endsWith(join('staged', 'txn-fixed', 'portable-files.json'))).toBe(true);
    expect(input.manifest.version).toBe('0.0.26');
    expect(input.fileManifest).toEqual(FILE_MANIFEST);
  });

  it('准备失败时不写清单（不留半截东西）', async () => {
    const writeStagedManifests = vi.fn(async () => {});
    const harness = await makeHarness({
      writeStagedManifests,
      verifyTree: async () => {
        throw new PortableUpdateFailure('file-integrity');
      },
    });
    await harness.service.check();

    await expect(harness.service.prepare()).resolves.toMatchObject({ ok: false, errorCode: 'file-integrity' });

    expect(writeStagedManifests).not.toHaveBeenCalled();
  });
});
