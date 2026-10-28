import { describe, expect, it } from 'vitest';
import {
  buildMobileQrPayload,
  decodeSetupCode,
  encodeSetupCode,
  normalizePublicWssUrl,
} from '../../src/main/remote-access/pairing-payload.js';

const SETUP_CODE = Buffer.from(
  JSON.stringify({ url: 'ws://127.0.0.1:18789', bootstrapToken: 'boot-abc' }),
  'utf8',
).toString('base64');

describe('normalizePublicWssUrl', () => {
  it('归一到 origin + 斜杠', () => {
    expect(() => normalizePublicWssUrl('wss://abc12345.rym.example.com/app/?x=1')).toThrow('query');
    expect(normalizePublicWssUrl('wss://abc12345.rym.example.com/app/')).toBe('wss://abc12345.rym.example.com/');
  });

  it('拒绝明文 ws / https', () => {
    expect(() => normalizePublicWssUrl('ws://abc.example.com/')).toThrow('wss://');
    expect(() => normalizePublicWssUrl('https://abc.example.com/')).toThrow('wss://');
  });

  it('拒绝 loopback —— 手机会连自己', () => {
    expect(() => normalizePublicWssUrl('wss://127.0.0.1:18789/')).toThrow('loopback');
    expect(() => normalizePublicWssUrl('wss://localhost/')).toThrow('loopback');
    expect(() => normalizePublicWssUrl('wss://[::1]/')).toThrow('loopback');
    expect(() => normalizePublicWssUrl('wss://app.localhost/')).toThrow('loopback');
  });

  it('空值与非 URL 直接拒绝', () => {
    expect(() => normalizePublicWssUrl('   ')).toThrow('required');
    expect(() => normalizePublicWssUrl('not a url')).toThrow('valid URL');
  });
});

describe('setup code 编解码', () => {
  it('解码网关格式并保留 bootstrapToken', () => {
    expect(decodeSetupCode(SETUP_CODE)).toEqual({
      url: 'ws://127.0.0.1:18789',
      urls: undefined,
      bootstrapToken: 'boot-abc',
    });
  });

  it('往返保持字段', () => {
    const encoded = encodeSetupCode({ url: 'wss://h/', bootstrapToken: 't', urls: ['wss://h2/'] });
    expect(decodeSetupCode(encoded)).toEqual({
      url: 'wss://h/',
      urls: ['wss://h2/'],
      bootstrapToken: 't',
    });
  });

  it('拒绝非 base64 / 缺字段', () => {
    expect(() => decodeSetupCode('not-base64-json')).toThrow();
    const noToken = Buffer.from(JSON.stringify({ url: 'wss://h/' }), 'utf8').toString('base64');
    expect(() => decodeSetupCode(noToken)).toThrow('bootstrapToken');
  });
});

describe('buildMobileQrPayload', () => {
  it('把 url 覆写成公网地址、token 原样保留', () => {
    const payload = buildMobileQrPayload({
      setupCode: SETUP_CODE,
      publicUrl: 'wss://abc12345.rym.example.com',
      gatewayName: '办公室-联想',
      deviceId: 'desktop-1',
    });

    expect(payload.v).toBe(2);
    expect(payload.s).toBe('desktop-1');
    expect(payload.g).toHaveLength(1);
    expect(payload.g[0]).toMatchObject({
      n: '办公室-联想',
      u: 'wss://abc12345.rym.example.com/',
      m: 'setupCode',
    });

    const inner = decodeSetupCode(payload.g[0].c);
    expect(inner.url).toBe('wss://abc12345.rym.example.com/');
    expect(inner.bootstrapToken).toBe('boot-abc');
  });

  it('payload 里不存在任何长期凭据字段', () => {
    const payload = buildMobileQrPayload({
      setupCode: SETUP_CODE,
      publicUrl: 'wss://abc12345.rym.example.com',
      gatewayName: 'X',
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('"t"');
    expect(serialized).not.toContain('"p"');
    expect(serialized).not.toContain('boot-abc'); // 只允许出现在 setup code 内部（base64）
  });

  it('gatewayName 为空直接拒绝', () => {
    expect(() =>
      buildMobileQrPayload({
        setupCode: SETUP_CODE,
        publicUrl: 'wss://abc12345.rym.example.com',
        gatewayName: '  ',
      }),
    ).toThrow('gatewayName');
  });
});
