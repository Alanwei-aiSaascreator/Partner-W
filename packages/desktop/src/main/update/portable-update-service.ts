import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import {
  assertPortableTransition,
  canonicalizeJson,
  parsePortableFileManifest,
  toPortableUpdatePublicState,
  type PortableUpdateChannel,
  type PortableUpdateErrorCode,
  type PortableUpdateFileManifestV1,
  type PortableUpdateManifestV1,
  type PortableUpdatePhase,
  type PortableUpdatePublicState,
} from '@clawwork/shared';
import { PortableUpdateFailure, verifyAndDecidePortableUpdate } from './portable-manifest.js';
import { calculatePortableSpaceBudget, sumExpandedBytes } from './portable-package.js';
import {
  resolvePortableTransactionPaths,
  type PortableUpdateStateStore,
  type PortableUpdateTransactionV1,
} from './portable-state.js';
import { getDebugLogger } from '../debug/index.js';

const PERMANENT_ERROR_CODES: readonly PortableUpdateErrorCode[] = [
  'signature-invalid',
  'manifest-invalid',
  'unsupported-policy',
  'launcher-incompatible',
  // 认不出配套的启动器 ⇒ 这一轮里再点多少次都一样（换完整基础包才是出路）。
  'launcher-unavailable',
];

export type PortableUpdatePrepareResult = { ok: true } | { ok: false; errorCode: PortableUpdateErrorCode };

export interface PortableUpdateService {
  getState(): PortableUpdatePublicState;
  subscribe(listener: (state: PortableUpdatePublicState) => void): () => void;
  check(): Promise<PortableUpdatePublicState>;
  prepare(): Promise<PortableUpdatePrepareResult>;
  cancel(): { ok: true } | { ok: false; errorCode: PortableUpdateErrorCode };
  requestRestart(): Promise<PortableUpdatePrepareResult>;
}

export interface PortableUpdateServiceDeps {
  root: string;
  currentVersion: string;
  channel: PortableUpdateChannel;
  /**
   * 盘上启动器的**真实版本**（`launcher-version.ts` 探测 `--version` 所得）。
   *
   * `null` = 探测失败。此时服务**拒绝一切更新**（`launcher-incompatible`）
   * 并且**不去取清单** —— 绝不退回某个编出来的版本号：那正是
   * "`minLauncherVersion` 是假门"这个洞本身。
   */
  launcherVersion: string | null;
  publicKeyBase64: string;
  stateStore: PortableUpdateStateStore;
  fetchManifest: () => Promise<unknown>;
  fetchFileManifest: (manifest: PortableUpdateManifestV1) => Promise<unknown>;
  downloadPackage: (input: {
    url: string;
    destinationPart: string;
    expectedSize: number;
    expectedSha256: string;
    requiredFreeBytes: number;
    signal: AbortSignal;
    onProgress: (transferred: number, total: number) => void;
  }) => Promise<void>;
  extractPackage: (input: {
    archivePath: string;
    temporaryRoot: string;
    fileManifest: PortableUpdateFileManifestV1;
    requiredFreeBytes: number;
  }) => Promise<{ programRoot: string }>;
  /**
   * 盘上现有程序目录的体积（空间预算的一项）。
   * 注入点：真实实现是走一遍 `<盘根>\荣盈魔方\` 累加文件大小。
   */
  measureProgramSize: () => Promise<number>;
  verifyTree: (input: { programRoot: string; fileManifest: PortableUpdateFileManifestV1 }) => Promise<void>;
  /**
   * 把**已经取到的**两份清单按规范 JSON 落到暂存目录
   * （`staged/<事务>/manifest.json` 与 `portable-files.json`）——
   * 盘上启动器 `Apply` 的第一步就是读它们验签。
   *
   * ⚠️ 少了这一步，事务会指向两个**从不存在的**文件 ⇒ 启动器每次都判 `manifest-invalid`
   * ⇒ **更新永远卡在「应用」**。这就是 2026-09-25 真机验收抓到的第三堵墙：
   * 路径算出来了、也写进事务了，**却从来没人把文件放进去**。
   */
  writeStagedManifests: (input: {
    paths: { manifestPath: string; fileManifestPath: string };
    manifest: PortableUpdateManifestV1;
    fileManifest: PortableUpdateFileManifestV1;
  }) => Promise<void>;
  now: () => number;
  createTransactionId: () => string;
  startLauncher: (stateFilePath: string) => Promise<void>;
  quit: () => void;
}

interface StatePatch {
  targetVersion?: string;
  transferred?: number;
  total?: number;
  percent?: number;
  errorCode?: PortableUpdateErrorCode;
  requiredBytes?: number;
  availableBytes?: number;
}

function toErrorCode(error: unknown): PortableUpdateErrorCode {
  if (error instanceof PortableUpdateFailure) return error.code;
  return 'unknown';
}

export function createPortableUpdateService(deps: PortableUpdateServiceDeps): PortableUpdateService {
  const listeners = new Set<(state: PortableUpdatePublicState) => void>();
  let phase: PortableUpdatePhase = 'idle';
  let targetVersion: string | undefined;
  let transferred: number | undefined;
  let total: number | undefined;
  let percent: number | undefined;
  let errorCode: PortableUpdateErrorCode | undefined;
  let requiredBytes: number | undefined;
  let availableBytes: number | undefined;
  let manifest: PortableUpdateManifestV1 | null = null;
  let permanentError: PortableUpdateErrorCode | null = null;
  let readyTransaction: PortableUpdateTransactionV1 | null = null;
  let pending: Promise<PortableUpdatePrepareResult> | null = null;
  let abortController: AbortController | null = null;

  function getState(): PortableUpdatePublicState {
    return toPortableUpdatePublicState({
      phase,
      currentVersion: deps.currentVersion,
      updatedAt: deps.now(),
      ...(targetVersion === undefined ? {} : { targetVersion }),
      ...(transferred === undefined ? {} : { transferred }),
      ...(total === undefined ? {} : { total }),
      ...(percent === undefined ? {} : { percent }),
      ...(errorCode === undefined ? {} : { errorCode }),
      ...(requiredBytes === undefined ? {} : { requiredBytes }),
      ...(availableBytes === undefined ? {} : { availableBytes }),
    });
  }

  function publish(next: PortableUpdatePhase, patch: StatePatch = {}): void {
    assertPortableTransition(phase, next);
    phase = next;
    targetVersion = patch.targetVersion;
    transferred = patch.transferred;
    total = patch.total;
    percent = patch.percent;
    errorCode = patch.errorCode;
    requiredBytes = patch.requiredBytes;
    availableBytes = patch.availableBytes;
    const state = getState();
    for (const listener of listeners) listener(state);
  }

  async function loadFileManifest(current: PortableUpdateManifestV1): Promise<PortableUpdateFileManifestV1> {
    const raw = await deps.fetchFileManifest(current);
    const digest = createHash('sha256').update(canonicalizeJson(raw), 'utf8').digest('hex');
    if (digest !== current.fileManifestSha256) throw new PortableUpdateFailure('file-integrity');
    return parsePortableFileManifest(raw);
  }

  async function runPrepare(): Promise<PortableUpdatePrepareResult> {
    const current = manifest;
    if (current === null) return { ok: false, errorCode: 'manifest-invalid' };

    const transactionId = deps.createTransactionId();
    const paths = resolvePortableTransactionPaths({ root: deps.root, transactionId });
    const controller = new AbortController();
    abortController = controller;

    try {
      // ⚠️ 文件清单**要提前到下载之前取**：空间预算必须按"解压后"的体积算，而那个体积
      //    只能从这份清单（每个 entry 的 size 之和）得到。顺带好处是清单坏了会在花掉
      //    一次大下载之前就失败。这一步**不发相位**（界面停在 available），
      //    失败时下面统一 `publish('error')`。
      const fileManifest = await loadFileManifest(current);
      const expandedSize = sumExpandedBytes(fileManifest);
      // 现有程序目录的体积：换目录之前它一直占着，必须算进"还需要多少"。
      const currentProgramSize = await deps.measureProgramSize();
      const downloadBudget = await calculatePortableSpaceBudget({
        packageSize: current.packageSize,
        expandedSize,
        currentProgramSize,
      });

      publish('downloading', {
        targetVersion: current.version,
        transferred: 0,
        total: current.packageSize,
        percent: 0,
      });
      await deps.downloadPackage({
        url: current.packageUrl,
        destinationPart: paths.archivePath,
        expectedSize: current.packageSize,
        expectedSha256: current.packageSha256,
        requiredFreeBytes: downloadBudget,
        signal: controller.signal,
        onProgress: (nextTransferred, nextTotal) => {
          publish('downloading', {
            targetVersion: current.version,
            transferred: nextTransferred,
            total: nextTotal,
            percent: nextTotal === 0 ? 0 : Math.round((nextTransferred / nextTotal) * 100),
          });
        },
      });

      publish('verifying-archive', { targetVersion: current.version });

      // 解压那一刻：包已经在盘上占着，现有程序目录也还在 —— 只需要**额外**的展开体积 + 余量。
      const extractBudget = await calculatePortableSpaceBudget({
        packageSize: 0,
        expandedSize,
        currentProgramSize: 0,
      });

      publish('extracting', { targetVersion: current.version });
      const extracted = await deps.extractPackage({
        archivePath: paths.archivePath,
        temporaryRoot: dirname(paths.stagedProgramPath),
        fileManifest,
        requiredFreeBytes: extractBudget,
      });

      publish('verifying-files', { targetVersion: current.version });
      await deps.verifyTree({ programRoot: extracted.programRoot, fileManifest });

      // ⚠️ **必须在写事务之前**：事务一旦落成 `ready`，就代表"**一切都就位**"，
      //    而启动器 `Apply` 的第一步正是读 `staged/<事务>/` 下这两份清单验签。
      //    反过来写的话，崩在中间会留下一份 `ready` 但缺清单的事务 ——
      //    那正是真机上把更新永远卡在「应用」的那种状态。
      await deps.writeStagedManifests({ paths, manifest: current, fileManifest });

      readyTransaction = await deps.stateStore.write({
        schemaVersion: 1,
        transactionId,
        phase: 'ready',
        currentVersion: deps.currentVersion,
        targetVersion: current.version,
        channel: current.channel,
        ...paths,
        updatedAt: 0,
      });
      publish('ready', { targetVersion: current.version });
      return { ok: true };
    } catch (error) {
      const code = toErrorCode(error);
      if (PERMANENT_ERROR_CODES.includes(code)) permanentError = code;
      // ⚠️ 这条路**以前一个字都不写**（2026-09-25 真机排障实测：盘上日志里 `updater` 域
      //    0 条），于是装配态失败只能靠挂调试器猜。失败必须留下**能查的**一行：
      //    归类后的 code 给用户，原始 message 给排查的人。
      getDebugLogger().warn({
        domain: 'updater',
        event: 'portable.prepare.failed',
        message: error instanceof Error ? error.message : String(error),
        data: { code, targetVersion: current.version },
      });
      // 空间类失败带着"还差多少"上来（`PortableUpdateFailure.detail`），
      // 原样放进公开状态，界面才说得出数字。
      const detail = error instanceof PortableUpdateFailure ? error.detail : undefined;
      publish('error', {
        errorCode: code,
        ...(detail?.requiredBytes === undefined ? {} : { requiredBytes: detail.requiredBytes }),
        ...(detail?.availableBytes === undefined ? {} : { availableBytes: detail.availableBytes }),
      });
      return { ok: false, errorCode: code };
    } finally {
      abortController = null;
    }
  }

  async function check(): Promise<PortableUpdatePublicState> {
    permanentError = null;
    publish('checking');

    // ⚠️ 启动器版本探测失败 = **不取清单、直接拒绝**。
    //    以前这里拿的是硬编码的 '1.0.0'，与盘上那个 exe 毫无关系 ⇒
    //    `minLauncherVersion` 那道门从来没真的比过。现在探测不到就不许编一个出来：
    //    宁可拒绝（补救是"换新交付包"，与 launcher-incompatible 的文案一致），
    //    也不拿假版本号放一份**可能装不上**的更新过去。
    const launcherVersion = deps.launcherVersion;
    if (launcherVersion === null) {
      manifest = null;
      // ⚠️ 代码是 `launcher-unavailable` 而**不是** `launcher-incompatible`：
      //    "版本太旧"是比出来的结论，而这里是**根本没认出配套的启动器**
      //    （缺失/不是我们的/只换了客户端留下旧启动器）。两者给用户的补救相同
      //    （换完整基础包），但谎报成"版本太旧"会把人引向错误的排查方向。
      permanentError = 'launcher-unavailable';
      publish('error', { errorCode: 'launcher-unavailable' });
      return getState();
    }

    try {
      const raw = await deps.fetchManifest();
      const decision = verifyAndDecidePortableUpdate({
        rawManifest: raw,
        publicKeyBase64: deps.publicKeyBase64,
        currentVersion: deps.currentVersion,
        currentChannel: deps.channel,
        launcherVersion,
      });
      if (decision.kind === 'available') {
        manifest = decision.manifest;
        publish('available', { targetVersion: decision.manifest.version });
      } else {
        manifest = null;
        publish('idle');
      }
    } catch (error) {
      manifest = null;
      const code = toErrorCode(error);
      // 「源上还没有这个版本」**不是错误**：它是每次发版之前的正常状态
      // （频道 manifest 还没传上去）。以前它被归成 `feed-response` 之类，
      // 界面于是报一个用户无事可做的错误；现在落回 idle，由文案说"当前频道暂无更新"。
      // ⚠️ 也不设 permanentError：新版本一发出来，下一次 check 就该能看见。
      if (code === 'update-not-published') {
        publish('idle');
        return getState();
      }
      if (PERMANENT_ERROR_CODES.includes(code)) permanentError = code;
      // 同 `runPrepare`：失败要留一行能查的（这条路以前完全静默）。
      getDebugLogger().warn({
        domain: 'updater',
        event: 'portable.check.failed',
        message: error instanceof Error ? error.message : String(error),
        data: { code },
      });
      publish('error', { errorCode: code });
    }
    return getState();
  }

  return {
    getState,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    check,
    async prepare() {
      if (permanentError !== null) return { ok: false, errorCode: permanentError };
      if (pending !== null) return pending;
      if (phase === 'ready' && readyTransaction !== null) return { ok: true };
      if (phase !== 'available') {
        await check();
        if (manifest === null) return { ok: false, errorCode: permanentError ?? 'manifest-invalid' };
      }
      const run = runPrepare().finally(() => {
        if (pending === run) pending = null;
      });
      pending = run;
      return run;
    },
    cancel() {
      if (abortController !== null) {
        abortController.abort();
        return { ok: true };
      }
      if (readyTransaction !== null) return { ok: false, errorCode: 'file-in-use' };
      return { ok: true };
    },
    async requestRestart() {
      if (readyTransaction === null) return { ok: false, errorCode: 'manifest-invalid' };
      try {
        await deps.startLauncher(deps.stateStore.stateFilePath);
      } catch (error) {
        const code = toErrorCode(error);
        publish('ready', { targetVersion: readyTransaction.targetVersion, errorCode: code });
        return { ok: false, errorCode: code };
      }
      publish('applying', { targetVersion: readyTransaction.targetVersion });
      deps.quit();
      return { ok: true };
    },
  };
}
