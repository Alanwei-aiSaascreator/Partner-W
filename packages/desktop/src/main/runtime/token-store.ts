/**
 * **ClawWork 自己持有的本机网关令牌** —— 令牌的唯一真相源。
 *
 * 为什么不把 token 只留在 openclaw 的配置里（先是踩过坑，后来查清了机制）：
 *
 *   1. 起初以为"网关启动后会把 `openclaw.json` 搬进 `state/openclaw.sqlite` 并删掉
 *      原文件"。**实测证伪**：网关启动前后那份文件逐字节不变（`state/openclaw.sqlite`
 *      是**审计/健康指纹**用的，不存配置）。
 *   2. 但 token 只存在于一份**由别人拥有**的文件里这件事本身仍然脆：openclaw 已经
 *      有若干条会动这个文件的路径 —— 配置"看起来可疑"时从 `.bak` 自动回滚
 *      （判据含 `missing-meta-vs-last-good`、`gateway-mode-missing-vs-last-good`，
 *      而我们写的最小配置**恰好**没有 `meta` 也没有 `gateway.mode`）、提交后回滚会
 *      `unlink` 文件、写入被 guard 拦下等。
 *   3. 一旦那份文件被换掉/删掉而我们**重新生成**一个 token，就会拿新 token 去认证
 *      一个还在用旧 token 跑的网关 ⇒ 认证失败 ⇒ 被误判成 **foreign** ⇒
 *      报"端口被占"，而端口上跑的正是我们自己上一轮起的网关。查错方向完全被带偏。
 *
 * ⇒ 所以：**令牌的生命周期不由 openclaw 的配置行为决定**。
 *
 *   ClawWork token store   = 持久真相源（本文件）
 *   openclaw 的 openclaw.json = 镜像 / bootstrap 输入（每次启动按 store 对齐）
 *   客户端 config 的 local-runtime 条目 = 镜像（给 WS 连接用，safeStorage 加密）
 *
 * 硬要求（用户批复）：**持久、原子、只有首次生成、后续稳定复用**。
 * ⚠️ 任何地方都**不把明文 token 写进日志**。
 */

import { mkdirSync, readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../util/json-file.js';
import { generateGatewayToken } from './gateway-process.js';

export const LOCAL_GATEWAY_AUTH_DIR = 'runtime';
export const LOCAL_GATEWAY_AUTH_FILE = 'local-gateway-auth.json';
export const AUTH_STORE_FORMAT_VERSION = 1;

export interface LocalGatewayAuthStore {
  formatVersion: number;
  token: string;
  /** 给人看的溯源信息（排查"这个 token 哪来的"）。 */
  createdAt: string;
}

export function authStorePath(userDataDir: string): string {
  return path.join(userDataDir, LOCAL_GATEWAY_AUTH_DIR, LOCAL_GATEWAY_AUTH_FILE);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 读 store；不存在、半截 JSON、版本不认识、token 不是非空字符串 ⇒ 一律 `null`。
 *
 * ⚠️ 不抛：store 读不了等价于"还没有" —— 重新生成一个比让整个启动挂掉好。
 */
export function readAuthStore(userDataDir: string): LocalGatewayAuthStore | null {
  const file = authStorePath(userDataDir);
  if (!existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf-8'));
    if (!isRecord(parsed)) return null;
    if (parsed.formatVersion !== AUTH_STORE_FORMAT_VERSION) return null;
    const token = parsed.token;
    if (typeof token !== 'string' || token.length === 0) return null;
    return {
      formatVersion: AUTH_STORE_FORMAT_VERSION,
      token,
      createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : '',
    };
  } catch {
    return null;
  }
}

export interface EnsureLocalGatewayTokenResult {
  token: string;
  /** store 是这次才建的吗（只有首次为 true）。 */
  created: boolean;
  path: string;
}

/**
 * 取本机网关的 token：**有就复用，没有才生成、并原子落盘**。
 *
 * ⚠️ `adopt` 是**一次性迁移**用的：store 还不存在时，用来接管一个**已经存在**的
 * token（老安装里 state 文件/客户端 config 里那份）。不接管的话，升级后第一次启动
 * 会生成新 token —— 而上一轮起的网关还在用旧的，于是它被认证探测判成 foreign。
 * 只在 store 缺失时问一次；store 一旦建立，它说了算。
 */
export function ensureLocalGatewayToken(opts: {
  userDataDir: string;
  adopt?: () => string | null;
}): EnsureLocalGatewayTokenResult {
  const file = authStorePath(opts.userDataDir);

  const existing = readAuthStore(opts.userDataDir);
  if (existing) return { token: existing.token, created: false, path: file };

  // ⚠️ adopt 自己抛（config 读不了、state 文件被独占……）只说明"这次接管不上"，
  //    不能让它把整个启动带走 —— 生成一个新的仍然能起来。
  let adopted: string | null = null;
  try {
    adopted = opts.adopt?.() ?? null;
  } catch {
    adopted = null;
  }
  const token = adopted ?? generateGatewayToken();

  mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomic(file, {
    formatVersion: AUTH_STORE_FORMAT_VERSION,
    token,
    createdAt: new Date().toISOString(),
  } satisfies LocalGatewayAuthStore);

  return { token, created: true, path: file };
}
