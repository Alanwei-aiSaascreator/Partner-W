import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FeedPublishError,
  appendAuditStage,
  assertKnownHostsPath,
  assertOutsideRepositoryPath,
  breakChannelLock,
  buildStableManifestInput,
  parsePublishInput,
  planCommit,
  planTargets,
  runCommit,
  runPreflight,
  verifyLocalArtifacts,
} from './feed-publish.mjs';
export { createFeedTransport } from './feed-publish-transport.mjs';
import {
  assertPathOutsideRepository,
  buildPortableRelease,
  readSigningKeyFile,
  verifyPortableRelease,
} from './portable-update-release.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const USAGE = [
  'Usage: node scripts/feed-publish.mjs <--dry-run|--preflight|--commit|--break-lock|--re-sign-stable> --channel <internal|stable> [--version <x.y.z>] [--host <host> --known-hosts <path>]',
  '  --dry-run          offline: validate the three artifacts and print the plan',
  '  --preflight        read only remote checks; never claims to have verified writability;',
  '                     needs --audit-out, because it records a session level entry',
  '  --commit           publish; needs --package --file-manifest --manifest --audit-out',
  '  --version          required by every mode except --break-lock, whose lock path is keyed by',
  '                     the channel only, so the mode reads no version and echoes none back',
  '  --break-lock       needs --channel --reason --audit-out, plus --confirm-runid; use',
  '                     --owner-record-unreadable (below) when the owner record is unreadable',
  '  --owner-record-unreadable',
  '                     with --break-lock: the lock owner record cannot be read, so there',
  '                     is no runid to confirm; passing this flag is the operator stating',
  '                     that the previous run is not in progress. Refused when the record',
  '                     is readable, where --confirm-runid is required instead',
  '  --re-sign-stable   offline: re-sign the internal release bytes for stable; needs',
  '                     --package --file-manifest --manifest --stable-out, and refuses to',
  '                     overwrite the output; --channel must be stable. This is the only mode',
  '                     that reads the signing key file, so "the uploader never reads the',
  '                     private key" holds per mode: --commit itself still never reads one',
  '  --known-hosts      the pinned known_hosts file, must live outside the repository',
  'Exactly one mode flag may be given; a command line that carries two is refused rather than',
  'resolved by priority, because --dry-run is the safest mode and must never lose to --commit.',
  'Exit codes: 0 the run finished, 1 it refused or failed, 2 no mode flag was given,',
  '  3 the flip did not take effect, which is the only code that means a --commit is safe to',
  '  re-run. It is safe for the remote state, not for an immediate re-run: a run that exits 3',
  '  keeps its own channel lock, so the next --commit is refused as blocked until the lock is',
  '  released with --break-lock --confirm-runid <the runid that run printed>. Every other',
  '  failure may still have changed the remote state, so read the audit log.',
].join('\n');

const MODE_FLAGS = Object.freeze(['--dry-run', '--preflight', '--commit', '--break-lock', '--re-sign-stable']);

function flag(argv, name) {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) return null;
  return value;
}

function appendFailedSession(input) {
  try {
    appendAuditStage({
      auditOut: input.auditOut,
      repositoryRoot,
      entry: {
        stage: input.stage,
        status: 'fail',
        runid: input.runid,
        operator: input.operator,
        at: input.at,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        detail: input.detail,
      },
    });
  } catch {
    console.error(`the failed ${input.stage} session entry could not be recorded either`);
  }
}

function requirePublicKeyFromEnvironment() {
  const value = process.env.PARTNERW_UPDATE_PUBLIC_KEY_B64;
  if (typeof value !== 'string' || value.length === 0) {
    throw new FeedPublishError('PARTNERW_UPDATE_PUBLIC_KEY_B64 is required to verify the release manifest');
  }
  return value;
}

function requireSigningKeyFileFromEnvironment() {
  const value = process.env.PARTNERW_UPDATE_SIGNING_KEY_FILE;
  if (typeof value !== 'string' || value.length === 0) {
    throw new FeedPublishError('PARTNERW_UPDATE_SIGNING_KEY_FILE is required to sign the stable manifest offline');
  }
  return value;
}

function assertTrustAnchorPath(input) {
  if (input.knownHostsPath !== null) assertKnownHostsPath(input.knownHostsPath, repositoryRoot);
}

async function withTransport(createTransport, input, body) {
  const batchRoot = mkdtempSync(join(tmpdir(), 'partner-w-feed-batch-'));
  let batchSeq = 0;
  const createBatch = () => {
    batchSeq += 1;
    const batchFile = join(batchRoot, `sftp-batch-${batchSeq}.txt`);
    return {
      batchFile,
      writeBatch: (text) => writeFileSync(batchFile, text, { encoding: 'utf8', flag: 'a' }),
    };
  };
  try {
    return await body(
      createTransport({
        host: input.host,
        knownHostsPath: input.knownHostsPath,
      }),
      createBatch,
    );
  } finally {
    rmSync(batchRoot, { recursive: true, force: true });
  }
}

export async function runCli(argv, dependencies = {}) {
  const createTransport = dependencies.createTransport;
  if (typeof createTransport !== 'function') {
    throw new FeedPublishError(
      'runCli needs a createTransport function; the real transport is wired by the entry point in scripts/feed-publish.mjs, so a caller that forgets it must not reach the network',
    );
  }
  const modeFlags = MODE_FLAGS.filter((name) => argv.includes(name));
  if (modeFlags.length > 1) {
    console.error(`only one mode flag may be given, but this command line carries ${modeFlags.join(' and ')}`);
    return 1;
  }
  const mode = modeFlags.length === 1 ? modeFlags[0].slice(2) : null;
  if (mode === null) {
    console.log(USAGE);
    return 2;
  }

  const channel = flag(argv, '--channel');
  const version = flag(argv, '--version');
  const host = flag(argv, '--host');
  const knownHostsPath = flag(argv, '--known-hosts');
  const auditOut = flag(argv, '--audit-out');
  const needsNetwork = mode !== 'dry-run' && mode !== 're-sign-stable';
  const versionRequired = mode !== 'break-lock';
  const startedAt = new Date().toISOString();
  const machine = hostname();
  const runid = randomUUID();
  const operator = process.env.PARTNERW_FEED_OPERATOR ?? 'unknown';
  const now = () => new Date().toISOString();

  let input;
  try {
    if (versionRequired && version === null) throw new FeedPublishError('--version is required');
    input = parsePublishInput({ channel, version, host, knownHostsPath, needsNetwork, versionRequired });
  } catch (error) {
    console.error(error instanceof FeedPublishError ? error.message : String(error));
    return 1;
  }

  if (mode === 'dry-run') {
    const packagePath = flag(argv, '--package');
    const fileManifestPath = flag(argv, '--file-manifest');
    const manifestPath = flag(argv, '--manifest');
    if (packagePath === null || fileManifestPath === null || manifestPath === null) {
      console.error('--package, --file-manifest and --manifest are required');
      return 1;
    }
    try {
      const publicKeyBase64 = requirePublicKeyFromEnvironment();
      const resolvedPackagePath = resolve(packagePath);
      const resolvedFileManifestPath = resolve(fileManifestPath);
      const resolvedManifestPath = resolve(manifestPath);
      const verifyReleaseBytes = ({ manifestBytes, fileManifestBytes, packagePath: target }) =>
        verifyPortableRelease({ manifestBytes, fileManifestBytes, packagePath: target, publicKeyBase64 });
      const verified = await verifyLocalArtifacts({
        packagePath: resolvedPackagePath,
        fileManifestPath: resolvedFileManifestPath,
        manifestPath: resolvedManifestPath,
        expectedChannel: input.channel,
        expectedVersion: input.version,
        publicKeyBase64,
        verifySignature: verifyReleaseBytes,
      });
      const plan = await planCommit({
        channel: input.channel,
        version: input.version,
        packagePath: resolvedPackagePath,
        fileManifestPath: resolvedFileManifestPath,
        manifestPath: resolvedManifestPath,
        publicKeyBase64,
        verifySignature: verifyReleaseBytes,
      });
      const targets = planTargets({
        channel: input.channel,
        version: input.version,
        runid,
        packageSha256: verified.packageSha256,
        fileManifestSha256: verified.fileManifestSha256,
        manifestSha256: verified.manifestSha256,
      });
      console.log(
        JSON.stringify(
          {
            mode,
            channel: input.channel,
            version: input.version,
            runid,
            planHash: targets.planHash,
            local: {
              packageSha256: verified.packageSha256,
              packageSize: verified.packageSize,
              fileManifestSha256: verified.fileManifestSha256,
              fileManifestSize: verified.fileManifestSize,
              manifestSha256: verified.manifestSha256,
              manifestSize: verified.manifestBytes.length,
              packageUrl: verified.packageUrl,
            },
            targets: {
              versionRoot: targets.versionRoot,
              stagingRoot: targets.stagingRoot,
              stagingParts: [targets.stagingParts.package, targets.stagingParts.fileManifest],
              channelManifest: targets.channelManifest,
              tempManifest: targets.tempManifest,
            },
            plan,
          },
          null,
          2,
        ),
      );
      console.log('dry run: nothing was written, and no permission, remote directory or host key was verified');
      console.log(
        'the backup path is not printed because it carries the digest of the manifest already on the server, which only a networked mode can read',
      );
      return 0;
    } catch (error) {
      console.error(error instanceof FeedPublishError ? error.message : String(error));
      return 1;
    }
  }

  if (mode === 're-sign-stable') {
    if (input.channel !== 'stable') {
      console.error('--re-sign-stable requires --channel stable');
      return 1;
    }
    const packagePath = flag(argv, '--package');
    const fileManifestPath = flag(argv, '--file-manifest');
    const manifestPath = flag(argv, '--manifest');
    if (packagePath === null || fileManifestPath === null || manifestPath === null) {
      console.error('--package, --file-manifest and --manifest are required');
      return 1;
    }
    const stableOut = flag(argv, '--stable-out');
    if (stableOut === null) {
      console.error('--stable-out is required');
      return 1;
    }
    let resolvedStableOut;
    try {
      resolvedStableOut = assertOutsideRepositoryPath(stableOut, '--stable-out', repositoryRoot);
    } catch (error) {
      console.error(error instanceof FeedPublishError ? error.message : String(error));
      return 1;
    }
    try {
      const publicKeyBase64 = requirePublicKeyFromEnvironment();
      const signingKeyFile = requireSigningKeyFileFromEnvironment();
      const resolvedPackagePath = resolve(packagePath);
      const resolvedFileManifestPath = resolve(fileManifestPath);
      const verified = await verifyLocalArtifacts({
        packagePath: resolvedPackagePath,
        fileManifestPath: resolvedFileManifestPath,
        manifestPath: resolve(manifestPath),
        expectedChannel: 'internal',
        expectedVersion: input.version,
        publicKeyBase64,
        verifySignature: ({ manifestBytes, fileManifestBytes, packagePath }) =>
          verifyPortableRelease({ manifestBytes, fileManifestBytes, packagePath, publicKeyBase64 }),
      });
      const release = await buildPortableRelease({
        ...buildStableManifestInput({
          version: input.version,
          minLauncherVersion: verified.manifest.minLauncherVersion,
          fileManifest: JSON.parse(verified.fileManifestBytes.toString('utf8')),
          fileManifestBytes: verified.fileManifestBytes,
          packagePath: resolvedPackagePath,
          publishedAt: now(),
        }),
        signingKeyPem: await readSigningKeyFile(assertPathOutsideRepository(signingKeyFile, repositoryRoot)),
        publicKeyBase64,
      });
      if (existsSync(resolvedStableOut)) {
        throw new FeedPublishError(
          `${resolvedStableOut} already exists; refusing to overwrite a signed manifest, so remove it by hand to re-sign`,
        );
      }
      writeFileSync(resolvedStableOut, release.manifestBytes, { flag: 'wx' });
      console.log(
        JSON.stringify(
          {
            mode,
            channel: 'stable',
            version: input.version,
            stableManifestOut: resolvedStableOut,
            stableManifestSha256: createHash('sha256').update(release.manifestBytes).digest('hex'),
            reusedFileManifestSha256: createHash('sha256').update(release.fileManifestBytes).digest('hex'),
            reusedPackageSha256: release.packageSha256,
          },
          null,
          2,
        ),
      );
      console.log('the stable manifest was signed offline from the original bytes, and nothing was uploaded');
      return 0;
    } catch (error) {
      console.error(error instanceof FeedPublishError ? error.message : String(error));
      return 1;
    }
  }

  if (mode === 'preflight') {
    try {
      assertTrustAnchorPath(input);
      if (auditOut === null) throw new FeedPublishError('--audit-out is required');
    } catch (error) {
      console.error(error instanceof FeedPublishError ? error.message : String(error));
      return 1;
    }
    return withTransport(createTransport, input, async (transport) => {
      try {
        const result = await runPreflight({
          channel: input.channel,
          version: input.version,
          transport,
          host: input.host,
          knownHostsPath: input.knownHostsPath,
        });
        const status = result.notes.length === 0 ? 'done' : 'fail';
        appendAuditStage({
          auditOut,
          repositoryRoot,
          entry: {
            stage: 'preflight',
            status,
            runid,
            operator,
            at: now(),
            ...(result.notes.length === 0 ? {} : { detail: result.notes.join('; ') }),
          },
        });
        console.log(JSON.stringify({ mode, channel: input.channel, version: input.version, runid, result }, null, 2));
        if (result.notes.length === 0) return 0;
        console.error(
          'the read only probe did not come back clean; the preflight result carries no exit status or stderr, so run the ssh probe by hand to see why',
        );
        return 1;
      } catch (error) {
        const message = error instanceof FeedPublishError ? error.message : String(error);
        appendFailedSession({ auditOut, stage: 'preflight', runid, operator, at: now(), detail: message });
        console.error(message);
        return 1;
      }
    });
  }

  if (mode === 'break-lock') {
    const reason = flag(argv, '--reason');
    const confirmRunid = flag(argv, '--confirm-runid');
    const ownerRecordUnreadable = argv.includes('--owner-record-unreadable');
    try {
      if (reason === null) throw new FeedPublishError('--reason is required');
      if (auditOut === null) throw new FeedPublishError('--audit-out is required');
      if (ownerRecordUnreadable !== true && confirmRunid === null) {
        throw new FeedPublishError('--confirm-runid is required');
      }
      assertTrustAnchorPath(input);
    } catch (error) {
      console.error(error instanceof FeedPublishError ? error.message : String(error));
      return 1;
    }
    return withTransport(createTransport, input, async (transport) => {
      try {
        const record = await breakChannelLock({
          channel: input.channel,
          transport,
          host: input.host,
          knownHostsPath: input.knownHostsPath,
          reason,
          confirmRunid,
          ownerRecordUnreadable,
          auditOut,
          operator,
        });
        const at = now();
        appendAuditStage({ auditOut, repositoryRoot, entry: { stage: 'break-lock', ...record, runid, operator, at } });
        console.log(JSON.stringify({ mode, channel: input.channel, runid, ...record, at }, null, 2));
        return 0;
      } catch (error) {
        const message = error instanceof FeedPublishError ? error.message : String(error);
        if (ownerRecordUnreadable === true) {
          appendFailedSession({ auditOut, stage: 'break-lock', runid, operator, at: now(), reason, detail: message });
        }
        console.error(message);
        return 1;
      }
    });
  }

  const packagePath = flag(argv, '--package');
  const fileManifestPath = flag(argv, '--file-manifest');
  const manifestPath = flag(argv, '--manifest');
  try {
    if (auditOut === null) throw new FeedPublishError('--audit-out is required');
    if (packagePath === null || fileManifestPath === null || manifestPath === null) {
      throw new FeedPublishError('--package, --file-manifest and --manifest are required');
    }
    assertTrustAnchorPath(input);
  } catch (error) {
    console.error(error instanceof FeedPublishError ? error.message : String(error));
    return 1;
  }

  return withTransport(createTransport, input, async (transport, createBatch) => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'partner-w-feed-public-'));
    try {
      const publicKeyBase64 = requirePublicKeyFromEnvironment();
      const resolvedManifestPath = resolve(manifestPath);
      const resolvedFileManifestPath = resolve(fileManifestPath);
      const resolvedPackagePath = resolve(packagePath);
      const verifyReleaseBytes = ({ manifestBytes, fileManifestBytes, packagePath }) =>
        verifyPortableRelease({ manifestBytes, fileManifestBytes, packagePath, publicKeyBase64 });
      const result = await runCommit({
        channel: input.channel,
        version: input.version,
        host: input.host,
        knownHostsPath: input.knownHostsPath,
        runid,
        operator,
        startedAt,
        machine,
        now,
        packagePath: resolvedPackagePath,
        fileManifestPath: resolvedFileManifestPath,
        manifestPath: resolvedManifestPath,
        auditOut,
        repositoryRoot,
        temporaryRoot,
        transport,
        createBatch,
        publicKeyBase64,
        verifySignature: verifyReleaseBytes,
        verifier: verifyReleaseBytes,
      });
      console.log(JSON.stringify(result, null, 2));
      if (result.outcome === 'done') return 0;
      if (result.outcome === 'retry') return 3;
      return 1;
    } catch (error) {
      console.error(error instanceof FeedPublishError ? error.message : String(error));
      return 1;
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
}
