import fs from 'node:fs';
import path from 'node:path';
import { RELAY_BASE_URL, normalizeBaseUrl } from './relay-config.js';

/**
 * 受控配置出口 —— 决定「客户端这侧打到哪个中转基址」的**唯一**裁决处（2026-10-03）。
 *
 * ## 它解决的是什么
 *
 * 源码里 `RELAY_BASE_URL` 固定生产基址；要跑受控验收（本机 relay 8791）时，
 * 之前的做法是**改候选构建副本里的常量** —— 源码与候选不一致、不可审计，
 * 也说不清"这份包默认打到哪"。本模块把这件事收成一个受控出口：
 *
 *   · 默认（env 没有测试配置）：生产基址，行为与之前**逐字相同**；
 *   · 测试模式（`ROYIN_NATIVE_TEST_CONFIG` 指向 test-budget.json）：基址取自
 *     配置里 `gatewayConfig`（模型配置文件）的 `models.providers.clawrouter.baseUrl`；
 *   · 账号不匹配：**拒绝**测试模式 —— 回退生产基址并带上原因（`account-mismatch`）；
 *   · 重启不覆写：解析挂在**每一轮 bootstrap 写入之前**（见 relay-startup），
 *     env 还在 ⇒ 解析结果还是本地基址，启动重写写回的仍是本地，
 *     不会把测试配置冲成生产。
 *
 * ## 纪律
 *
 * - 基址白名单（`isControlledRelayBaseUrl`）与 `native-dispatch-guard` **共用同
 *   一个函数**：两处各写一份，早晚漂出一条"把测试配置指去任意主机"的缝。
 * - 本模块**不抛**：任何读取/解析/许可异常一律回退生产基址并把原因交给调用方。
 *   生产默认值是安全侧 —— 测试模式打不开是"少一个能力"，不是"坏一个生产"。
 * - 文件读取全部走**限额读取**（`readCappedTextFile`）：这两个文件来自测试现场，
 *   不设上限等于允许一个手滑指向大文件的 env 把主进程读爆。
 */

/** 测试预算配置（test-budget.json）的大小上限。与 native-dispatch-guard 同值。 */
export const TEST_BUDGET_CONFIG_MAX_BYTES = 64 * 1024;
/** 网关/模型配置（gatewayConfig 指向的大文件）的大小上限。与 native-dispatch-guard 同值。 */
export const GATEWAY_CONFIG_MAX_BYTES = 1024 * 1024;

/** 生产中转的 origin（精确比较，不比较端口）。 */
const PRODUCTION_RELAY_ORIGIN = 'https://api.rongyinghudong.com';

/**
 * 这个基址是不是"受控可用的中转地址"。
 *
 * 白名单两条，与 `native-dispatch-guard` 的历史判据逐字一致：
 *   ① 生产 origin；② 回环（`http://127.0.0.1` / `http://localhost`，**任意端口**）。
 *
 * ⚠️ 回环比较的是 `protocol//hostname`（**不含端口**）：本机 relay 从 8791 换到
 *    别的端口不该需要改这里；而"hostname 是 127.0.0.1、协议却是 https"这种
 *    形状进不来 —— 我们本机 relay 就是明文 http。
 */
export function isControlledRelayBaseUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.origin === PRODUCTION_RELAY_ORIGIN) return true;
  return ['http://127.0.0.1', 'http://localhost'].includes(`${url.protocol}//${url.hostname}`);
}

/** 读取被拒的原因码。生产回退时带出来给日志，**不进用户文案**。 */
export type ControlledEndpointReason =
  | 'config-unreadable'
  | 'not-authorized'
  | 'account-mismatch'
  | 'provider-unavailable'
  | 'url-not-allowed';

export interface ControlledEndpointResolution {
  /** 归一化（去尾斜杠）后的基址。 */
  baseUrl: string;
  source: 'production' | 'test-config';
  /** 配了测试配置但被拒时给出。`source === 'production'` 且没配测试配置时为 undefined。 */
  reason?: ControlledEndpointReason;
}

/**
 * 同步判据：env 里有没有**可用的**测试配置路径。
 *
 * 它存在的唯一理由：生产默认路径必须能**同步**判断（没有测试配置就根本不需要
 * 异步解析），从而让 bootstrap 保持"触发即开工、同步进 running"的历史行为
 * （由 `relay-startup.test.ts` 的重试用例钉住）。
 */
export function controlledTestConfigPath(env: { ROYIN_NATIVE_TEST_CONFIG?: string | undefined }): string | null {
  const file = env.ROYIN_NATIVE_TEST_CONFIG;
  return file && path.isAbsolute(file) ? file : null;
}

export interface ControlledEndpointDeps {
  /** 只认 `ROYIN_NATIVE_TEST_CONFIG` 一个变量（测试模式的总开关）。 */
  env: { ROYIN_NATIVE_TEST_CONFIG?: string | undefined };
  /** 限额读取；不存在/超限/不是文件 → 抛。测试里注入假实现。 */
  readTextFile: (absPath: string, maxBytes: number) => string;
  /** 读本机许可里的 licenseId；读不出（没激活/查询失败）返回 null。 */
  readLicenseId: () => Promise<string | null>;
}

/**
 * 裁决一次"客户端该打到哪"。**不抛**：任何一步不成立都回退生产基址。
 *
 * 判定顺序刻意与 `native-dispatch-guard` 对齐（形状 → 账号 → provider → 白名单）：
 * 两处的失败原因码含义保持一致，排查时一条日志能对上另一条。
 */
export async function resolveControlledRelayEndpoint(
  deps: ControlledEndpointDeps,
): Promise<ControlledEndpointResolution> {
  // ⚠️ 生产回退值**逐字**取 `RELAY_BASE_URL`（带 `/relay` 前缀的那份），
  //    不是它的 origin —— 少了前缀，请求会打到站点根，表现为"模型列表是空的"。
  const production: ControlledEndpointResolution = { baseUrl: normalizeBaseUrl(RELAY_BASE_URL), source: 'production' };
  const rejected = (reason: ControlledEndpointReason): ControlledEndpointResolution => ({
    baseUrl: production.baseUrl,
    source: 'production',
    reason,
  });

  const file = controlledTestConfigPath(deps.env);
  if (!file) return production;

  let cfg: { authorizedTest?: unknown; licenseId?: unknown; gatewayConfig?: unknown };
  try {
    cfg = JSON.parse(deps.readTextFile(file, TEST_BUDGET_CONFIG_MAX_BYTES).toString());
  } catch {
    return rejected('config-unreadable');
  }
  if (
    cfg.authorizedTest !== true ||
    typeof cfg.licenseId !== 'string' ||
    cfg.licenseId.length === 0 ||
    typeof cfg.gatewayConfig !== 'string' ||
    !path.isAbsolute(cfg.gatewayConfig)
  ) {
    return rejected('not-authorized');
  }

  // 账号不匹配 ⇒ 拒绝测试模式。**先于**读 gatewayConfig：账号就不对时，
  // 那个文件里写了什么都不该影响裁决结果。
  let licenseId: string | null;
  try {
    licenseId = await deps.readLicenseId();
  } catch {
    licenseId = null;
  }
  if (licenseId !== cfg.licenseId) return rejected('account-mismatch');

  let modelCfg: { models?: { providers?: { clawrouter?: { baseUrl?: unknown } } } };
  try {
    modelCfg = JSON.parse(deps.readTextFile(cfg.gatewayConfig, GATEWAY_CONFIG_MAX_BYTES).toString());
  } catch {
    return rejected('provider-unavailable');
  }
  const provider = modelCfg?.models?.providers?.clawrouter;
  if (!provider || typeof provider.baseUrl !== 'string' || provider.baseUrl.length === 0) {
    return rejected('provider-unavailable');
  }
  if (!isControlledRelayBaseUrl(provider.baseUrl)) return rejected('url-not-allowed');

  return { baseUrl: provider.baseUrl.replace(/\/+$/, ''), source: 'test-config' };
}

/** 限额读取一个文本文件。超出上限 / 不是常规文件 / 读不到 → 抛（由调用方收）。 */
export function readCappedTextFile(absPath: string, maxBytes: number): string {
  const stat = fs.statSync(absPath);
  if (!stat.isFile() || stat.size > maxBytes) throw new Error('capped-read-rejected');
  return fs.readFileSync(absPath, 'utf8');
}
