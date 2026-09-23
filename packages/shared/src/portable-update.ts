export const PORTABLE_UPDATE_SCHEMA_VERSION = 1 as const;

export type PortableUpdateChannel = 'stable' | 'internal';

export type PortableUpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'verifying-archive'
  | 'extracting'
  | 'verifying-files'
  | 'ready'
  | 'applying'
  | 'awaiting-health'
  | 'committed'
  | 'rolled-back'
  | 'error';

export type PortableUpdateErrorCode =
  | 'network'
  | 'feed-response'
  | 'signature-invalid'
  | 'manifest-invalid'
  | 'unsupported-policy'
  | 'launcher-incompatible'
  | 'disk-space'
  | 'volume-readonly'
  | 'package-integrity'
  | 'archive-unsafe'
  | 'file-integrity'
  | 'file-in-use'
  | 'launcher-start-failed'
  | 'health-timeout'
  | 'rollback-failed'
  | 'cancelled'
  | 'unknown';

export interface PortableUpdateManifestV1 {
  schemaVersion: 1;
  channel: PortableUpdateChannel;
  version: string;
  minLauncherVersion: string;
  packageUrl: string;
  packageSize: number;
  packageSha256: string;
  fileManifestSha256: string;
  publishedAt: string;
  mandatory: false;
  signature: string;
}

export interface PortableUpdateFileEntry {
  path: string;
  size: number;
  sha256: string;
}

export interface PortableUpdateFileManifestV1 {
  schemaVersion: 1;
  version: string;
  files: PortableUpdateFileEntry[];
}

export interface PortableUpdatePublicState {
  phase: PortableUpdatePhase;
  currentVersion: string;
  targetVersion?: string;
  transferred?: number;
  total?: number;
  percent?: number;
  errorCode?: PortableUpdateErrorCode;
  /**
   * 「空间不足」时的两个数字（字节）。有它们，文案才能说"还差多少"，
   * 而不是只丢一句"空间不足"让用户自己猜要清出多少。
   * ⚠️ 只放字节数：这个结构会原样过 IPC 到渲染进程，**不许**塞路径/URL/令牌
   * （`portable-update-service.test.ts` 有一条"只发布脱敏字段"的测试钉着）。
   */
  requiredBytes?: number;
  availableBytes?: number;
  updatedAt: number;
}

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

const MANIFEST_KEYS = [
  'channel',
  'fileManifestSha256',
  'mandatory',
  'minLauncherVersion',
  'packageSha256',
  'packageSize',
  'packageUrl',
  'publishedAt',
  'schemaVersion',
  'signature',
  'version',
] as const;

const FILE_MANIFEST_KEYS = ['files', 'schemaVersion', 'version'] as const;
const FILE_ENTRY_KEYS = ['path', 'sha256', 'size'] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) {
    throw new Error('Object fields do not match the portable update schema');
  }
}

function assertStrictSemver(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !SEMVER_PATTERN.test(value)) {
    throw new Error(`${field} must be a strict semantic version`);
  }
}

function assertSha256(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new Error(`${field} must be a lowercase SHA-256 digest`);
  }
}

function assertSafeInteger(value: unknown, field: string, minimum: number): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${field} must be a safe integer greater than or equal to ${minimum}`);
  }
}

function canonicalize(value: unknown, ancestors: Set<object>): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      throw new Error('Canonical JSON accepts only finite safe integers');
    }
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') {
    throw new Error('Unsupported canonical JSON value');
  }
  if (ancestors.has(value)) {
    throw new Error('Canonical JSON cannot contain cyclic values');
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => canonicalize(entry, ancestors)).join(',')}]`;
    }
    if (!isPlainObject(value)) {
      throw new Error('Canonical JSON accepts only plain objects');
    }
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key], ancestors)}`)
      .join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalizeJson(value: unknown): string {
  return canonicalize(value, new Set());
}

export function parsePortableUpdateManifest(value: unknown): PortableUpdateManifestV1 {
  if (!isPlainObject(value)) throw new Error('Portable update manifest must be an object');
  assertExactKeys(value, MANIFEST_KEYS);

  if (value.schemaVersion !== PORTABLE_UPDATE_SCHEMA_VERSION) {
    throw new Error('Unsupported portable update manifest schema');
  }
  if (value.channel !== 'stable' && value.channel !== 'internal') {
    throw new Error('Invalid portable update channel');
  }
  assertStrictSemver(value.version, 'version');
  assertStrictSemver(value.minLauncherVersion, 'minLauncherVersion');
  if (typeof value.packageUrl !== 'string') throw new Error('packageUrl must be a string');
  let packageUrl: URL;
  try {
    packageUrl = new URL(value.packageUrl);
  } catch {
    throw new Error('packageUrl must be a valid URL');
  }
  if (packageUrl.protocol !== 'https:' || packageUrl.username || packageUrl.password) {
    throw new Error('packageUrl must be an HTTPS URL without credentials');
  }
  assertSafeInteger(value.packageSize, 'packageSize', 1);
  assertSha256(value.packageSha256, 'packageSha256');
  assertSha256(value.fileManifestSha256, 'fileManifestSha256');
  if (
    typeof value.publishedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.publishedAt)) ||
    new Date(value.publishedAt).toISOString() !== value.publishedAt
  ) {
    throw new Error('publishedAt must be a canonical ISO timestamp');
  }
  if (value.mandatory !== false) throw new Error('Mandatory portable updates are not supported');
  if (typeof value.signature !== 'string' || value.signature.length === 0 || !SIGNATURE_PATTERN.test(value.signature)) {
    throw new Error('signature must be a non-empty Base64 string');
  }

  return {
    schemaVersion: PORTABLE_UPDATE_SCHEMA_VERSION,
    channel: value.channel,
    version: value.version,
    minLauncherVersion: value.minLauncherVersion,
    packageUrl: value.packageUrl,
    packageSize: value.packageSize,
    packageSha256: value.packageSha256,
    fileManifestSha256: value.fileManifestSha256,
    publishedAt: value.publishedAt,
    mandatory: false,
    signature: value.signature,
  };
}

function parseFileEntry(value: unknown): PortableUpdateFileEntry {
  if (!isPlainObject(value)) throw new Error('Portable update file entry must be an object');
  assertExactKeys(value, FILE_ENTRY_KEYS);
  if (
    typeof value.path !== 'string' ||
    value.path.length === 0 ||
    value.path.includes('\\') ||
    value.path.startsWith('/') ||
    /^[A-Za-z]:/.test(value.path) ||
    value.path.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error('Portable update file path must be a safe relative path');
  }
  assertSafeInteger(value.size, 'size', 0);
  assertSha256(value.sha256, 'sha256');
  return { path: value.path, size: value.size, sha256: value.sha256 };
}

export function parsePortableFileManifest(value: unknown): PortableUpdateFileManifestV1 {
  if (!isPlainObject(value)) throw new Error('Portable file manifest must be an object');
  assertExactKeys(value, FILE_MANIFEST_KEYS);
  if (value.schemaVersion !== PORTABLE_UPDATE_SCHEMA_VERSION) {
    throw new Error('Unsupported portable file manifest schema');
  }
  assertStrictSemver(value.version, 'version');
  if (!Array.isArray(value.files)) throw new Error('files must be an array');
  const files = value.files.map(parseFileEntry);
  if (new Set(files.map((entry) => entry.path)).size !== files.length) {
    throw new Error('Portable file manifest contains duplicate paths');
  }
  return { schemaVersion: PORTABLE_UPDATE_SCHEMA_VERSION, version: value.version, files };
}

const ALLOWED_TRANSITIONS: Readonly<Record<PortableUpdatePhase, readonly PortableUpdatePhase[]>> = {
  idle: ['checking'],
  checking: ['idle', 'available', 'error'],
  available: ['idle', 'downloading', 'error'],
  downloading: ['verifying-archive', 'error'],
  'verifying-archive': ['extracting', 'error'],
  extracting: ['verifying-files', 'error'],
  'verifying-files': ['ready', 'error'],
  ready: ['idle', 'applying', 'error'],
  applying: ['awaiting-health', 'rolled-back', 'error'],
  'awaiting-health': ['committed', 'rolled-back', 'error'],
  committed: ['idle', 'checking'],
  'rolled-back': ['idle', 'checking'],
  error: ['idle', 'checking'],
};

export function assertPortableTransition(from: PortableUpdatePhase, to: PortableUpdatePhase): void {
  if (from === to) return;
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new Error(`Invalid portable update transition: ${from} -> ${to}`);
  }
}

export function toPortableUpdatePublicState(input: PortableUpdatePublicState): PortableUpdatePublicState {
  const output: PortableUpdatePublicState = {
    phase: input.phase,
    currentVersion: input.currentVersion,
    updatedAt: input.updatedAt,
  };
  if (input.targetVersion !== undefined) output.targetVersion = input.targetVersion;
  if (input.transferred !== undefined) output.transferred = input.transferred;
  if (input.total !== undefined) output.total = input.total;
  if (input.percent !== undefined) output.percent = input.percent;
  if (input.errorCode !== undefined) output.errorCode = input.errorCode;
  if (input.requiredBytes !== undefined) output.requiredBytes = input.requiredBytes;
  if (input.availableBytes !== undefined) output.availableBytes = input.availableBytes;
  return output;
}
