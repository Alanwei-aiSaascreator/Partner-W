import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 给**隔离 profile** 准备「已配置商业层 + 已登录」的初始状态。
 *
 * 为什么必须从开发机的既有 profile 取，而不是环境变量：
 * 客户端**没有**任何内置的 Supabase 地址/anon key（全仓库搜过，只有
 * `config?.commercial?.supabaseUrl ?? ''` 一处读取），`commercial:set-config`
 * 这条 IPC 也没有界面调用方 —— 也就是说 provisioning 本来就是**带外**的。
 * E2E 只能沿用同一套带外数据。
 *
 * ## 会话为什么要连 `Local State` 一起拷
 *
 * `commercial-session.json` 是 `safeStorage`（Windows DPAPI）加密的，
 * **解密的密钥存在 profile 的 `Local State` 里**。只拷密文、不拷 `Local State`，
 * 换个 profile 就解不开，表现为"明明有会话却要重新登录"。
 *
 * ## 为什么要连 `deviceId` 一起拷
 *
 * 设备指纹 = `sha256(deviceId|hostname|platform|arch)`，而 `activate_license`
 * 对**已知设备是幂等的**（只刷新 `last_seen_at`，不占激活名额）。
 * 换一个新 deviceId 就等于**新设备** —— 会真的消耗一次激活名额（名额满了还会
 * 按"最久没露面"腾位子）。E2E 用同一台机器，指纹就该是同一个。
 *
 * ⚠️ **密钥纪律**：本文件只做搬运与存在性判断，**绝不把任何 secret 打印或落进
 * 报告**；断言一律用 has/长度，比对一律用 hash。
 */

export const DEV_PROFILE_DIR = path.join(os.homedir(), 'AppData', 'Roaming', '@clawwork', 'desktop');

export interface CommercialProvision {
  supabaseUrl: string;
  supabaseAnonKey: string;
  licenseKey: string;
  sessionFilePath: string;
  localStoragePath: string;
  deviceId: string;
}

/** 开发机 profile 是否具备可搬运的商业身份。不具备就返回 null（E2E 该 skip）。 */
export function readDevProvision(): CommercialProvision | null {
  const configPath = path.join(DEV_PROFILE_DIR, 'clawwork-config.json');
  const sessionFilePath = path.join(DEV_PROFILE_DIR, 'commercial-session.json');
  const localStoragePath = path.join(DEV_PROFILE_DIR, 'Local State');

  if (!fs.existsSync(configPath) || !fs.existsSync(sessionFilePath) || !fs.existsSync(localStoragePath)) return null;

  let cfg: {
    deviceId?: string;
    commercial?: { supabaseUrl?: string; supabaseAnonKey?: string; licenseKey?: string };
  };
  try {
    cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    return null;
  }

  const { supabaseUrl, supabaseAnonKey, licenseKey } = cfg.commercial ?? {};
  if (!supabaseUrl || !supabaseAnonKey || !licenseKey || !cfg.deviceId) return null;

  return { supabaseUrl, supabaseAnonKey, licenseKey, sessionFilePath, localStoragePath, deviceId: cfg.deviceId };
}

export interface ProvisionOptions {
  /** 写进隔离 profile 的 workspace（必须是已存在的目录）。 */
  workspacePath: string;
  /** 覆盖 Supabase 地址 —— 用来模拟"商业后端不可得"。 */
  supabaseUrlOverride?: string;
  /** 不带会话文件 ⇒ 模拟"配了商业层但没登录"。 */
  skipSession?: boolean;
}

/**
 * 把商业身份铺进隔离 profile。**只读开发机 profile**，一个字节都不改它。
 *
 * ⚠️ 调用前 userDataDir 必须已经存在。
 */
export function provisionProfile(userDataDir: string, p: CommercialProvision, opts: ProvisionOptions): void {
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(opts.workspacePath, { recursive: true });

  // safeStorage 的解密密钥（缺了会话就解不开）
  fs.copyFileSync(p.localStoragePath, path.join(userDataDir, 'Local State'));

  if (!opts.skipSession) {
    fs.copyFileSync(p.sessionFilePath, path.join(userDataDir, 'commercial-session.json'));
  }

  const config = {
    workspacePath: opts.workspacePath,
    // ⚠️ 复用同一个 deviceId ⇒ 同一个设备指纹 ⇒ 激活 RPC 走幂等分支，不占名额
    deviceId: p.deviceId,
    commercial: {
      supabaseUrl: opts.supabaseUrlOverride ?? p.supabaseUrl,
      supabaseAnonKey: p.supabaseAnonKey,
      licenseKey: p.licenseKey,
    },
    gateways: [],
  };
  fs.writeFileSync(path.join(userDataDir, 'clawwork-config.json'), JSON.stringify(config, null, 2));
}

/** 报告用：只给"有没有、多长"，**不给值**。 */
export function describeProvision(p: CommercialProvision): Record<string, unknown> {
  return {
    supabaseHost: new URL(p.supabaseUrl).host,
    hasAnonKey: p.supabaseAnonKey.length > 0,
    licenseKeyPrefix: p.licenseKey.slice(0, 3) + '…',
    licenseKeyLength: p.licenseKey.length,
    hasSession: true,
    hasDeviceId: p.deviceId.length > 0,
  };
}
