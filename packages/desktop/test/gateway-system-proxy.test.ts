import fs from 'node:fs';
import { hostname } from 'node:os';
import { describe, expect, it, vi } from 'vitest';

async function helper() {
  expect(fs.existsSync(new URL('../src/main/runtime/gateway-proxy.ts', import.meta.url))).toBe(true);
  return import('../src/main/runtime/gateway-proxy.js');
}

describe('runtime child Windows static proxy inheritance', () => {
  it.each(['localhost,*', 'localhost\r\n*', 'localhost\t*', '*', 'corp*', '256.*', 'localhost:65536'])(
    'does not guess routing from unsupported or unsafe bypass rules %j',
    async (bypass) => {
      const { applyWindowsStaticProxy } = await helper();
      expect(applyWindowsStaticProxy({ PATH: 'node' }, { enabled: true, server: 'localhost:7890', bypass })).toEqual({
        PATH: 'node',
      });
    },
  );

  it.each([
    'ProxyEnable REG_DWORD 0x1\nProxyServer REG_SZ localhost:7890\nAutoConfigURL REG_SZ https://proxy.test/routes.pac\n',
    'ProxyEnable REG_DWORD 0x1\nProxyServer REG_SZ localhost:7890\nAutoDetect REG_DWORD 0x1\n',
  ])('does not replace PAC or auto-detection policy with guessed static routing', async (output) => {
    const { readWindowsStaticProxy } = await helper();
    expect(readWindowsStaticProxy(() => output)).toBeNull();
  });
  it('retains Windows direct/bypass rules supported by the actual runtime NO_PROXY matcher', async () => {
    const { applyWindowsStaticProxy } = await helper();
    const result = applyWindowsStaticProxy(
      {},
      { enabled: true, server: 'localhost:7890', bypass: 'localhost;127.*;10.*;*.company.test;<local>' },
    );
    expect(result.NO_PROXY?.split(',')).toEqual([
      'localhost',
      '127.0.0.1',
      '::1',
      '127.*',
      '10.*',
      '*.company.test',
      hostname(),
    ]);
  });

  it('reads configured Windows proxy bypass rules without changing them globally', async () => {
    const { readWindowsStaticProxy } = await helper();
    expect(
      readWindowsStaticProxy(
        () =>
          'ProxyEnable REG_DWORD 0x1\nProxyServer REG_SZ localhost:7890\nProxyOverride REG_SZ localhost;127.*;<local>\n',
      ),
    ).toEqual({ enabled: true, server: 'localhost:7890', bypass: 'localhost;127.*;<local>' });
  });
  it('inherits a valid enabled static server without modifying its input or credentials', async () => {
    const { applyWindowsStaticProxy } = await helper();
    const input = { PATH: 'node-path', OPENCLAW_GATEWAY_TOKEN: 'fixture-auth-token' };
    expect(applyWindowsStaticProxy(input, { enabled: true, server: '127.0.0.1:7890' })).toEqual({
      ...input,
      HTTP_PROXY: 'http://127.0.0.1:7890',
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      NO_PROXY: 'localhost,127.0.0.1,::1',
    });
    expect(input).toEqual({ PATH: 'node-path', OPENCLAW_GATEWAY_TOKEN: 'fixture-auth-token' });
  });

  it('respects distinct per-scheme Windows routes and leaves unconfigured schemes direct', async () => {
    const { applyWindowsStaticProxy } = await helper();
    expect(
      applyWindowsStaticProxy(
        {},
        { enabled: true, server: 'http=proxy.test:80;https=https://secure.test:443;socks=localhost:1080' },
      ),
    ).toEqual({
      HTTP_PROXY: 'http://proxy.test:80',
      HTTPS_PROXY: 'https://secure.test:443',
      NO_PROXY: 'localhost,127.0.0.1,::1',
    });
    expect(applyWindowsStaticProxy({}, { enabled: true, server: 'https=[::1]:7890' })).toEqual({
      HTTPS_PROXY: 'http://[::1]:7890',
      NO_PROXY: 'localhost,127.0.0.1,::1',
    });
  });

  it.each(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'])(
    'preserves explicit process routing %s',
    async (key) => {
      const { applyWindowsStaticProxy, inheritWindowsSystemProxy } = await helper();
      const input = { [key]: '' };
      expect(applyWindowsStaticProxy(input, { enabled: true, server: 'localhost:7890' })).toEqual(input);
      const read = vi.fn();
      expect(inheritWindowsSystemProxy(input, read, 'win32')).toEqual(input);
      expect(read).not.toHaveBeenCalled();
    },
  );

  it.each([
    { enabled: false, server: 'localhost:7890' },
    { enabled: true, server: '' },
    { enabled: true, server: 'localhost:0' },
    { enabled: true, server: 'localhost:65536' },
    { enabled: true, server: 'http://user:secret@proxy.test:80' },
    { enabled: true, server: 'http://proxy.test:80/path' },
    { enabled: true, server: 'https=proxy.test:80;https=other.test:80' },
    { enabled: true, server: 'http=proxy.test:80;invalid' },
    { enabled: true, server: 'socks=localhost:1080' },
  ])('does not invent a proxy for disabled or malformed settings %j', async (settings) => {
    const { applyWindowsStaticProxy } = await helper();
    expect(applyWindowsStaticProxy({ PATH: 'node' }, settings)).toEqual({ PATH: 'node' });
  });

  it('does not read system settings on another platform', async () => {
    const { inheritWindowsSystemProxy } = await helper();
    const read = vi.fn();
    expect(inheritWindowsSystemProxy({ PATH: 'node' }, read, 'darwin')).toEqual({ PATH: 'node' });
    expect(read).not.toHaveBeenCalled();
  });

  it('parses only Windows enabled static routing and fails closed when registry access fails', async () => {
    const { readWindowsStaticProxy } = await helper();
    const read = vi.fn(
      () => '    ProxyEnable    REG_DWORD    0x1\n    ProxyServer    REG_SZ    https=localhost:7890\n',
    );
    expect(readWindowsStaticProxy(read)).toEqual({ enabled: true, server: 'https=localhost:7890' });
    expect(read.mock.calls[0]).toEqual([
      'reg.exe',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
    ]);
    expect(
      readWindowsStaticProxy(() => {
        throw new Error('registry unavailable');
      }),
    ).toBeNull();
  });
});
