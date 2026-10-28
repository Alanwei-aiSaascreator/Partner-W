import { accessSync, constants, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { getDebugLogger } from '../debug/index.js';

/**
 * 让网关连接的 TLS 认 Windows 证书库里的根证书（公司代理 / 自建 CA 场景）。
 *
 * ⚠️ 这里**刻意不 require('win-ca') 主入口**，而是直接驱动它的子模块。原因是一次实机崩溃
 * （2026-09-18 报障：装到 `C:\Program Files` 后普通用户启动即弹「未捕获异常」）：
 *
 *   · win-ca 主入口被 require 的那一刻就会自己执行 `{ inject: true, $ave: true }`；
 *   · `$ave` 会把整份证书写进**模块自己的 `pem/` 目录**，即安装目录下的
 *     `resources/app.asar.unpacked/node_modules/win-ca/pem`；
 *   · 装到 Program Files 这类普通用户不可写的位置时：第一次（以管理员）运行把该目录建出来并写成功，
 *     之后普通用户启动时目录**已存在但不可写** ⇒ 打开 `roots.pem` 抛 EPERM；
 *   · win-ca 写 `roots.pem` 用的是 `fs.createWriteStream` 且**没接 error 事件** ⇒
 *     这个异常接不住（不在我们的 try/catch 里），直接升级成主进程未捕获异常 ⇒ 应用起不来。
 *
 * 所以改成用它的 `lib/fallback`（引擎）+ `lib/save`（保存）+ `lib/inject`（打 TLS 补丁）自己驱动，
 * 证书**只写进 userData 下的可写目录**；目录写不了就整件事跳过（fail-soft，只留日志）。
 *
 * ⚠️ 这三个子模块是 win-ca 的内部 API：升级 win-ca 时先看 `test/gateway-tls.test.ts` 是否还绿。
 */
type WinCaEngine = {
  async: (store: unknown[]) => { run: (cb: (der: unknown) => void) => void };
};
type WinCaSaveFactory = (params: { save: string }) => (der: unknown) => void;
type WinCaInjectFactory = (mode: '+' | boolean) => (der: unknown) => void;

/** userData 下存证书的目录名。 */
const SAVE_DIR_NAME = 'win-ca-pem';

let windowsSystemTrustAttempted = false;

/**
 * 是否加载 Windows 系统证书库（默认**关闭**）。
 *
 * 2026-10-19（360 误报治理）：win-ca 的 fallback 引擎会 `execFile` 一个**未签名**的
 * `roots.exe`。对杀软启发式来说，这是"未签名程序启动未签名程序 + 读取证书库"的典型组合
 * —— 用户侧表现就是"装完被 360 报木马"。
 *
 * 我们的 relay / 更新域名都是公共 CA 签发（Let's Encrypt），**不需要**企业 MITM 根证书；
 * 只有明确处于 TLS 解密代理后的企业环境才需要。用 `PARTNERW_SYSTEM_CERT_STORE=1` 显式开启，
 * 开启后行为与之前完全一致。
 */
export function systemCertStoreEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PARTNERW_SYSTEM_CERT_STORE === '1';
}

export function ensureGatewayWindowsSystemTrust(userDataDir: string): void {
  if (process.platform !== 'win32' || windowsSystemTrustAttempted) {
    return;
  }

  if (!systemCertStoreEnabled()) {
    windowsSystemTrustAttempted = true;
    getDebugLogger().info({
      domain: 'gateway',
      event: 'gateway.tls.system-trust.disabled',
      data: { reason: 'PARTNERW_SYSTEM_CERT_STORE != 1' },
    });
    return;
  }

  windowsSystemTrustAttempted = true;

  const saveDir = join(userDataDir, SAVE_DIR_NAME);

  try {
    mkdirSync(saveDir, { recursive: true });
    accessSync(saveDir, constants.W_OK);

    const require = createRequire(import.meta.url);
    const winCaDir = dirname(require.resolve('win-ca/package.json'));
    const engine = (require(join(winCaDir, 'lib/fallback')) as WinCaEngine).async([]);
    const save = (require(join(winCaDir, 'lib/save')) as WinCaSaveFactory)({ save: saveDir });
    const inject = (require(join(winCaDir, 'lib/inject')) as WinCaInjectFactory)('+');

    let certificates = 0;

    engine.run((der) => {
      if (!der) {
        getDebugLogger().info({
          domain: 'gateway',
          event: 'gateway.tls.system-trust.enabled',
          data: { certificates },
        });
        return;
      }

      certificates += 1;
      save(der);
      inject(der);
    });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));

    getDebugLogger().warn({
      domain: 'gateway',
      event: 'gateway.tls.system-trust.failed',
      error: { name: err.name, message: err.message, stack: err.stack },
    });
  }
}
