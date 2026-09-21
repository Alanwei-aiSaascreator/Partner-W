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
import {
  resolvePortableTransactionPaths,
  type PortableUpdateStateStore,
  type PortableUpdateTransactionV1,
} from './portable-state.js';

const PERMANENT_ERROR_CODES: readonly PortableUpdateErrorCode[] = [
  'signature-invalid',
  'manifest-invalid',
  'unsupported-policy',
  'launcher-incompatible',
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
  launcherVersion: string;
  publicKeyBase64: string;
  stateStore: PortableUpdateStateStore;
  fetchManifest: () => Promise<unknown>;
  fetchFileManifest: (manifest: PortableUpdateManifestV1) => Promise<unknown>;
  downloadPackage: (input: {
    url: string;
    destinationPart: string;
    expectedSize: number;
    expectedSha256: string;
    signal: AbortSignal;
    onProgress: (transferred: number, total: number) => void;
  }) => Promise<void>;
  extractPackage: (input: {
    archivePath: string;
    temporaryRoot: string;
    fileManifest: PortableUpdateFileManifestV1;
  }) => Promise<{ programRoot: string }>;
  verifyTree: (input: { programRoot: string; fileManifest: PortableUpdateFileManifestV1 }) => Promise<void>;
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
      const fileManifest = await loadFileManifest(current);

      publish('extracting', { targetVersion: current.version });
      const extracted = await deps.extractPackage({
        archivePath: paths.archivePath,
        temporaryRoot: dirname(paths.stagedProgramPath),
        fileManifest,
      });

      publish('verifying-files', { targetVersion: current.version });
      await deps.verifyTree({ programRoot: extracted.programRoot, fileManifest });

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
      publish('error', { errorCode: code });
      return { ok: false, errorCode: code };
    } finally {
      abortController = null;
    }
  }

  async function check(): Promise<PortableUpdatePublicState> {
    permanentError = null;
    publish('checking');
    try {
      const raw = await deps.fetchManifest();
      const decision = verifyAndDecidePortableUpdate({
        rawManifest: raw,
        publicKeyBase64: deps.publicKeyBase64,
        currentVersion: deps.currentVersion,
        currentChannel: deps.channel,
        launcherVersion: deps.launcherVersion,
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
      if (PERMANENT_ERROR_CODES.includes(code)) permanentError = code;
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
