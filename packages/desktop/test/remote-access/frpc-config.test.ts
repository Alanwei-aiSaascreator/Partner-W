import { describe, expect, it } from 'vitest';
import {
  FRPC_LOCAL_PORT,
  buildFrpcToml,
  isValidSubdomain,
  short8FromDeviceId,
} from '../../src/main/remote-access/frpc-config.js';

const BASE = {
  serverAddr: '47.119.120.28',
  serverPort: 7000,
  token: 'd7a5935ce28397642a492b3e265869e2dc43264b3e56b351',
  subdomain: '550e8400',
};

describe('short8FromDeviceId', () => {
  it('UUID 去连字符后取前 8 位', () => {
    expect(short8FromDeviceId('550e8400-e29b-41d4-a716-446655440000')).toBe('550e8400');
  });

  it('统一小写，兼容大写输入', () => {
    expect(short8FromDeviceId('ABC12345-0000-0000-0000-000000000000')).toBe('abc12345');
  });

  it('太短的 id 直接拒绝，不生成残缺子域', () => {
    expect(() => short8FromDeviceId('abc-123')).toThrow('too short');
  });
});

describe('isValidSubdomain', () => {
  it.each(['550e8400', 'abcdef12', '00000000'])('接受 %s', (value) => {
    expect(isValidSubdomain(value)).toBe(true);
  });

  it.each(['550e840', '550e84001', 'ABCDEF12', '550e-840', '', 'rym-550e'])('拒绝 %s', (value) => {
    expect(isValidSubdomain(value)).toBe(false);
  });
});

describe('buildFrpcToml', () => {
  it('生成 frps 0.68 认的字段', () => {
    const toml = buildFrpcToml(BASE);
    expect(toml).toContain('serverAddr = "47.119.120.28"');
    expect(toml).toContain('serverPort = 7000');
    expect(toml).toContain('transport.tls.enable = true');
    expect(toml).toContain('auth.method = "token"');
    expect(toml).toContain(`auth.token = "${BASE.token}"`);
    expect(toml).toContain('loginFailExit = false');
    expect(toml).toContain('type = "http"');
    expect(toml).toContain('localIP = "127.0.0.1"');
    expect(toml).toContain(`localPort = ${FRPC_LOCAL_PORT}`);
    expect(toml).toContain('subdomain = "550e8400"');
    expect(toml).toContain('name = "rym-550e8400"');
  });

  it('子域大小写混入时归一成小写（nginx 的正则只认小写）', () => {
    const toml = buildFrpcToml({ ...BASE, subdomain: '550E8400' });
    expect(toml).toContain('subdomain = "550e8400"');
  });

  it('非法子域拒绝生成 —— 写错会连到别人电脑上', () => {
    expect(() => buildFrpcToml({ ...BASE, subdomain: '550e840' })).toThrow('invalid subdomain');
    expect(() => buildFrpcToml({ ...BASE, subdomain: 'abc_defg' })).toThrow('invalid subdomain');
  });

  it('端口与地址做基本校验', () => {
    expect(() => buildFrpcToml({ ...BASE, serverPort: 0 })).toThrow('serverPort');
    expect(() => buildFrpcToml({ ...BASE, serverAddr: ' ' })).toThrow('serverAddr');
    expect(() => buildFrpcToml({ ...BASE, token: '' })).toThrow('token');
  });

  it('token 里的引号被转义，不会撑破 TOML', () => {
    const toml = buildFrpcToml({ ...BASE, token: 'a"b\\c' });
    expect(toml).toContain('auth.token = "a\\"b\\\\c"');
  });
});
