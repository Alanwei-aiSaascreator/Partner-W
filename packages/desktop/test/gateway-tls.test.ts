import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 这组用例钉住的是**注入方式**，不是 win-ca 本身：
 * 必须走 `lib/fallback` + `lib/save` + `lib/inject` 三个子模块，**不能** require 主入口
 * —— 主入口在被 require 时会自己 `{inject:true,$ave:true}`，把证书写进**安装目录**里的
 * `node_modules/win-ca/pem`。装到 Program Files 这类只读位置时那次写入会抛 EPERM，
 * 且 win-ca 用的是没接 error 事件的 createWriteStream ⇒ 主进程未捕获异常、应用起不来
 * （2026-09-18 实机崩溃）。详见 `src/main/ws/tls-trust.ts` 的注释。
 */
const mocks = vi.hoisted(() => {
  const run = vi.fn();
  const save = vi.fn();
  const inject = vi.fn();
  const saveFactory = vi.fn(() => save);
  const injectFactory = vi.fn(() => inject);
  const engineFactory = vi.fn(() => ({ run }));
  const requireMock = Object.assign(
    vi.fn((rawId: string) => {
      // Windows 上 join() 出的是反斜杠，先归一化再匹配
      const id = rawId.split('\\').join('/');
      if (id.includes('lib/fallback')) return { async: engineFactory };
      if (id.includes('lib/save')) return saveFactory;
      if (id.includes('lib/inject')) return injectFactory;
      throw new Error(`unexpected require: ${rawId}`);
    }),
    { resolve: vi.fn(() => join('C:', 'app', 'node_modules', 'win-ca', 'package.json')) },
  );
  return { run, save, inject, saveFactory, injectFactory, engineFactory, requireMock };
});

vi.mock('node:module', () => ({
  createRequire: vi.fn(() => mocks.requireMock),
}));

describe('ensureGatewayWindowsSystemTrust', () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const tempDirs: string[] = [];

  const makeTempDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'win-ca-test-'));
    tempDirs.push(dir);
    return dir;
  };

  const originalSystemCertEnv = process.env.PARTNERW_SYSTEM_CERT_STORE;

  beforeEach(() => {
    delete process.env.PARTNERW_SYSTEM_CERT_STORE;
    vi.resetModules();
    for (const fn of [
      mocks.run,
      mocks.save,
      mocks.inject,
      mocks.saveFactory,
      mocks.injectFactory,
      mocks.engineFactory,
    ]) {
      fn.mockClear();
    }
    mocks.requireMock.mockClear();
  });

  afterEach(() => {
    if (platformDescriptor) {
      Object.defineProperty(process, 'platform', platformDescriptor);
    }
    if (originalSystemCertEnv === undefined) delete process.env.PARTNERW_SYSTEM_CERT_STORE;
    else process.env.PARTNERW_SYSTEM_CERT_STORE = originalSystemCertEnv;
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // 2026-10-19（360 误报治理）：win-ca 的 fallback 引擎会 execFile 一个**未签名**的
  // roots.exe。对杀软启发式而言这是"未签名程序启动未签名程序 + 读证书库"。
  // 我们的 relay/更新域名都是公共 CA，不需要企业 MITM 根证书 ⇒ 默认不跑。
  it('⭐ 默认不加载系统证书库（不执行未签名的 roots.exe）', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });

    const { ensureGatewayWindowsSystemTrust } = await import('../src/main/ws/tls-trust.js');
    ensureGatewayWindowsSystemTrust(makeTempDir());

    expect(mocks.requireMock).not.toHaveBeenCalled();
  });

  it('显式开启（PARTNERW_SYSTEM_CERT_STORE=1）才加载', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
    process.env.PARTNERW_SYSTEM_CERT_STORE = '1';

    const { ensureGatewayWindowsSystemTrust } = await import('../src/main/ws/tls-trust.js');
    ensureGatewayWindowsSystemTrust(makeTempDir());

    expect(mocks.requireMock).toHaveBeenCalledTimes(3);
  });

  it('在 Windows 上：只 require 三个子模块（不碰主入口），证书逐张保存+注入', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
    process.env.PARTNERW_SYSTEM_CERT_STORE = '1';

    const { ensureGatewayWindowsSystemTrust } = await import('../src/main/ws/tls-trust.js');
    const userDataDir = makeTempDir();

    ensureGatewayWindowsSystemTrust(userDataDir);

    // 主入口绝不能被 require —— 那会触发写安装目录的自动保存。
    // 归一化后逐个比对：任何一次加载主入口都会让这条断言红。
    const loaded = mocks.requireMock.mock.calls.map(([id]) =>
      String(id).split('\\').join('/').split('/').slice(-2).join('/'),
    );
    expect(loaded).toEqual(['lib/fallback', 'lib/save', 'lib/inject']);
    expect(mocks.saveFactory).toHaveBeenCalledWith({ save: join(userDataDir, 'win-ca-pem') });
    expect(mocks.injectFactory).toHaveBeenCalledWith('+');
    expect(mocks.engineFactory).toHaveBeenCalledWith([]);

    // 引擎回调：两张证书 + 一次收尾
    const onCert = mocks.run.mock.calls[0]?.[0] as (der: unknown) => void;
    expect(typeof onCert).toBe('function');
    onCert(Buffer.from('der-1'));
    onCert(Buffer.from('der-2'));
    onCert(undefined);

    expect(mocks.save).toHaveBeenCalledTimes(2);
    expect(mocks.inject).toHaveBeenCalledTimes(2);
  });

  it('重复调用只初始化一次', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
    process.env.PARTNERW_SYSTEM_CERT_STORE = '1';

    const { ensureGatewayWindowsSystemTrust } = await import('../src/main/ws/tls-trust.js');
    const userDataDir = makeTempDir();

    ensureGatewayWindowsSystemTrust(userDataDir);
    ensureGatewayWindowsSystemTrust(userDataDir);

    expect(mocks.requireMock).toHaveBeenCalledTimes(3);
  });

  it('非 Windows 平台什么都不做', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' });

    const { ensureGatewayWindowsSystemTrust } = await import('../src/main/ws/tls-trust.js');

    ensureGatewayWindowsSystemTrust(makeTempDir());

    expect(mocks.requireMock).not.toHaveBeenCalled();
  });

  it('保存目录建不出来时整件事跳过（fail-soft，不惊动 win-ca）', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
    process.env.PARTNERW_SYSTEM_CERT_STORE = '1';

    const { ensureGatewayWindowsSystemTrust } = await import('../src/main/ws/tls-trust.js');
    // 把一个普通文件当父目录 ⇒ mkdir 必失败
    const filePath = join(makeTempDir(), 'not-a-dir');
    writeFileSync(filePath, 'x');

    expect(() => ensureGatewayWindowsSystemTrust(filePath)).not.toThrow();
    expect(mocks.requireMock).not.toHaveBeenCalled();
  });
});
