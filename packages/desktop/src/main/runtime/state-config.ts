/**
 * 网关状态目录的 `openclaw.json` + 客户端 config 里的 `local-runtime` 条目。
 *
 * ⚠️ **令牌的唯一真相源是 ClawWork 自己的 store**（`runtime/token-store.ts`，
 * `<userData>/runtime/local-gateway-auth.json`）。这里产出的两份都是**镜像**：
 *   - `openclaw.json` —— 网关的 bootstrap 输入；按 store 对齐，不一致就改写回来
 *   - 客户端 config 的 `local-runtime` 条目 —— 给 WS 连接用（safeStorage 加密落盘）
 *
 * 镜像不一致的现象极其难查：WS 连上去被 1008 拒绝，界面上看着就是"网关没起来"，
 * 日志里只有一句 1008。⇒ 所以每次启动都按 store 做一次**对齐**，不一致就改写并报漂移。
 *
 * ⚠️ 绝不能让 token 的生命周期由 openclaw 的配置行为决定：那份文件被换掉/删掉时
 * 若"重新生成一个"，就会拿新 token 去认证还在用旧 token 跑的网关 ⇒ 认证失败 ⇒
 * 被误判成 foreign。详见 `token-store.ts` 的头注释。
 *
 * ⚠️ `openclaw.json` 里**刻意不写** `gateway.mode`（这正是启动参数必须带
 * `--allow-unconfigured` 的原因）、**不写** `gateway.port`（端口归 `--port`）。
 * 写进去就把网关自己的配置语义接管了，上游改默认值时我们会悄悄掉队。
 *
 * ⚠️ openclaw 自己也会往这个目录写东西（`openclaw.json.last-good` 等），
 * 所以**只在缺失或认证段不一致时补**，绝不整文件覆盖。
 *
 * 除了认证段，这里还会补一条**记忆检索的默认值**（`memory.search.provider = 'none'`，
 * 见 `MEMORY_SEARCH_PROVIDER`）—— 不补的话模型每次调 `memory_search` 都会卡 15 秒再失败。
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { GATEWAY_WS_PORT } from '@clawwork/shared';
import { writeJsonAtomic } from '../util/json-file.js';
import { readConfig, updateConfig } from '../workspace/config.js';
import type { AppConfig, GatewayServerConfig } from '../workspace/config.js';
import { ensureLocalGatewayToken } from './token-store.js';

export const STATE_DIR_NAME = 'openclaw-state';
export const STATE_CONFIG_FILE = 'openclaw.json';
/** 稳定 id：有了它，upsert 才是幂等的（不会每次启动多出一条网关）。 */
export const LOCAL_GATEWAY_ID = 'local-runtime';
export const LOCAL_GATEWAY_NAME = 'Local Runtime';

/**
 * 记忆检索走**本地 FTS-only**，不接任何嵌入服务。
 *
 * 现场（2026-09-18，用户机器）：对话里模型一调 `memory_search` 就卡**整整 15.0 秒**
 * 然后报错，再接着调别的工具（`ls`/`ask_user` 都正常）—— 用户看到的正是"调用
 * memory 失败然后继续调用其他工具"。调试日志里三次调用，每次都是 15.0 秒后才 error。
 *
 * 根因不是我们写错了配置，而是**没写**：`memory.search.provider` 不写默认是 `openai`
 * （`docs/reference/memory-config.md`），而我们从不出任何嵌入凭据 ⇒ 每次调用都去够
 * OpenAI 直到超时。文档同时写明"显式远端 provider 在运行时不可达时 **fail closed**"，
 * 即它不是悄悄退回全文检索，而是直接失败 —— 这就是那 15 秒。
 *
 * `none` 是运行时**一等公民**（`memory-core/manager-runtime.js` 多处特判走 FTS-only 分支），
 * 文档写明"`provider: "none"` 有意选择 FTS-only 模式，记忆召回仍可正常工作"。
 * 选它而不是 `enabled: false`：召回继续可用、不出网、不要凭据，符合"内容不出网"。
 *
 * ⚠️ 将来 T6b 接上我们自己的嵌入通道（走 relay 并计费）时，把这里换成对应 provider。
 */
export const MEMORY_SEARCH_PROVIDER = 'none';

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

/** 从（任意的）配置里挖出 `memory.search.provider`；没有则 null。 */
export function readMemorySearchProvider(raw: unknown): string | null {
  if (!isRecord(raw)) return null;
  const memory = raw.memory;
  if (!isRecord(memory)) return null;
  const search = memory.search;
  if (!isRecord(search)) return null;
  const provider = search.provider;
  return typeof provider === 'string' && provider.length > 0 ? provider : null;
}

/**
 * 记忆段合并（纯函数）：**只在没有 provider 时补默认**，设过的一个字都不动。
 *
 * 为什么要合并而不是整段覆盖：用户机器上这份文件**早就存在**（`ensureStateConfig`
 * 里那条"已经一致就一个字节都不写"的提前返回会直接跳过它）⇒ 只在"新建"路径上补默认值
 * 等于对存量用户完全没修。另外 openclaw 自己也可能往 `memory` 里写别的东西。
 */
export function mergeMemoryDefaults(existing: Record<string, unknown> | null): Record<string, unknown> {
  const memory = existing && isRecord(existing.memory) ? existing.memory : {};
  if (readMemorySearchProvider(existing) !== null) return memory;

  const search = isRecord(memory.search) ? memory.search : {};
  return { ...memory, search: { ...search, provider: MEMORY_SEARCH_PROVIDER } };
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
 * 客户端 config 里 `local-runtime` 那条的 token；没有则 null。
 *
 * 只用于 store **首次**建立时的一次性接管（见下），不是真相源。
 */
function readClientLocalRuntimeToken(): string | null {
  try {
    const entry = readConfig()?.gateways.find((g) => g.id === LOCAL_GATEWAY_ID);
    return typeof entry?.token === 'string' && entry.token.length > 0 ? entry.token : null;
  } catch {
    return null;
  }
}

/**
 * 确保状态目录里那份 `openclaw.json` 带的是 **store 的** token。
 *
 * 语义（2026-09-13 定稿）：
 *   - 真相源是 ClawWork 自己的 store，**不在**这份文件里
 *   - 因此"文件不见了/被改掉了"**不等于**"token 没了" —— 绝不因此重新生成
 *   - 这份文件是**镜像**：缺了、或认证段与 store 不一致 ⇒ 按 store 写回去
 *   - 已有配置里的其它字段一律保留（openclaw 也会往这里写东西）
 *
 * ⚠️ 接管顺序：state 文件 → 客户端 config。**state 文件优先**是因为它才是正在跑的
 * 那个网关实际在用的 token —— 反过来会让升级后第一次启动就把活着的网关踢掉。
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

  // ① 真相源：ClawWork 自己的 store。store 不存在时才问一次"有没有旧 token 可接管"。
  const store = ensureLocalGatewayToken({
    userDataDir,
    adopt: () => existingToken ?? readClientLocalRuntimeToken(),
  });

  // ② 已经一致 ⇒ 一个字节都不写（不每次启动都重写别人的文件）
  //
  // ⚠️ "一致"必须**含**记忆默认值：这条提前返回是存量用户的必经之路（他们的 token
  //    本来就是对的），只看 token 的话 `memory.search.provider` 永远补不上 ——
  //    那正是"对用户机器无效"的那一版修法。token 对 + 记忆段已设 ⇒ 才真的不写。
  if (existingToken === store.token && existing && readMemorySearchProvider(existing) !== null) {
    return { token: store.token, created: false, configPath };
  }

  const gateway = existing && isRecord(existing.gateway) ? existing.gateway : {};
  const merged: Record<string, unknown> = {
    ...(existing ?? {}),
    gateway: { ...gateway, auth: { mode: 'token', token: store.token } },
    memory: mergeMemoryDefaults(existing),
  };

  writeJsonAtomic(configPath, merged);

  // ⚠️ 只报"不一致"这件事，绝不把 token 本身写进日志
  if (existingToken && existingToken !== store.token) {
    console.warn(
      '[runtime] runtime.state-token-drift：state 文件里的网关令牌与 ClawWork 持有的不一致，已按 store 改写回来',
    );
  }

  return { token: store.token, created: existing === null, configPath };
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
