import { createPublicKey, verify } from 'node:crypto';
import {
  canonicalizeJson,
  parsePortableUpdateManifest,
  type PortableUpdateChannel,
  type PortableUpdateErrorCode,
  type PortableUpdateManifestV1,
} from '@clawwork/shared';

export class PortableUpdateFailure extends Error {
  readonly code: PortableUpdateErrorCode;

  constructor(code: PortableUpdateErrorCode) {
    super(code);
    this.name = 'PortableUpdateFailure';
    this.code = code;
  }
}

interface SemanticVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function decodeBase64(value: string): Buffer {
  if (value.length === 0 || !BASE64_PATTERN.test(value)) {
    throw new PortableUpdateFailure('signature-invalid');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) {
    throw new PortableUpdateFailure('signature-invalid');
  }
  return decoded;
}

/**
 * ⚠️ 导出是给 `launcher-version.ts` 用的（探测盘上启动器 `--version` 的返回值）。
 * 让"清单认什么版本"与"探测认什么版本"共用同一份定义，两边就不会漂移成两套判据。
 */
export function parseSemanticVersion(value: string): SemanticVersion {
  const match = SEMVER_PATTERN.exec(value);
  if (!match) throw new PortableUpdateFailure('manifest-invalid');
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split('.') ?? [],
  };
}

function comparePrerelease(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) {
    return left.length === right.length ? 0 : left.length === 0 ? 1 : -1;
  }
  const count = Math.max(left.length, right.length);
  for (let index = 0; index < count; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined || rightPart === undefined) {
      return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1;
    }
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) < Number(rightPart) ? -1 : 1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function compareSemanticVersions(left: string, right: string): number {
  const a = parseSemanticVersion(left);
  const b = parseSemanticVersion(right);
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

function signedPayload(rawManifest: unknown): { payload: Record<string, unknown>; signature: string } {
  if (
    rawManifest === null ||
    typeof rawManifest !== 'object' ||
    Array.isArray(rawManifest) ||
    (Object.getPrototypeOf(rawManifest) !== Object.prototype && Object.getPrototypeOf(rawManifest) !== null)
  ) {
    throw new PortableUpdateFailure('manifest-invalid');
  }
  const { signature, ...payload } = rawManifest as Record<string, unknown>;
  if (typeof signature !== 'string') {
    throw new PortableUpdateFailure('signature-invalid');
  }
  return { payload, signature };
}

function verifyManifestSignature(rawManifest: unknown, publicKeyBase64: string): Record<string, unknown> {
  const { payload, signature } = signedPayload(rawManifest);
  try {
    const publicKey = createPublicKey({
      key: decodeBase64(publicKeyBase64),
      type: 'spki',
      format: 'der',
    });
    const valid = verify(null, Buffer.from(canonicalizeJson(payload), 'utf8'), publicKey, decodeBase64(signature));
    if (!valid) throw new PortableUpdateFailure('signature-invalid');
    return payload;
  } catch (error) {
    if (error instanceof PortableUpdateFailure) throw error;
    throw new PortableUpdateFailure('signature-invalid');
  }
}

export function verifyAndDecidePortableUpdate(input: {
  rawManifest: unknown;
  publicKeyBase64: string;
  currentVersion: string;
  currentChannel: PortableUpdateChannel;
  launcherVersion: string;
}): { kind: 'available'; manifest: PortableUpdateManifestV1 } | { kind: 'current' } {
  const payload = verifyManifestSignature(input.rawManifest, input.publicKeyBase64);
  if (payload.mandatory === true) {
    throw new PortableUpdateFailure('unsupported-policy');
  }

  let manifest: PortableUpdateManifestV1;
  try {
    manifest = parsePortableUpdateManifest(input.rawManifest);
  } catch {
    throw new PortableUpdateFailure('manifest-invalid');
  }
  if (manifest.channel !== input.currentChannel) {
    throw new PortableUpdateFailure('manifest-invalid');
  }
  if (compareSemanticVersions(input.launcherVersion, manifest.minLauncherVersion) < 0) {
    throw new PortableUpdateFailure('launcher-incompatible');
  }
  if (compareSemanticVersions(manifest.version, input.currentVersion) <= 0) {
    return { kind: 'current' };
  }
  return { kind: 'available', manifest };
}
