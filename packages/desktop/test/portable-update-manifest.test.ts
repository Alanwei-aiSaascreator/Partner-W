import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalizeJson, type PortableUpdateManifestV1 } from '@clawwork/shared';
import { PortableUpdateFailure, verifyAndDecidePortableUpdate } from '../src/main/update/portable-manifest.js';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const publicKeyBase64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

const unsignedManifest: Omit<PortableUpdateManifestV1, 'signature'> = {
  schemaVersion: 1,
  channel: 'internal',
  version: '0.0.26',
  minLauncherVersion: '1.0.0',
  packageUrl: 'https://api.rongyinghudong.com/updates/internal/0.0.26/portable.zip',
  packageSize: 1024,
  packageSha256: 'a'.repeat(64),
  fileManifestSha256: 'b'.repeat(64),
  publishedAt: '2026-09-21T00:00:00.000Z',
  mandatory: false,
};

function signManifest(overrides: Partial<typeof unsignedManifest> = {}): PortableUpdateManifestV1 {
  const payload = { ...unsignedManifest, ...overrides };
  const signature = sign(null, Buffer.from(canonicalizeJson(payload)), privateKey).toString('base64');
  return { ...payload, signature } as PortableUpdateManifestV1;
}

function decide(rawManifest: unknown, overrides: Partial<Parameters<typeof verifyAndDecidePortableUpdate>[0]> = {}) {
  return verifyAndDecidePortableUpdate({
    rawManifest,
    publicKeyBase64,
    currentVersion: '0.0.25',
    currentChannel: 'internal',
    launcherVersion: '1.0.0',
    ...overrides,
  });
}

function expectFailure(action: () => unknown, code: PortableUpdateFailure['code']): void {
  try {
    action();
    throw new Error('Expected portable update verification to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(PortableUpdateFailure);
    expect(error).toMatchObject({ code });
    expect(Object.keys(error as object).sort()).toEqual(['code', 'name']);
  }
}

describe('portable update manifest verification', () => {
  it('accepts a valid signature and a newer version on the same channel', () => {
    const manifest = signManifest();

    expect(decide(manifest)).toEqual({ kind: 'available', manifest });
  });

  it('rejects a one-byte mutation after signing', () => {
    const manifest = signManifest();

    expectFailure(() => decide({ ...manifest, version: '0.0.27' }), 'signature-invalid');
  });

  it('rejects malformed Base64 signatures', () => {
    expectFailure(() => decide({ ...signManifest(), signature: '***' }), 'signature-invalid');
  });

  it.each(['0.0.25', '0.0.24'])('treats version %s as current', (version) => {
    expect(decide(signManifest({ version }))).toEqual({ kind: 'current' });
  });

  it('rejects a signed manifest from another channel', () => {
    expectFailure(() => decide(signManifest({ channel: 'stable' })), 'manifest-invalid');
  });

  it('rejects mandatory update policy even when correctly signed', () => {
    const payload = { ...unsignedManifest, mandatory: true };
    const signature = sign(null, Buffer.from(canonicalizeJson(payload)), privateKey).toString('base64');

    expectFailure(() => decide({ ...payload, signature }), 'unsupported-policy');
  });

  it('rejects a manifest that requires a newer launcher', () => {
    expectFailure(() => decide(signManifest({ minLauncherVersion: '1.1.0' })), 'launcher-incompatible');
  });

  it('fails closed when the build-time public key is missing', () => {
    expectFailure(() => decide(signManifest(), { publicKeyBase64: '' }), 'signature-invalid');
  });
});
