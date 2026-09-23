import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export const UPDATE_ROOT = '/opt/rongying/updates';
export const STATE_ROOT = '/opt/rongying/updates-state';
export const CHANNELS = Object.freeze(['internal', 'stable']);
export const PUBLIC_BASE_URL = 'https://api.rongyinghudong.com/updates';

export const PORTABLE_PACKAGE_NAME = 'portable.zip';
export const PORTABLE_FILE_MANIFEST_NAME = 'portable-files.json';
export const PORTABLE_MANIFEST_NAME = 'manifest.json';

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export class FeedPublishError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FeedPublishError';
  }
}

export function parsePublishInput(raw) {
  if (!CHANNELS.includes(raw.channel)) {
    throw new FeedPublishError(`channel must be one of ${CHANNELS.join(', ')}`);
  }
  const versionRequired = raw.versionRequired !== false;
  const versionGiven = typeof raw.version === 'string';
  if (versionRequired || versionGiven) {
    if (!versionGiven || !SEMVER_PATTERN.test(raw.version)) {
      throw new FeedPublishError(`version must be a strict semantic version, received ${raw.version}`);
    }
  }
  const needsNetwork = raw.needsNetwork === true;
  if (needsNetwork) {
    if (typeof raw.host !== 'string' || raw.host.length === 0) {
      throw new FeedPublishError('the ssh host is required');
    }
    if (raw.host.startsWith('-') || /[\s\u0000-\u001f]/u.test(raw.host)) {
      throw new FeedPublishError('the ssh host must not start with a dash or contain whitespace');
    }
    if (typeof raw.knownHostsPath !== 'string' || raw.knownHostsPath.length === 0) {
      throw new FeedPublishError('the pinned known hosts file is required');
    }
  }
  return {
    channel: raw.channel,
    version: versionRequired ? raw.version : null,
    host: needsNetwork ? raw.host : null,
    knownHostsPath: needsNetwork ? resolve(raw.knownHostsPath) : null,
  };
}

function isInsideRepository(target, repositoryRoot) {
  const relation = relative(resolve(repositoryRoot), resolve(target));
  if (relation === '') return true;
  if (isAbsolute(relation)) return false;
  return relation !== '..' && !relation.startsWith(`..${sep}`);
}

export function assertOutsideRepositoryPath(target, label, repositoryRoot) {
  if (isInsideRepository(target, repositoryRoot)) {
    throw new FeedPublishError(`${label} must live outside the repository`);
  }
  return resolve(target);
}

export function assertKnownHostsPath(target, repositoryRoot) {
  return assertOutsideRepositoryPath(target, 'the pinned known hosts file', repositoryRoot);
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export async function verifyLocalArtifacts(input) {
  if (typeof input.expectedChannel !== 'string' || input.expectedChannel.length === 0) {
    throw new FeedPublishError('an explicit expectedChannel is required');
  }
  if (typeof input.expectedVersion !== 'string' || input.expectedVersion.length === 0) {
    throw new FeedPublishError('an explicit expectedVersion is required');
  }
  if (typeof input.publicKeyBase64 !== 'string' || input.publicKeyBase64.length === 0) {
    throw new FeedPublishError('the update public key is required to verify the release manifest');
  }

  const packageBytes = readFileSync(input.packagePath);
  const fileManifestBytes = readFileSync(input.fileManifestPath);
  const manifestBytes = readFileSync(input.manifestPath);

  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    throw new FeedPublishError('the release manifest is not valid JSON');
  }
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    throw new FeedPublishError('the release manifest is not a JSON object');
  }

  if (manifest.channel !== input.expectedChannel) {
    throw new FeedPublishError(`the manifest channel ${manifest.channel} does not match the requested channel`);
  }
  if (manifest.version !== input.expectedVersion) {
    throw new FeedPublishError(`the manifest version ${manifest.version} does not match the requested version`);
  }

  const packageSha256 = sha256(packageBytes);
  if (packageSha256 !== manifest.packageSha256 || packageBytes.length !== manifest.packageSize) {
    throw new FeedPublishError('the package integrity check failed');
  }
  const fileManifestSha256 = sha256(fileManifestBytes);
  if (fileManifestSha256 !== manifest.fileManifestSha256) {
    throw new FeedPublishError('the file manifest integrity check failed');
  }

  let packageUrl;
  let expectedUrl;
  try {
    packageUrl = new URL(manifest.packageUrl);
    expectedUrl = new URL(`${PUBLIC_BASE_URL}/${manifest.channel}/${manifest.version}/${PORTABLE_PACKAGE_NAME}`);
  } catch {
    throw new FeedPublishError('the package url is not a valid url');
  }
  if (
    packageUrl.protocol !== 'https:' ||
    packageUrl.origin !== expectedUrl.origin ||
    packageUrl.pathname !== expectedUrl.pathname ||
    packageUrl.search !== '' ||
    packageUrl.hash !== '' ||
    packageUrl.username !== '' ||
    packageUrl.password !== ''
  ) {
    throw new FeedPublishError('the package url does not point at this channel and version on the fixed public origin');
  }

  if (typeof input.verifySignature !== 'function') {
    throw new FeedPublishError('a local signature verifier is required to verify the release manifest');
  }
  await input.verifySignature({
    manifestBytes,
    fileManifestBytes,
    packagePath: input.packagePath,
    publicKeyBase64: input.publicKeyBase64,
  });

  return {
    manifest,
    manifestBytes,
    manifestSha256: sha256(manifestBytes),
    packageSha256,
    packageSize: packageBytes.length,
    fileManifestBytes,
    fileManifestSha256,
    fileManifestSize: fileManifestBytes.length,
    packageUrl: manifest.packageUrl,
  };
}

export const PUBLISH_STAGES = Object.freeze([
  'pre-verify',
  'stage',
  'remote-verify',
  'lock',
  're-verify',
  'commit-version',
  'backup-manifest',
  'cas',
  'temp-manifest',
  'flip',
  'public-verify',
  'reveal',
  'unlock',
]);

export async function planCommit(input) {
  await verifyLocalArtifacts({
    packagePath: input.packagePath,
    fileManifestPath: input.fileManifestPath,
    manifestPath: input.manifestPath,
    expectedChannel: input.channel,
    expectedVersion: input.version,
    publicKeyBase64: input.publicKeyBase64,
    verifySignature: input.verifySignature,
  });
  return PUBLISH_STAGES.map((stage) => ({ stage, status: 'pending' }));
}

async function readDeviceIds(input) {
  const probe = await input.transport.readOnly.sshRun({
    host: input.host,
    knownHostsPath: input.knownHostsPath,
    script: `stat -c '%d' ${STATE_ROOT} ${UPDATE_ROOT}`,
  });
  const ids = String(probe.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return { status: probe.status, ids };
}

export async function runPreflight(input) {
  const notes = [];
  const probe = await readDeviceIds(input);
  const sameFileSystem = probe.ids.length === 2 && probe.ids[0] === probe.ids[1];
  if (!sameFileSystem) notes.push('the state root and the update root do not report the same file system');
  if (probe.status !== 0) notes.push('the read only probe did not succeed');

  return {
    sameFileSystem,
    notes,
    writabilityIndicators: {
      verifiedWrite: false,
      note: 'writability is an indicator read from remote metadata, not verified: nothing was written yet',
    },
  };
}

export const LOCK_STATES = Object.freeze(['not-acquired', 'released', 'retained-by-this-run', 'ownership-unknown']);

const CHANNEL_CHARACTERS = [...new Set(CHANNELS.join(''))].join('');

function assertSafeChannel(channel) {
  if (typeof channel !== 'string' || channel.length === 0) {
    throw new FeedPublishError('the channel is empty, so it cannot be interpolated into a remote path');
  }
  if (!CHANNELS.includes(channel)) {
    throw new FeedPublishError(
      `the channel ${channel} is not one of ${CHANNELS.join(', ')}, so it is not safe to interpolate into a remote path`,
    );
  }
  for (const character of channel) {
    if (!CHANNEL_CHARACTERS.includes(character)) {
      throw new FeedPublishError(
        `the channel ${channel} carries ${JSON.stringify(character)}, which no channel in the whitelist uses, so it is not safe to interpolate into a remote path`,
      );
    }
  }
}

function lockPath(channel) {
  assertSafeChannel(channel);
  return `${STATE_ROOT}/lock/${channel}`;
}

function ownerPath(channel) {
  return `${lockPath(channel)}/owner.json`;
}

export function planHashOf(input) {
  for (const field of ['channel', 'version', 'packageSha256', 'fileManifestSha256', 'manifestSha256']) {
    const value = input?.[field];
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new FeedPublishError(`the plan hash needs a non empty ${field}`);
    }
  }
  assertSafeChannel(input.channel);
  return createHash('sha256')
    .update(
      [input.channel, input.version, input.packageSha256, input.fileManifestSha256, input.manifestSha256].join('\n'),
      'utf8',
    )
    .digest('hex');
}

function isFileExistsFailure(result) {
  return /File exists/iu.test(`${result.stderr ?? ''} ${result.stdout ?? ''}`);
}

function isMissingOwnerRecord(read) {
  return read.status > 0 && /No such file or directory/iu.test(`${read.stderr ?? ''} ${read.stdout ?? ''}`);
}

export async function readOwnerRecord(input) {
  const read = await input.transport.readOnly.sshRun({
    host: input.host,
    knownHostsPath: input.knownHostsPath,
    script: `LC_ALL=C cat ${ownerPath(input.channel)}`,
  });
  if (read.status !== 0) {
    if (isMissingOwnerRecord(read)) {
      return { ok: false, status: 'missing', record: null, cause: 'the lock carries no owner record' };
    }
    return { ok: false, status: 'transport', record: null, cause: 'the owner record could not be read' };
  }
  try {
    return { ok: true, status: 'read', record: JSON.parse(String(read.stdout ?? '').trim()), cause: null };
  } catch {
    return { ok: false, status: 'corrupt', record: null, cause: 'the owner record is not valid JSON' };
  }
}

function assertCompleteOwnerRecord(owner) {
  for (const field of ['runid', 'operator', 'startedAt', 'planHash', 'machine']) {
    const value = owner?.[field];
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new FeedPublishError(`the owner record must carry a non empty ${field}, so no lock is created without one`);
    }
  }
}

export async function acquireChannelLock(input) {
  assertCompleteOwnerRecord(input.owner);
  const created = await input.transport.write.sshRun({
    host: input.host,
    knownHostsPath: input.knownHostsPath,
    script: `LC_ALL=C mkdir ${lockPath(input.channel)}`,
  });

  if (created.status !== 0) {
    if (created.status === -1 || !isFileExistsFailure(created)) {
      return {
        state: 'ownership-unknown',
        acquired: false,
        incident: true,
        requiresExplicitRecovery: true,
        reason: 'this run cannot confirm whether it holds the lock',
        owner: null,
      };
    }
    const read = await readOwnerRecord(input);
    return {
      state: 'not-acquired',
      acquired: false,
      incident: false,
      requiresExplicitRecovery: true,
      reason: 'the channel is already locked',
      owner: read.record,
    };
  }

  const written = await input.transport.write.sshRun({
    host: input.host,
    knownHostsPath: input.knownHostsPath,
    script: `printf '%s' '${Buffer.from(JSON.stringify(input.owner), 'utf8').toString('base64')}' | base64 -d > ${ownerPath(input.channel)}`,
  });
  if (written.status !== 0) {
    return {
      state: 'retained-by-this-run',
      acquired: true,
      incident: true,
      requiresExplicitRecovery: true,
      reason: 'the lock was created but its owner record could not be written',
      owner: null,
    };
  }
  return {
    state: 'retained-by-this-run',
    acquired: true,
    incident: false,
    requiresExplicitRecovery: false,
    reason: 'this run holds the lock',
    owner: input.owner,
  };
}

export function resolveLockDisposition(input) {
  if (input.acquisitionConfirmed !== true) {
    return {
      release: false,
      state: 'ownership-unknown',
      incident: true,
      reason: 'this run cannot confirm whether it ever held the lock, so it must not touch one',
    };
  }
  if (input.owner === null || typeof input.owner !== 'object') {
    return { release: false, state: 'ownership-unknown', incident: true, reason: 'the owner record is unreadable' };
  }
  if (input.owner.runid !== input.runid) {
    return {
      release: false,
      state: 'ownership-unknown',
      incident: true,
      reason: `the lock belongs to runid ${input.owner.runid}`,
    };
  }
  if (input.owner.planHash !== input.planHash) {
    return {
      release: false,
      state: 'ownership-unknown',
      incident: true,
      reason: 'the lock planHash does not match this run',
    };
  }
  if (input.safeToExit !== true) {
    return {
      release: false,
      state: 'retained-by-this-run',
      incident: false,
      reason: 'this run holds the lock but the outcome is not safe to close',
    };
  }
  return { release: true, state: 'released', incident: false, reason: 'this run owns the lock and may release it' };
}

export async function releaseChannelLock(input) {
  const owner = input.owner ?? (await readOwnerRecord(input)).record;
  const verdict = resolveLockDisposition({
    acquisitionConfirmed: input.acquisitionConfirmed,
    owner,
    runid: input.runid,
    planHash: input.planHash,
    safeToExit: input.safeToExit,
  });
  if (verdict.release !== true) return verdict;

  const removedOwner = await input.transport.write.sshRun({
    host: input.host,
    knownHostsPath: input.knownHostsPath,
    script: `rm ${ownerPath(input.channel)}`,
  });
  if (removedOwner.status !== 0) {
    return {
      release: false,
      state: 'retained-by-this-run',
      incident: true,
      reason: 'the owner record could not be removed, so the lock is left in place',
    };
  }

  const removedLock = await input.transport.write.sshRun({
    host: input.host,
    knownHostsPath: input.knownHostsPath,
    script: `rmdir ${lockPath(input.channel)}`,
  });
  if (removedLock.status !== 0) {
    return {
      release: false,
      state: 'retained-by-this-run',
      incident: true,
      reason: 'the lock directory could not be removed',
    };
  }
  return verdict;
}

export async function breakChannelLock(input) {
  if (typeof input.reason !== 'string' || input.reason.trim().length === 0) {
    throw new FeedPublishError('breaking a lock requires a written reason');
  }
  if (typeof input.auditOut !== 'string' || input.auditOut.length === 0) {
    throw new FeedPublishError('breaking a lock requires --audit-out');
  }
  const removeLock = async ({ ownerRecordExpected }) => {
    const removedOwner = await input.transport.write.sshRun({
      host: input.host,
      knownHostsPath: input.knownHostsPath,
      script: `${ownerRecordExpected ? 'rm' : 'rm -f'} ${ownerPath(input.channel)}`,
    });
    const removedLock = await input.transport.write.sshRun({
      host: input.host,
      knownHostsPath: input.knownHostsPath,
      script: `rmdir ${lockPath(input.channel)}`,
    });
    if (ownerRecordExpected === true && removedOwner.status !== 0) {
      throw new FeedPublishError('the owner record could not be removed');
    }
    if (removedLock.status !== 0) {
      throw new FeedPublishError('the lock directory could not be removed');
    }
  };
  const read = await readOwnerRecord(input);
  if (input.ownerRecordUnreadable === true) {
    if (read.ok === true) {
      throw new FeedPublishError(
        'the owner record is readable, so this lock needs --confirm-runid rather than the unreadable record flag',
      );
    }
    await removeLock({ ownerRecordExpected: false });
    return {
      outcome: 'lock-broken',
      previousOwner: null,
      ownerRecordUnreadable: true,
      ownerRecordStatus: read.status,
      ownerRecordCause: read.cause,
      reason: input.reason,
      operator: input.operator ?? 'unknown',
    };
  }
  const owner = read.record;
  if (owner === null) {
    throw new FeedPublishError(
      `the lock has no readable owner record (${read.cause}), so it must be inspected by hand; --owner-record-unreadable is the path that records the operator confirming that no previous run is in progress`,
    );
  }
  if (input.confirmRunid !== owner.runid) {
    throw new FeedPublishError(`--confirm-runid does not match the owner runid ${owner.runid}`);
  }
  await removeLock({ ownerRecordExpected: true });
  return {
    outcome: 'lock-broken',
    previousOwner: owner,
    reason: input.reason,
    operator: input.operator ?? 'unknown',
  };
}

const RESERVED_AUDIT_KEYS = Object.freeze([
  'stage',
  'status',
  'reason',
  'detail',
  'runid',
  'planHash',
  'operator',
  'at',
]);

export function assertNoReservedEvidenceKeys(evidence) {
  if (evidence === undefined || evidence === null) return;
  const clashing = Object.keys(evidence).filter((key) => RESERVED_AUDIT_KEYS.includes(key));
  if (clashing.length > 0) {
    throw new FeedPublishError(
      `the audit evidence carries the reserved key(s) ${clashing.join(', ')}, which the entry sets itself from ${RESERVED_AUDIT_KEYS.join(', ')}; the spread would silently override it, so rename the evidence key`,
    );
  }
}

export function appendAuditStage(input) {
  if (typeof input.repositoryRoot !== 'string' || input.repositoryRoot.length === 0) {
    throw new FeedPublishError('the repository root is required, so the audit log can be proven to live outside it');
  }
  if (typeof input.auditOut !== 'string' || input.auditOut.length === 0) {
    throw new FeedPublishError('the audit log needs a non empty path');
  }
  assertOutsideRepository(input.auditOut, input.repositoryRoot);
  try {
    appendFileSync(input.auditOut, `${JSON.stringify(input.entry)}\n`, 'utf8');
  } catch (error) {
    throw new FeedPublishError(`the audit log could not be written: ${error?.message ?? error}`);
  }
  return input.auditOut;
}

function assertOutsideRepository(target, repositoryRoot) {
  if (isInsideRepository(target, repositoryRoot)) {
    throw new FeedPublishError('the audit log must live outside the repository');
  }
  return resolve(target);
}

function assertSafeVersion(version) {
  if (typeof version !== 'string' || version.length === 0) {
    throw new FeedPublishError('the version is empty, so it cannot be interpolated into a remote path');
  }
  if (!SEMVER_PATTERN.test(version)) {
    throw new FeedPublishError(
      `the version ${version} is not a strict semantic version, so it is not safe to interpolate into a remote path`,
    );
  }
}

function assertTemporaryRoot(temporaryRoot) {
  if (typeof temporaryRoot !== 'string' || temporaryRoot.length === 0) {
    throw new FeedPublishError('a temporary root directory is required to write the fetched public artifacts');
  }
}

function assertVerifier(verifier) {
  if (typeof verifier !== 'function') {
    throw new FeedPublishError('a public artifact verifier is required to verify the published artifacts');
  }
}

function assertUploadBatchFactory(createBatch) {
  if (typeof createBatch !== 'function') {
    throw new FeedPublishError(
      'a per upload batch factory is required, because one sftp batch file shared by every upload of a run grows into a cumulative command list that replays the earlier uploads',
    );
  }
}

const RUNID_PATTERN = /^[A-Za-z0-9._-]+$/u;

function assertSafeRunid(runid) {
  if (typeof runid !== 'string' || runid.length === 0) {
    throw new FeedPublishError('the run id is empty, so it cannot be interpolated into a remote path');
  }
  if (!RUNID_PATTERN.test(runid)) {
    throw new FeedPublishError(
      `the run id ${runid} carries a character outside the shell inert alphabet, so it is not safe to interpolate into a remote path`,
    );
  }
}

function versionRootOf(channel, version) {
  return `${UPDATE_ROOT}/${channel}/${version}`;
}

function publicChannelManifestUrl(channel) {
  assertSafeChannel(channel);
  return `${PUBLIC_BASE_URL}/${channel}/${PORTABLE_MANIFEST_NAME}`;
}

function stagingRootOf(channel, version, planHash) {
  return `${STATE_ROOT}/staging/${channel}/${version}/${planHash}`;
}

export function stagingTargetProbeScript(remotePath) {
  return [
    `if [ -L ${remotePath} ]; then printf 'symlink\\n'`,
    `elif [ -d ${remotePath} ]; then printf 'directory\\n'`,
    `elif [ -f ${remotePath} ]; then printf 'file %s\\n' "$(LC_ALL=C stat -c '%s' ${remotePath})"`,
    `elif [ -e ${remotePath} ]; then printf 'other\\n'`,
    `else printf 'absent\\n'`,
    'fi',
  ].join('; ');
}

export function classifyStagingTargetProbe(result) {
  if (result?.status !== 0) {
    const detail = String(result?.stderr ?? '').trim() || String(result?.stdout ?? '').trim();
    return {
      kind: 'unreadable',
      detail: `the probe exited ${result?.status ?? 'without a status'}${detail.length > 0 ? `: ${detail}` : ''}`,
    };
  }
  const answer = String(result.stdout ?? '').trim();
  if (answer === 'absent') return { kind: 'absent' };
  if (answer === 'symlink' || answer === 'directory' || answer === 'other') {
    return { kind: 'unusable', detail: `the remote part is a ${answer}` };
  }
  const file = /^file ([0-9]+)$/u.exec(answer);
  if (file !== null) return { kind: 'file', size: Number(file[1]) };
  return { kind: 'unreadable', detail: `the probe answered ${JSON.stringify(answer)}` };
}

export function decideStagingUpload({ probe, localSize }) {
  if (probe?.kind === 'absent') {
    return { upload: 'full', resume: false, reason: 'the remote part does not exist yet, so this is a first upload' };
  }
  if (probe?.kind !== 'file') {
    return {
      refused: `the remote part could not be trusted: ${probe?.detail ?? 'the probe returned no verdict'}`,
    };
  }
  if (probe.size > localSize) {
    return {
      refused:
        `the remote part is larger than the local artifact (${probe.size} > ${localSize}), ` +
        'so resuming it could not produce this artifact',
    };
  }
  if (probe.size === localSize) {
    return {
      upload: 'full',
      resume: false,
      reason:
        'the remote part already has the full size and sftp refuses to resume an equal size target, ' +
        'so it is uploaded in full',
    };
  }
  return {
    upload: 'resume',
    resume: true,
    reason: `resuming the remote part from ${probe.size} of ${localSize} bytes`,
  };
}

async function probeStagingTarget(input, remotePath) {
  const probe = await input.transport.readOnly.sshRun({
    host: input.host,
    knownHostsPath: input.knownHostsPath,
    script: stagingTargetProbeScript(remotePath),
  });
  return classifyStagingTargetProbe(probe);
}

export function planTargets(input) {
  assertSafeChannel(input.channel);
  assertSafeVersion(input.version);
  assertSafeRunid(input.runid);
  const planHash = planHashOf({
    channel: input.channel,
    version: input.version,
    packageSha256: input.packageSha256,
    fileManifestSha256: input.fileManifestSha256,
    manifestSha256: input.manifestSha256,
  });
  const versionRoot = versionRootOf(input.channel, input.version);
  const stagingRoot = stagingRootOf(input.channel, input.version, planHash);
  return {
    planHash,
    versionRoot,
    stagingRoot,
    channelManifest: `${UPDATE_ROOT}/${input.channel}/${PORTABLE_MANIFEST_NAME}`,
    tempManifest: `${UPDATE_ROOT}/${input.channel}/${PORTABLE_MANIFEST_NAME}.${input.runid}.tmp`,
    stagingParts: {
      package: `${stagingRoot}/${PORTABLE_PACKAGE_NAME}.part`,
      fileManifest: `${stagingRoot}/${PORTABLE_FILE_MANIFEST_NAME}.part`,
    },
  };
}

async function readRemoteDirectory(input, directory) {
  const listing = await input.transport.readOnly.sshRun({
    host: input.host,
    knownHostsPath: input.knownHostsPath,
    script: `if [ -d ${directory} ]; then find ${directory} -mindepth 1 -maxdepth 1 -printf '%y %f %s\\n' | sort; fi`,
  });
  if (listing.status !== 0) return null;
  const entries = [];
  for (const line of String(listing.stdout ?? '').split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const [type, name, size] = trimmed.split(/\s+/u);
    entries.push({ type, name, size: Number(size) });
  }
  return entries;
}

async function remoteDirectoryExists(input, directory) {
  const probe = await input.transport.readOnly.sshRun({
    host: input.host,
    knownHostsPath: input.knownHostsPath,
    script: `if [ -d ${directory} ]; then printf 'present\\n'; fi`,
  });
  return probe.status === 0 && String(probe.stdout ?? '').trim() === 'present';
}

async function readRemoteHashes(input, directory, names) {
  const result = await input.transport.readOnly.sshRun({
    host: input.host,
    knownHostsPath: input.knownHostsPath,
    script: `sha256sum ${names.map((name) => `${directory}/${name}`).join(' ')}`,
  });
  if (result.status !== 0) return null;
  const hashes = new Map();
  for (const line of String(result.stdout ?? '').split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const [digest, target] = trimmed.split(/\s+/u);
    hashes.set(target.split('/').pop(), digest);
  }
  return hashes;
}

function compareDirectoryEntries(entries, expected) {
  const problems = [];
  if (entries.length !== expected.length) {
    problems.push(`the directory holds ${entries.length} entries, expected ${expected.length}`);
  }
  for (const entry of entries) {
    if (entry.type !== 'f') problems.push(`${entry.name} is not a regular file (type ${entry.type})`);
  }
  for (const item of expected) {
    const match = entries.find((entry) => entry.name === item.name);
    if (match === undefined) {
      problems.push(`${item.name} is missing`);
      continue;
    }
    if (match.size !== item.size) problems.push(`${item.name} has size ${match.size}, expected ${item.size}`);
  }
  for (const entry of entries) {
    if (!expected.some((item) => item.name === entry.name)) problems.push(`${entry.name} is an unexpected entry`);
  }
  return problems;
}

function compareDirectoryHashes(hashes, expected) {
  if (hashes === null) return ['the remote digests could not be read'];
  const problems = [];
  for (const item of expected) {
    if (hashes.get(item.name) !== item.sha256) problems.push(`${item.name} does not carry the expected digest`);
  }
  return problems;
}

async function inspectRemoteDirectory(input, directory, expectedEntries) {
  const exists = await remoteDirectoryExists(input, directory);
  if (!exists) {
    return { present: false, empty: false, unlistable: false, problems: [], entries: [], digests: null };
  }
  const entries = await readRemoteDirectory(input, directory);
  if (entries === null) {
    return {
      present: true,
      empty: false,
      unlistable: true,
      problems: ['the remote directory could not be listed'],
      entries: [],
      digests: null,
    };
  }
  if (entries.length === 0) {
    return { present: true, empty: true, unlistable: false, problems: [], entries: [], digests: null };
  }
  const problems = compareDirectoryEntries(entries, expectedEntries);
  let digests = null;
  if (problems.length === 0) {
    digests = await readRemoteHashes(
      input,
      directory,
      expectedEntries.map((item) => item.name),
    );
    problems.push(...compareDirectoryHashes(digests, expectedEntries));
  }
  return {
    present: true,
    empty: false,
    unlistable: false,
    problems,
    entries,
    digests: digests === null ? null : Object.fromEntries(digests),
  };
}

async function readRemoteFileSha(input, target) {
  const result = await input.transport.readOnly.sshRun({
    host: input.host,
    knownHostsPath: input.knownHostsPath,
    script: `sha256sum ${target} || true`,
  });
  if (result.status !== 0) return { ok: false, sha256: null };
  return { ok: true, sha256: String(result.stdout ?? '').split(/\s+/u)[0] || 'absent' };
}

export async function verifyPublicArtifacts(input) {
  assertSafeChannel(input.channel);
  assertSafeVersion(input.version);
  assertTemporaryRoot(input.temporaryRoot);
  if (typeof input.verifier !== 'function') {
    throw new FeedPublishError('a public artifact verifier is required to verify the published manifest');
  }
  const base = `${PUBLIC_BASE_URL}/${input.channel}/${input.version}`;
  const manifestResponse = await input.transport.fetchPublic(publicChannelManifestUrl(input.channel));
  if (manifestResponse.status !== 200) return { ok: false, reason: 'the public manifest is not reachable' };

  const manifestBytes = Buffer.from(manifestResponse.bodyBytes);
  if (!manifestBytes.equals(input.expectedManifestBytes)) {
    return { ok: false, reason: 'the public manifest is not the manifest this run signed' };
  }

  const packageResponse = await input.transport.fetchPublic(`${base}/${PORTABLE_PACKAGE_NAME}`);
  if (packageResponse.status !== 200) return { ok: false, reason: 'the public package is not reachable' };
  const packageBytes = Buffer.from(packageResponse.bodyBytes);
  const publicPackageSha256 = createHash('sha256').update(packageBytes).digest('hex');
  if (publicPackageSha256 !== input.expectedPackageSha256) {
    return { ok: false, reason: 'the public package integrity check failed' };
  }
  if (packageBytes.length !== input.expectedPackageSize) {
    return { ok: false, reason: 'the public package size does not match' };
  }

  const fileManifestResponse = await input.transport.fetchPublic(`${base}/${PORTABLE_FILE_MANIFEST_NAME}`);
  if (fileManifestResponse.status !== 200) return { ok: false, reason: 'the public file manifest is not reachable' };
  const fileManifestBytes = Buffer.from(fileManifestResponse.bodyBytes);
  const publicFileManifestSha256 = createHash('sha256').update(fileManifestBytes).digest('hex');
  if (publicFileManifestSha256 !== input.expectedFileManifestSha256) {
    return { ok: false, reason: 'the public file manifest integrity check failed' };
  }
  if (fileManifestBytes.length !== input.expectedFileManifestSize) {
    return { ok: false, reason: 'the public file manifest size does not match' };
  }

  const packagePath = join(input.temporaryRoot, PORTABLE_PACKAGE_NAME);
  const fileManifestPath = join(input.temporaryRoot, PORTABLE_FILE_MANIFEST_NAME);
  writeFileSync(packagePath, packageBytes);
  writeFileSync(fileManifestPath, fileManifestBytes);
  await input.verifier({ manifestBytes, fileManifestBytes, packagePath, publicKeyBase64: input.publicKeyBase64 });

  return {
    ok: true,
    manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
    packageSha256: publicPackageSha256,
    packageSize: packageBytes.length,
    fileManifestSha256: publicFileManifestSha256,
    fileManifestSize: fileManifestBytes.length,
  };
}

function createPublishRun(input) {
  const stages = PUBLISH_STAGES.map((stage) => ({ stage, status: 'pending' }));
  const runid = input.runid;
  const state = {
    acquisitionConfirmed: false,
    acquiredLockState: null,
    planHash: 'uncomputed',
    owner: null,
    ownerRecord: null,
  };

  const atValue = () => (input.now === undefined ? input.startedAt : input.now()) ?? null;
  const baseOf = () => ({ runid, operator: input.operator ?? null, at: atValue() });

  const audit = (stage, status, detail, evidence) => {
    assertNoReservedEvidenceKeys(evidence);
    stages.find((entry) => entry.stage === stage).status = status;
    appendAuditStage({
      auditOut: input.auditOut,
      repositoryRoot: input.repositoryRoot,
      entry: { ...(evidence ?? {}), stage, status, ...baseOf(), ...(detail === undefined ? {} : { detail }) },
    });
  };

  const finish = (outcome, reason, lockState) => ({
    outcome,
    reason,
    lockState,
    stages,
    runid,
    planHash: state.planHash,
  });

  const recordOutcome = (outcome, reason, evidence) => {
    assertNoReservedEvidenceKeys(evidence);
    appendAuditStage({
      auditOut: input.auditOut,
      repositoryRoot: input.repositoryRoot,
      entry: { ...(evidence ?? {}), stage: outcome, reason, ...baseOf(), planHash: state.planHash },
    });
  };

  const retainAndFinish = (outcome, reason) => {
    const disposition = resolveLockDisposition({
      acquisitionConfirmed: state.acquisitionConfirmed,
      owner: state.owner,
      runid,
      planHash: state.planHash,
      safeToExit: false,
    });
    const lockState =
      state.owner === null && state.acquiredLockState !== null ? state.acquiredLockState : disposition.state;
    stages.find((entry) => entry.stage === 'unlock').status = 'retained';
    recordOutcome(outcome, reason);
    appendAuditStage({
      auditOut: input.auditOut,
      repositoryRoot: input.repositoryRoot,
      entry: { stage: 'lock-retained', status: 'retained', ...baseOf(), reason: disposition.reason },
    });
    return finish(outcome, reason, lockState);
  };

  const reportUnlock = (disposition) => {
    const unlockStatus = disposition.release ? 'done' : 'retained';
    stages.find((entry) => entry.stage === 'unlock').status = unlockStatus;
    appendAuditStage({
      auditOut: input.auditOut,
      repositoryRoot: input.repositoryRoot,
      entry: { stage: 'unlock', status: unlockStatus, ...baseOf(), reason: disposition.reason },
    });
  };

  const releaseAndFinish = async (failedStage, reason) => {
    stages.find((entry) => entry.stage === failedStage).status = 'fail';
    recordOutcome('fail', reason);
    const disposition = await releaseChannelLock({
      channel: input.channel,
      transport: input.transport,
      runid,
      planHash: state.planHash,
      host: input.host,
      knownHostsPath: input.knownHostsPath,
      acquisitionConfirmed: state.acquisitionConfirmed,
      safeToExit: true,
    });
    reportUnlock(disposition);
    return finish('fail', reason, disposition.state);
  };

  return { state, runid, baseOf, audit, finish, recordOutcome, retainAndFinish, releaseAndFinish, reportUnlock };
}

export async function runCommit(input) {
  const { state, runid, baseOf, audit, finish, recordOutcome, retainAndFinish, releaseAndFinish, reportUnlock } =
    createPublishRun(input);

  try {
    appendAuditStage({
      auditOut: input.auditOut,
      repositoryRoot: input.repositoryRoot,
      entry: { stage: 'open', ...baseOf() },
    });
  } catch (error) {
    return finish('fail', error.message, 'not-acquired');
  }

  let local;
  let targets;
  try {
    assertSafeChannel(input.channel);
    assertSafeVersion(input.version);
    assertSafeRunid(runid);
    assertTemporaryRoot(input.temporaryRoot);
    assertVerifier(input.verifier);
    assertUploadBatchFactory(input.createBatch);
    local = await verifyLocalArtifacts({
      packagePath: input.packagePath,
      fileManifestPath: input.fileManifestPath,
      manifestPath: input.manifestPath,
      expectedChannel: input.channel,
      expectedVersion: input.version,
      publicKeyBase64: input.publicKeyBase64,
      verifySignature: input.verifySignature,
    });
    targets = planTargets({
      channel: input.channel,
      version: input.version,
      runid,
      packageSha256: local.packageSha256,
      fileManifestSha256: local.fileManifestSha256,
      manifestSha256: local.manifestSha256,
    });
    state.planHash = targets.planHash;
    state.ownerRecord = {
      runid,
      operator: input.operator,
      startedAt: input.startedAt,
      planHash: state.planHash,
      machine: input.machine,
    };
    assertCompleteOwnerRecord(state.ownerRecord);
  } catch (error) {
    audit('pre-verify', 'fail', error.message);
    recordOutcome('fail', error.message);
    return finish('fail', error.message, 'not-acquired');
  }
  const localEvidence = {
    local: {
      packageSha256: local.packageSha256,
      packageSize: local.packageSize,
      fileManifestSha256: local.fileManifestSha256,
      fileManifestSize: local.fileManifestSize,
      manifestSha256: local.manifestSha256,
      manifestSize: local.manifestBytes.length,
    },
  };
  audit('pre-verify', 'done', undefined, localEvidence);

  const versionRoot = targets.versionRoot;
  const stagingRoot = targets.stagingRoot;
  const expectedEntries = [
    { name: PORTABLE_PACKAGE_NAME, size: local.packageSize, sha256: local.packageSha256 },
    { name: PORTABLE_FILE_MANIFEST_NAME, size: local.fileManifestSize, sha256: local.fileManifestSha256 },
  ];

  const stagingCreated = await input.transport.write.sshRun({
    host: input.host,
    knownHostsPath: input.knownHostsPath,
    script: `mkdir -p ${stagingRoot}`,
  });
  if (stagingCreated.status !== 0) {
    audit('stage', 'fail', 'the staging directory could not be created');
    recordOutcome('fail', 'the staging directory could not be created');
    return finish('fail', 'the staging directory could not be created', 'not-acquired');
  }

  const strayParts = await input.transport.write.sshRun({
    host: input.host,
    knownHostsPath: input.knownHostsPath,
    script: `for f in ${stagingRoot}/${PORTABLE_PACKAGE_NAME}.part-* ${stagingRoot}/${PORTABLE_FILE_MANIFEST_NAME}.part-*; do if [ -e "$f" ]; then printf '%s\\n' "$f"; rm -f "$f"; fi; done`,
  });
  if (strayParts.status !== 0) {
    audit(
      'stage',
      'fail',
      'the staging directory could not be cleared of the partial uploads an earlier run left behind',
    );
    recordOutcome(
      'fail',
      'the staging directory could not be cleared of the partial uploads an earlier run left behind',
    );
    return finish(
      'fail',
      'the staging directory could not be cleared of the partial uploads an earlier run left behind',
      'not-acquired',
    );
  }
  const removedStrayParts = String(strayParts.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const nextUploadBatch = () => input.createBatch();
  const uploadEvidence = [];
  for (const item of [
    {
      localPath: input.packagePath,
      remotePath: targets.stagingParts.package,
      localSize: local.packageSize,
      name: PORTABLE_PACKAGE_NAME,
    },
    {
      localPath: input.fileManifestPath,
      remotePath: targets.stagingParts.fileManifest,
      localSize: local.fileManifestSize,
      name: PORTABLE_FILE_MANIFEST_NAME,
    },
  ]) {
    const probe = await probeStagingTarget(input, item.remotePath);
    const decision = decideStagingUpload({ probe, localSize: item.localSize });
    if (typeof decision.refused === 'string') {
      const reason = `the staging upload of ${item.name} was refused: ${decision.refused}`;
      audit('stage', 'fail', reason);
      recordOutcome('fail', reason);
      return finish('fail', reason, 'not-acquired');
    }
    uploadEvidence.push({
      name: item.name,
      command: decision.upload === 'resume' ? 'reput' : 'put',
      probe: probe.kind,
      remoteBytesBefore: probe.kind === 'file' ? probe.size : 0,
    });
    const uploaded = await input.transport.write.sftpUpload({
      localPath: item.localPath,
      remotePath: item.remotePath,
      resume: decision.resume,
      ...nextUploadBatch(),
    });
    if (uploaded.status !== 0) {
      audit('stage', 'fail', uploaded.stderr ?? 'upload failed');
      recordOutcome('fail', 'the staging upload failed');
      return finish('fail', 'the staging upload failed', 'not-acquired');
    }
  }

  const finalised = await input.transport.write.sshRun({
    host: input.host,
    knownHostsPath: input.knownHostsPath,
    script: [
      `mv -f ${stagingRoot}/${PORTABLE_PACKAGE_NAME}.part ${stagingRoot}/${PORTABLE_PACKAGE_NAME}`,
      `mv -f ${stagingRoot}/${PORTABLE_FILE_MANIFEST_NAME}.part ${stagingRoot}/${PORTABLE_FILE_MANIFEST_NAME}`,
    ].join(' && '),
  });
  if (finalised.status !== 0) {
    audit('stage', 'fail', 'the staging directory could not be finalised');
    recordOutcome('fail', 'the staging directory could not be finalised');
    return finish('fail', 'the staging directory could not be finalised', 'not-acquired');
  }
  audit('stage', 'done', undefined, { removedStrayParts, uploads: uploadEvidence });

  const staging = await inspectRemoteDirectory(input, stagingRoot, expectedEntries);
  const stagingEvidence = { remote: staging };
  if (!staging.present || staging.empty || staging.problems.length > 0) {
    const detail = staging.empty ? 'the staging directory is empty' : staging.problems.join('; ');
    const reason = `the staging directory is not the exact final file set: ${detail}`;
    audit('remote-verify', 'fail', detail, stagingEvidence);
    recordOutcome('fail', reason);
    return finish('fail', reason, 'not-acquired');
  }
  audit('remote-verify', 'done', undefined, stagingEvidence);

  const lock = await acquireChannelLock({
    channel: input.channel,
    transport: input.transport,
    owner: state.ownerRecord,
    host: input.host,
    knownHostsPath: input.knownHostsPath,
  });
  if (lock.acquired !== true) {
    const blocked = lock.state === 'not-acquired';
    const outcome = blocked ? 'blocked' : 'incident';
    audit('lock', outcome, lock.reason);
    recordOutcome(outcome, lock.reason);
    return finish(outcome, lock.reason, lock.state);
  }
  state.acquisitionConfirmed = true;
  state.acquiredLockState = lock.state;
  state.owner = lock.owner;
  if (lock.incident === true) {
    audit('lock', 'incident', lock.reason);
    return retainAndFinish('incident', lock.reason);
  }
  audit('lock', 'done');

  const reRead = await readOwnerRecord(input);
  if (reRead.ok !== true) {
    audit('re-verify', 'incident', reRead.cause);
    return retainAndFinish('incident', `the lock owner record could not be re-read: ${reRead.cause}`);
  }
  const reReadOwner = reRead.record;
  if (reReadOwner !== null && (reReadOwner.runid !== runid || reReadOwner.planHash !== state.planHash)) {
    state.owner = reReadOwner;
    audit('re-verify', 'incident', 'the lock owner changed while this run was taking it');
    return retainAndFinish('incident', 'the lock owner changed while this run was taking it');
  }
  state.owner = reReadOwner ?? state.owner;
  const baselineRead = await readRemoteFileSha(input, targets.channelManifest);
  if (baselineRead.ok !== true) {
    audit('re-verify', 'incident', 'the manifest digest that the CAS baseline needs could not be read');
    return retainAndFinish(
      'incident',
      'the manifest digest could not be read, so this run has no baseline to compare against',
    );
  }
  const baselineSha = baselineRead.sha256;
  const stagingAfterLock = await inspectRemoteDirectory(input, stagingRoot, expectedEntries);
  if (!stagingAfterLock.present || stagingAfterLock.empty || stagingAfterLock.problems.length > 0) {
    audit('re-verify', 'incident', 'the staging bytes changed while the lock was being taken');
    return retainAndFinish('incident', 'the staging bytes changed while the lock was being taken');
  }
  audit('re-verify', 'done');

  const devices = await readDeviceIds(input);
  if (devices.status !== 0 || devices.ids.length !== 2 || devices.ids[0] !== devices.ids[1]) {
    return releaseAndFinish('commit-version', 'the staging root and the update root are not on the same file system');
  }

  const existing = await inspectRemoteDirectory(input, versionRoot, expectedEntries);
  if (existing.present && existing.empty) {
    return releaseAndFinish('commit-version', 'the immutable version directory already exists but is incomplete');
  }
  if (existing.present && existing.problems.length > 0) {
    return releaseAndFinish(
      'commit-version',
      `the immutable version directory already exists and does not match: ${existing.problems.join('; ')}`,
    );
  }
  if (existing.present) {
    audit('commit-version', 'done', 'the immutable version directory already matched every byte');
  } else {
    const committed = await input.transport.write.sshRun({
      host: input.host,
      knownHostsPath: input.knownHostsPath,
      script: `mv ${stagingRoot} ${versionRoot}`,
    });
    if (committed.status !== 0) {
      return releaseAndFinish('commit-version', 'the version directory was not committed');
    }
    audit('commit-version', 'done');
  }

  const backupPath = `${STATE_ROOT}/backup/${input.channel}-manifest.json-pre-${input.version}-${baselineSha}`;
  const backup = await input.transport.write.sshRun({
    host: input.host,
    knownHostsPath: input.knownHostsPath,
    script:
      baselineSha === 'absent'
        ? `mkdir -p ${STATE_ROOT}/backup`
        : [
            `mkdir -p ${STATE_ROOT}/backup`,
            `cp ${targets.channelManifest} ${backupPath}`,
            `sha256sum ${backupPath}`,
          ].join(' && '),
  });
  const copiedManifestSha256 =
    baselineSha === 'absent' ? 'absent' : String(backup.stdout ?? '').split(/\s+/u)[0] || 'unreadable';
  const backupEvidence = { previousManifestSha256: baselineSha, backupPath, copiedManifestSha256 };
  if (backup.status !== 0) {
    audit('backup-manifest', 'incident', 'the previous manifest could not be backed up', backupEvidence);
    return retainAndFinish('incident', 'the previous manifest could not be backed up');
  }
  if (copiedManifestSha256 !== baselineSha) {
    audit('backup-manifest', 'incident', 'the copy does not carry the baseline bytes', backupEvidence);
    return retainAndFinish('incident', 'the backup does not carry the bytes this run read as its baseline');
  }
  audit('backup-manifest', 'done', undefined, backupEvidence);

  const casRead = await readRemoteFileSha(input, targets.channelManifest);
  const casEvidence = { previousManifestSha256: baselineSha, observedManifestSha256: casRead.sha256 };
  if (casRead.ok !== true) {
    audit('cas', 'incident', 'the remote manifest digest could not be read', casEvidence);
    return retainAndFinish(
      'incident',
      'the remote manifest digest could not be read, so this run cannot tell a bypass from a failed read',
    );
  }
  const casSha = casRead.sha256;
  if (casSha !== baselineSha) {
    audit('cas', 'incident', undefined, casEvidence);
    return retainAndFinish(
      'incident',
      'the manifest changed after the lock was taken, which means a bypass; nothing is flipped, rolled back or deleted',
    );
  }
  audit('cas', 'done', undefined, casEvidence);

  const manifestEvidence = { manifestSha256: local.manifestSha256 };
  const tempManifestPath = targets.tempManifest;
  const manifestUploaded = await input.transport.write.sftpUpload({
    localPath: input.manifestPath,
    remotePath: tempManifestPath,
    resume: false,
    ...nextUploadBatch(),
  });
  if (manifestUploaded.status !== 0) {
    audit('temp-manifest', 'incident', 'the manifest upload failed', manifestEvidence);
    return retainAndFinish('incident', 'the manifest could not be uploaded, so the outcome is uncertain');
  }
  const tempRead = await readRemoteFileSha(input, tempManifestPath);
  const remoteTempSha = tempRead.sha256;
  const tempManifestEvidence = { manifestSha256: local.manifestSha256, remoteTempSha256: remoteTempSha };
  if (tempRead.ok !== true) {
    audit('temp-manifest', 'incident', 'the uploaded manifest digest could not be read', tempManifestEvidence);
    return retainAndFinish(
      'incident',
      'the uploaded manifest digest could not be read, so this run cannot tell a bad upload from a failed read',
    );
  }
  if (remoteTempSha !== local.manifestSha256) {
    audit(
      'temp-manifest',
      'incident',
      'the uploaded manifest digest does not match the local manifest',
      tempManifestEvidence,
    );
    return retainAndFinish('incident', 'the uploaded manifest does not match the local manifest');
  }
  audit('temp-manifest', 'done', undefined, tempManifestEvidence);

  const flipped = await input.transport.write.sshRun({
    host: input.host,
    knownHostsPath: input.knownHostsPath,
    script: `mv -f ${tempManifestPath} ${targets.channelManifest}`,
  });
  if (flipped.status !== 0) {
    audit('flip', 'incident', 'the atomic flip failed', manifestEvidence);
    return retainAndFinish('incident', 'the atomic flip failed, so the outcome is uncertain');
  }
  audit('flip', 'done', undefined, manifestEvidence);

  let observed;
  try {
    observed = await input.transport.fetchPublic(publicChannelManifestUrl(input.channel));
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    audit('public-verify', 'incident', cause, manifestEvidence);
    return retainAndFinish('incident', `the public manifest could not be read: ${cause}`);
  }
  if (observed.status !== 200 || observed.bodyBytes === undefined) {
    audit('public-verify', 'incident', 'the public manifest could not be read', manifestEvidence);
    return retainAndFinish('incident', 'the public manifest could not be read, so the outcome is uncertain');
  }
  const observedSha = createHash('sha256').update(Buffer.from(observed.bodyBytes)).digest('hex');
  const observedEvidence = {
    manifestSha256: local.manifestSha256,
    observedManifestSha256: observedSha,
    previousManifestSha256: baselineSha,
  };
  if (observedSha === local.manifestSha256) {
    let publicCheck;
    try {
      publicCheck = await verifyPublicArtifacts({
        channel: input.channel,
        version: input.version,
        publicKeyBase64: input.publicKeyBase64,
        verifier: input.verifier,
        expectedManifestBytes: local.manifestBytes,
        expectedPackageSha256: local.packageSha256,
        expectedPackageSize: local.packageSize,
        expectedFileManifestSha256: local.fileManifestSha256,
        expectedFileManifestSize: local.fileManifestSize,
        transport: input.transport,
        temporaryRoot: input.temporaryRoot,
      });
    } catch (error) {
      audit('public-verify', 'incident', error.message, observedEvidence);
      return retainAndFinish('incident', `the public verification could not be completed: ${error.message}`);
    }
    if (publicCheck.ok !== true) {
      audit('public-verify', 'incident', publicCheck.reason, observedEvidence);
      return retainAndFinish('incident', `the public verification failed: ${publicCheck.reason}`);
    }
    audit('public-verify', 'done', undefined, { public: publicCheck });
    audit('reveal', 'done');
  } else if (observedSha === baselineSha) {
    audit('public-verify', 'retry', undefined, observedEvidence);
    return retainAndFinish('retry', 'the flip did not take effect');
  } else {
    audit('public-verify', 'incident', 'a third manifest digest appeared', observedEvidence);
    return retainAndFinish('incident', 'a third manifest digest appeared while flipping');
  }

  recordOutcome('done', 'published', manifestEvidence);
  const disposition = await releaseChannelLock({
    channel: input.channel,
    transport: input.transport,
    runid,
    planHash: state.planHash,
    host: input.host,
    knownHostsPath: input.knownHostsPath,
    acquisitionConfirmed: state.acquisitionConfirmed,
    safeToExit: true,
  });
  reportUnlock(disposition);
  if (disposition.release !== true) return finish('incident', disposition.reason, disposition.state);
  return finish('done', 'published', disposition.state);
}

export function assertNotReusedManifest(input) {
  if (!Object.hasOwn(input, 'manifestBytes')) return;
  const carried = input.manifestBytes === undefined ? 'no value' : 'a value';
  throw new FeedPublishError(
    `the stable manifest must be signed on its own, but the input carries the internal key manifestBytes with ${carried}`,
  );
}

export function buildStableManifestInput(input) {
  assertNotReusedManifest(input);
  return {
    version: input.version,
    minLauncherVersion: input.minLauncherVersion,
    channel: 'stable',
    baseUrl: PUBLIC_BASE_URL,
    fileManifest: input.fileManifest,
    fileManifestBytes: input.fileManifestBytes,
    packagePath: input.packagePath,
    publishedAt: input.publishedAt,
  };
}
