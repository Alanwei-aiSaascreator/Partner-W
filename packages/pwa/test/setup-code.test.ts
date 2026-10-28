import { describe, it, expect } from 'vitest';
import { isSameGatewayHost, parseSetupCode } from '../src/lib/setup-code';

function encode(payload: unknown): string {
  return btoa(JSON.stringify(payload));
}

describe('parseSetupCode', () => {
  it('parses a valid setup code', () => {
    const code = encode({ url: 'wss://abc12345.rym.example.com/', bootstrapToken: 'boot-abc' });
    expect(parseSetupCode(code)).toEqual({
      url: 'wss://abc12345.rym.example.com/',
      urls: undefined,
      bootstrapToken: 'boot-abc',
    });
  });

  it('accepts base64url alphabet', () => {
    const json = JSON.stringify({ url: 'wss://h/', bootstrapToken: 'tok+/=' });
    const base64 = btoa(json).replace(/\+/g, '-').replace(/\//g, '_');
    expect(parseSetupCode(base64).bootstrapToken).toBe('tok+/=');
  });

  it('accepts data: prefixed payload', () => {
    const code = `data:application/json;base64,${encode({ url: 'wss://h/', bootstrapToken: 't' })}`;
    expect(parseSetupCode(code).bootstrapToken).toBe('t');
  });

  it('keeps urls when present', () => {
    const code = encode({ url: 'wss://h/', urls: ['wss://h2/', 42], bootstrapToken: 't' });
    expect(parseSetupCode(code).urls).toEqual(['wss://h2/']);
  });

  it('rejects empty input', () => {
    expect(() => parseSetupCode('   ')).toThrow('empty');
  });

  it('rejects non-base64 input', () => {
    expect(() => parseSetupCode('{"url":"wss://h/"}')).toThrow('not base64');
  });

  it('rejects non-JSON payload', () => {
    expect(() => parseSetupCode(btoa('not json'))).toThrow('not JSON');
  });

  it('rejects non-wss url', () => {
    const code = encode({ url: 'ws://h/', bootstrapToken: 't' });
    expect(() => parseSetupCode(code)).toThrow('must use wss://');
  });

  it('rejects missing bootstrapToken', () => {
    const code = encode({ url: 'wss://h/' });
    expect(() => parseSetupCode(code)).toThrow('missing bootstrapToken');
  });
});

describe('isSameGatewayHost', () => {
  it('matches the same host regardless of path', () => {
    expect(isSameGatewayHost('wss://a.example.com/app/', 'wss://a.example.com/')).toBe(true);
  });

  it('treats implicit 443 as wss default', () => {
    expect(isSameGatewayHost('wss://a.example.com/', 'wss://a.example.com:443/')).toBe(true);
  });

  it('rejects a different host', () => {
    expect(isSameGatewayHost('wss://evil.example.com/', 'wss://a.example.com/')).toBe(false);
  });

  it('rejects malformed urls', () => {
    expect(isSameGatewayHost('not-a-url', 'wss://a/')).toBe(false);
  });
});
