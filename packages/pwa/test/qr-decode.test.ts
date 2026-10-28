import { describe, it, expect } from 'vitest';
import { parseQrPayload } from '../src/lib/qr-decode';

const legacy = { allowLegacyCredentials: true } as const;
const production = { allowLegacyCredentials: false } as const;

describe('parseQrPayload · v2（生产格式）', () => {
  const setupCode = btoa(JSON.stringify({ url: 'wss://abc12345.rym.example.com/', bootstrapToken: 'boot-1' }));

  it('parses a setupCode payload', () => {
    const raw = JSON.stringify({
      v: 2,
      s: 'desktop-device-id',
      g: [{ n: '办公室-联想', u: 'wss://abc12345.rym.example.com/', m: 'setupCode', c: setupCode }],
    });
    const result = parseQrPayload(raw, production);
    expect(result.v).toBe(2);
    expect(result.s).toBe('desktop-device-id');
    expect(result.g).toHaveLength(1);
    expect(result.g[0].m).toBe('setupCode');
    expect(result.g[0].c).toBe(setupCode);
  });

  it('rejects v2 with ws:// (remote pairing must be encrypted)', () => {
    const raw = JSON.stringify({
      v: 2,
      g: [{ n: 'X', u: 'ws://abc12345.rym.example.com/', m: 'setupCode', c: setupCode }],
    });
    expect(() => parseQrPayload(raw, production)).toThrow('must use wss://');
  });

  it('rejects v2 without setupCode mode', () => {
    const raw = JSON.stringify({
      v: 2,
      g: [{ n: 'X', u: 'wss://host/', m: 'token', c: setupCode }],
    });
    expect(() => parseQrPayload(raw, production)).toThrow('v2 requires setupCode auth mode');
  });

  it('rejects v2 carrying plaintext credentials', () => {
    const raw = JSON.stringify({
      v: 2,
      g: [{ n: 'X', u: 'wss://host/', m: 'setupCode', c: setupCode, t: 'gateway-token' }],
    });
    expect(() => parseQrPayload(raw, production)).toThrow('must not carry plaintext credentials');
  });

  it('rejects v2 without a code', () => {
    const raw = JSON.stringify({ v: 2, g: [{ n: 'X', u: 'wss://host/', m: 'setupCode' }] });
    expect(() => parseQrPayload(raw, production)).toThrow('missing setup code');
  });
});

describe('parseQrPayload · v1（仅调试）', () => {
  it('parses valid payload with scope ID', () => {
    const raw = JSON.stringify({
      v: 1,
      s: 'abc123',
      g: [{ u: 'wss://server:18789', t: 'token-abc', n: 'Home OC' }],
    });
    const result = parseQrPayload(raw, legacy);
    expect(result.v).toBe(1);
    expect(result.s).toBe('abc123');
    expect(result.g).toHaveLength(1);
    expect(result.g[0].n).toBe('Home OC');
  });

  it('allows missing scope ID', () => {
    const raw = JSON.stringify({ v: 1, g: [{ u: 'wss://server:18789', t: 'tok', n: 'Test' }] });
    const result = parseQrPayload(raw, legacy);
    expect(result.s).toBeUndefined();
    expect(result.g).toHaveLength(1);
  });

  it('parses password-mode gateways', () => {
    const raw = JSON.stringify({
      v: 1,
      s: 'abc123',
      g: [{ u: 'wss://server:18789', p: 'pw', m: 'password', n: 'Home' }],
    });
    const result = parseQrPayload(raw, legacy);
    expect(result.g[0].m).toBe('password');
    expect(result.g[0].p).toBe('pw');
  });

  it('parses multiple gateways', () => {
    const raw = JSON.stringify({
      v: 1,
      s: 'abc123',
      g: [
        { u: 'wss://a:18789', t: 't1', n: 'A' },
        { u: 'ws://b:18789', t: 't2', n: 'B' },
      ],
    });
    expect(parseQrPayload(raw, legacy).g).toHaveLength(2);
  });

  it('is rejected in production builds', () => {
    const raw = JSON.stringify({ v: 1, g: [{ u: 'wss://h:18789', t: 'tok', n: 'X' }] });
    expect(() => parseQrPayload(raw, production)).toThrow('plaintext credentials are not allowed');
  });
});

describe('parseQrPayload · 通用校验', () => {
  it('rejects invalid JSON', () => {
    expect(() => parseQrPayload('not json', production)).toThrow('not valid JSON');
  });

  it('rejects unsupported version', () => {
    expect(() => parseQrPayload(JSON.stringify({ v: 99, g: [] }), production)).toThrow('Unsupported QR version');
  });

  it('rejects missing gateways', () => {
    expect(() => parseQrPayload(JSON.stringify({ v: 1, s: 'abc123', g: [] }), legacy)).toThrow('no gateways');
  });

  it('rejects invalid gateway URL scheme', () => {
    const raw = JSON.stringify({ v: 1, s: 'abc123', g: [{ u: 'http://bad', t: 'tok', n: 'Bad' }] });
    expect(() => parseQrPayload(raw, legacy)).toThrow('ws:// or wss://');
  });
});
