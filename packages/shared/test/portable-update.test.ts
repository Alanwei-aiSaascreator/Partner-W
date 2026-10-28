import { describe, expect, it } from 'vitest';
import {
  assertPortableTransition,
  canonicalizeJson,
  parsePortableFileManifest,
  parsePortableUpdateManifest,
  toPortableUpdatePublicState,
  type PortableUpdatePublicState,
} from '../src/portable-update.js';

const manifest = {
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
  signature: 'c2lnbmF0dXJl',
} as const;

describe('portable update canonical JSON', () => {
  it('sorts object keys recursively while preserving array order and Unicode values', () => {
    expect(
      canonicalizeJson({
        z: ['\u8363\u76c8\u9b54\u65b9', { beta: 2, alpha: 1 }],
        a: true,
      }),
    ).toBe('{"a":true,"z":["\u8363\u76c8\u9b54\u65b9",{"alpha":1,"beta":2}]}');
  });

  it.each([
    ['undefined', undefined],
    ['floating point numbers', 1.5],
    ['unsafe integers', Number.MAX_SAFE_INTEGER + 1],
    ['non-plain objects', new Date('2026-09-21T00:00:00.000Z')],
  ])('rejects %s', (_name, value) => {
    expect(() => canonicalizeJson(value)).toThrow();
  });

  it('rejects cyclic values', () => {
    const value: Record<string, unknown> = {};
    value.self = value;

    expect(() => canonicalizeJson(value)).toThrow(/cyclic/i);
  });
});

describe('portable update manifest parsing', () => {
  it('parses the exact signed manifest schema', () => {
    expect(parsePortableUpdateManifest(manifest)).toEqual(manifest);
  });

  it.each([
    ['unknown fields', { ...manifest, token: 'secret' }],
    ['non-HTTPS package URLs', { ...manifest, packageUrl: 'http://example.com/update.zip' }],
    ['non-canonical hashes', { ...manifest, packageSha256: 'A'.repeat(64) }],
    ['non-integer package sizes', { ...manifest, packageSize: 1.5 }],
    ['non-strict versions', { ...manifest, version: 'v0.0.26' }],
    ['invalid timestamps', { ...manifest, publishedAt: 'yesterday' }],
    ['mandatory updates', { ...manifest, mandatory: true }],
  ])('rejects %s', (_name, value) => {
    expect(() => parsePortableUpdateManifest(value)).toThrow();
  });

  it('parses a strict file manifest', () => {
    const fileManifest = {
      schemaVersion: 1,
      version: '0.0.26',
      files: [
        {
          path: 'app/resources/app.asar',
          size: 4096,
          sha256: 'c'.repeat(64),
        },
      ],
    } as const;

    expect(parsePortableFileManifest(fileManifest)).toEqual(fileManifest);
  });

  it.each([
    {
      schemaVersion: 1,
      version: '0.0.26',
      files: [{ path: '../escape', size: 1, sha256: 'c'.repeat(64) }],
    },
    {
      schemaVersion: 1,
      version: '0.0.26',
      files: [{ path: 'app/file', size: -1, sha256: 'c'.repeat(64) }],
    },
    {
      schemaVersion: 1,
      version: '0.0.26',
      files: [{ path: 'app/file', size: 1, sha256: 'invalid' }],
    },
    {
      schemaVersion: 1,
      version: '0.0.26',
      files: [],
      password: 'secret',
    },
  ])('rejects an unsafe or non-exact file manifest', (value) => {
    expect(() => parsePortableFileManifest(value)).toThrow();
  });
});

describe('portable update phase transitions', () => {
  it.each([
    ['idle', 'checking'],
    ['checking', 'available'],
    ['available', 'downloading'],
    ['downloading', 'verifying-archive'],
    ['verifying-archive', 'extracting'],
    ['extracting', 'verifying-files'],
    ['verifying-files', 'ready'],
    ['ready', 'applying'],
    ['applying', 'awaiting-health'],
    ['awaiting-health', 'committed'],
    ['awaiting-health', 'rolled-back'],
    ['error', 'idle'],
  ] as const)('allows %s -> %s', (from, to) => {
    expect(() => assertPortableTransition(from, to)).not.toThrow();
  });

  it.each([
    ['idle', 'ready'],
    ['checking', 'applying'],
    ['downloading', 'committed'],
    ['committed', 'applying'],
  ] as const)('rejects %s -> %s', (from, to) => {
    expect(() => assertPortableTransition(from, to)).toThrow(/transition/i);
  });
});

describe('portable update public state', () => {
  it('returns an exact allowlist and removes secret or filesystem metadata', () => {
    const input = {
      phase: 'downloading',
      currentVersion: '0.0.25',
      targetVersion: '0.0.26',
      transferred: 256,
      total: 1024,
      percent: 25,
      errorCode: 'network',
      updatedAt: 1_758_409_200_000,
      token: 'secret-token',
      password: 'secret-password',
      privateKey: 'secret-key',
      stagingPath: 'E:/private/staging',
      packageUrl: 'https://example.com/private.zip',
      signature: 'secret-signature',
      detail: 'raw upstream error',
    } as PortableUpdatePublicState & Record<string, unknown>;

    const state = toPortableUpdatePublicState(input);

    expect(state).toEqual({
      phase: 'downloading',
      currentVersion: '0.0.25',
      targetVersion: '0.0.26',
      transferred: 256,
      total: 1024,
      percent: 25,
      errorCode: 'network',
      updatedAt: 1_758_409_200_000,
    });
    expect(Object.keys(state).some((key) => /token|password|key|path|url|signature/i.test(key))).toBe(false);
  });
});
