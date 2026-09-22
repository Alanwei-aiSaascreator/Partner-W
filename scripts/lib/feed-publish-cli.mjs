import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FeedPublishError,
  appendAuditStage,
  assertKnownHostsPath,
  breakChannelLock,
  buildStableManifestInput,
  parsePublishInput,
  planCommit,
  runCommit,
  runPreflight,
  verifyLocalArtifacts,
} from './feed-publish.mjs';
import { createFeedTransport } from './feed-publish-transport.mjs';
import {
  assertPathOutsideRepository,
  buildPortableRelease,
  readSigningKeyFile,
  verifyPortableRelease,
} from './portable-update-release.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const USAGE = [
  'Usage: node scripts/feed-publish.mjs <--dry-run|--preflight|--commit|--break-lock|--re-sign-stable> --channel <internal|stable> --version <x.y.z> [--host <host> --known-hosts <path>]',
  '  --dry-run          offline: validate the three artifacts and print the plan',
  '  --preflight        read only remote checks; never claims to have verified writability;',
  '                     needs --audit-out, because it records a session level entry',
  '  --commit           publish; needs --package --file-manifest --manifest --audit-out',
  '  --break-lock       needs --reason --audit-out --confirm-runid',
  '  --owner-record-unreadable',
  '                     with --break-lock: the lock owner record cannot be read, so there',
  '                     is no runid to confirm; passing this flag is the operator stating',
  '                     that the previous run is not in progress. Refused when the record',
  '                     is readable, where --confirm-runid is required instead',
  '  --re-sign-stable   offline: re-sign the internal release bytes for stable; needs',
  '                     --package --file-manifest --manifest --stable-out, and refuses to',
  '                     overwrite the output; --channel must be stable',
  '  --known-hosts      the pinned known_hosts file, must live outside the repository',
].join('\n');

function flag(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : null;
}

function requirePublicKeyFromEnvironment() {
  const value = process.env.MOFANG_UPDATE_PUBLIC_KEY_B64;
  if (typeof value !== 'string' || value.length === 0) {
    throw new FeedPublishError('MOFANG_UPDATE_PUBLIC_KEY_B64 is required to verify the release manifest');
  }
  return value;
}

function requireSigningKeyFileFromEnvironment() {
  const value = process.env.MOFANG_UPDATE_SIGNING_KEY_FILE;
  if (typeof value !== 'string' || value.length === 0) {
    throw new FeedPublishError('MOFANG_UPDATE_SIGNING_KEY_FILE is required to sign the stable manifest offline');
  }
  return value;
}

function assertTrustAnchorPath(input) {
  if (input.knownHostsPath !== null) assertKnownHostsPath(input.knownHostsPath, repositoryRoot);
}

async function withTransport(createTransport, input, body) {
  const batchRoot = mkdtempSync(join(tmpdir(), 'mofang-feed-batch-'));
  const batchFile = join(batchRoot, 'sftp-batch.txt');
  try {
    return await body(
      createTransport({
        host: input.host,
        knownHostsPath: input.knownHostsPath,
        batchFile,
        writeBatch: (text) => writeFileSync(batchFile, text, { encoding: 'utf8', flag: 'a' }),
      }),
    );
  } finally {
    rmSync(batchRoot, { recursive: true, force: true });
  }
}

export async function runCli(argv, dependencies = {}) {
  const createTransport = dependencies.createTransport ?? createFeedTransport;
  const mode = argv.includes('--commit')
    ? 'commit'
    : argv.includes('--preflight')
      ? 'preflight'
      : argv.includes('--break-lock')
        ? 'break-lock'
        : argv.includes('--re-sign-stable')
          ? 're-sign-stable'
          : argv.includes('--dry-run')
            ? 'dry-run'
            : null;
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
  const startedAt = new Date().toISOString();
  const machine = hostname();
  const runid = randomUUID();
  const operator = process.env.MOFANG_FEED_OPERATOR ?? 'unknown';
  const now = () => new Date().toISOString();

  let input;
  try {
    input = parsePublishInput({ channel, version: version ?? '0.0.0', host, knownHostsPath, needsNetwork });
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
      const plan = await planCommit({
        channel: input.channel,
        version: input.version,
        packagePath: resolve(packagePath),
        fileManifestPath: resolve(fileManifestPath),
        manifestPath: resolve(manifestPath),
        publicKeyBase64,
        verifySignature: ({ manifestBytes, fileManifestBytes, packagePath }) =>
          verifyPortableRelease({ manifestBytes, fileManifestBytes, packagePath, publicKeyBase64 }),
      });
      console.log(JSON.stringify({ mode, channel: input.channel, version: input.version, plan }, null, 2));
      console.log('dry run: nothing was written, and no permission, remote directory or host key was verified');
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
    if (version === null) {
      console.error('--version is required');
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
      const stableManifestOut = resolve(stableOut);
      writeFileSync(stableManifestOut, release.manifestBytes, { flag: 'wx' });
      console.log(
        JSON.stringify(
          {
            mode,
            channel: 'stable',
            version: input.version,
            stableManifestOut,
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
        console.log(
          JSON.stringify({ mode, channel: input.channel, version: input.version, runid, ...record, at }, null, 2),
        );
        return 0;
      } catch (error) {
        console.error(error instanceof FeedPublishError ? error.message : String(error));
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

  return withTransport(createTransport, input, async (transport) => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'mofang-feed-public-'));
    try {
      const publicKeyBase64 = requirePublicKeyFromEnvironment();
      const resolvedManifestPath = resolve(manifestPath);
      const resolvedFileManifestPath = resolve(fileManifestPath);
      const resolvedPackagePath = resolve(packagePath);
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
        publicKeyBase64,
        verifySignature: ({ manifestBytes, fileManifestBytes, packagePath }) =>
          verifyPortableRelease({ manifestBytes, fileManifestBytes, packagePath, publicKeyBase64 }),
        verifier: ({ manifestBytes, fileManifestBytes, packagePath }) =>
          verifyPortableRelease({ manifestBytes, fileManifestBytes, packagePath, publicKeyBase64 }),
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
