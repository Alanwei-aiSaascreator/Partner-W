/**
 * 网关状态目录的 `openclaw.json` + 客户端 config 里的 `local-runtime` 条目。
 *
 * ⚠️ **令牌的唯一真相源是 state 文件**。客户端 config 里那份只是副本
 * （给 WS 连接用、经 safeStorage 加密落盘）。两者不一致时的现象极其难查：
 * WS 连上去被 1008 拒绝，界面上看着就是"网关没起来"，日志里只有一句 1008。
 * ⇒ 所以每次启动都以 state 文件为准做一次**对齐**，不一致就改写并报漂移。
 *
 * ⚠️ `openclaw.json` 里**刻意不写** `gateway.mode`（这正是启动参数必须带
 * `--allow-unconfigured` 的原因）、**不写** `gateway.port`（端口归 `--port`）。
 * 写进去就把网关自己的配置语义接管了，上游改默认值时我们会悄悄掉队。
 *
 * ⚠️ openclaw 自己也会往这个目录写东西（`openclaw.json.last-good` 等），
 * 所以**只在缺失时补**，绝不整文件覆盖。
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { GATEWAY_WS_PORT } from '@clawwork/shared';
import { writeJsonAtomic } from '../util/json-file.js';
import { readConfig, updateConfig } from '../workspace/config.js';
import type { AppConfig, GatewayServerConfig } from '../workspace/config.js';
import { generateGatewayToken } from './gateway-process.js';

export const STATE_DIR_NAME = 'openclaw-state';
export const STATE_CONFIG_FILE = 'openclaw.json';
/** 稳定 id：有了它，upsert 才是幂等的（不会每次启动多出一条网关）。 */
export const LOCAL_GATEWAY_ID = 'local-runtime';
export const LOCAL_GATEWAY_NAME = 'Local Runtime';

export interface OpenClawStateConfig {
  gateway: {
    auth: { mode: 'token'; token: string };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export function stateDirFor(userDataDir: string): string {
  return path.join(userDataDir, STATE_DIR_NAME);
}

export function stateConfigPath(stateDir: string): string {
  return path.join(stateDir, STATE_CONFIG_FILE);
}

/**
 * 最小可用配置（纯函数）。
 *
 * `mode` 必须是 `'token'`：写别的值等于告诉网关换一种认证方式，
 * 而客户端只会用 token。
 */
export function minimalGatewayConfig(token: string): OpenClawStateConfig {
  return { gateway: { auth: { mode: 'token', token } } };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 从（任意的）已有配置里挖出 token；没有则 null。 */
export function readStateToken(raw: unknown): string | null {
  if (!isRecord(raw)) return null;
  const gateway = raw.gateway;
  if (!isRecord(gateway)) return null;
  const auth = gateway.auth;
  if (!isRecord(auth)) return null;
  const token = auth.token;
  return typeof token === 'string' && token.length > 0 ? token : null;
}

/**
 * 确保状态目录里有一份带 token 的配置。
 *
 * 已有 token 就**沿用**（重新生成会让所有已连上的客户端立刻掉线）；
 * 已有配置的其它字段一律保留。
 */
export function ensureStateConfig(userDataDir: string): {
  token: string;
  created: boolean;
  configPath: string;
} {
  const stateDir = stateDirFor(userDataDir);
  const configPath = stateConfigPath(stateDir);
  mkdirSync(stateDir, { recursive: true });

  let existing: Record<string, unknown> | null = null;
  if (existsSync(configPath)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf-8'));
      if (isRecord(parsed)) existing = parsed;
    } catch {
      // 半截 JSON（掉电）当成"没有" —— 重建，而不是让整个启动失败
    }
  }

  const existingToken = readStateToken(existing);
  if (existingToken && existing) {
    return { token: existingToken, created: false, configPath };
  }

  const token = existingToken ?? generateGatewayToken();
  const gateway = existing && isRecord(existing.gateway) ? existing.gateway : {};
  const merged: Record<string, unknown> = {
    ...(existing ?? {}),
    gateway: { ...gateway, auth: { mode: 'token', token } },
  };

  writeJsonAtomic(configPath, merged);
  return { token, created: existing === null, configPath };
}

/**
 * 把本机网关 upsert 进客户端 config 的 `gateways`（纯函数，便于钉住幂等）。
 *
 * ⚠️ 只动 `id === LOCAL_GATEWAY_ID` 那一条：用户自己配的网关**原封不动**。
 */
export function mergeGatewayEntry(
  gateways: readonly GatewayServerConfig[],
  entry: GatewayServerConfig,
): GatewayServerConfig[] {
  const index = gateways.findIndex((g) => g.id === LOCAL_GATEWAY_ID);
  if (index < 0) return [...gateways, entry];
  const next = [...gateways];
  next[index] = { ...next[index], ...entry };
  return next;
}

export interface EnsureClientGatewayEntryResult {
  token: string;
  /** config 被改写了没。 */
  changed: boolean;
  /** 是否发生了令牌漂移（state 与 config 不一致，已按 state 纠正）。 */
  drifted: boolean;
  stateDir: string;
}

/**
 * 让客户端 config 与 state 文件对齐，返回**以 state 为准**的 token。
 *
 * ⚠️ 必须走 `updateConfig`（而不是自己拼 JSON）：safeStorage 加密是在
 * `writeConfig` 里做的，绕过去 token 就明文落盘了。
 */
export async function ensureClientGatewayEntry(opts: { userDataDir: string }): Promise<EnsureClientGatewayEntryResult> {
  const { token } = ensureStateConfig(opts.userDataDir);
  const stateDir = stateDirFor(opts.userDataDir);

  const current: AppConfig = readConfig() ?? { workspacePath: '', gateways: [] };
  const existing = current.gateways.find((g) => g.id === LOCAL_GATEWAY_ID);

  const entry: GatewayServerConfig = {
    id: LOCAL_GATEWAY_ID,
    name: LOCAL_GATEWAY_NAME,
    url: `ws://127.0.0.1:${GATEWAY_WS_PORT}`,
    token,
    authMode: 'token',
    isDefault: true,
  };

  const drifted = Boolean(existing && existing.token !== undefined && existing.token !== token);
  const changed = drifted || !existing || existing.url !== entry.url || existing.authMode !== 'token';

  if (!changed) {
    return { token, changed: false, drifted: false, stateDir };
  }

  const gateways = mergeGatewayEntry(current.gateways, entry);
  updateConfig({
    gateways,
    defaultGatewayId: current.defaultGatewayId ?? LOCAL_GATEWAY_ID,
  });

  if (drifted) {
    console.warn('[runtime] runtime.token-mismatch：config 里的网关令牌与 state 文件不一致，已按 state 纠正');
  }

  return { token, changed: true, drifted, stateDir };
}
