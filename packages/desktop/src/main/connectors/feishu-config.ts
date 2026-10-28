/**
 * 飞书通道的**配置读写**（主进程纯逻辑，网关句柄注入）。
 *
 * 为什么走网关的 `config.get` / `config.patch`，而不是直接改盘上的 `openclaw.json`
 * （2026-10-17 既有纪律，`license.ts` / `relay-config.ts` 同一套）：
 *   · 客户端本来就不是这个文件的 owner；网关是。直接覆盖会绕过并发保护和写守卫；
 *   · `config.patch` 是**深合并**，只带要改的键就不会碰用户其它配置。
 *
 * 写进去的形状（现场已验证可工作的那份）：
 *   `channels.feishu = { enabled, dmPolicy:'allowlist', appId, appSecret, allowFrom:[openId],
 *                        groupPolicy:'open', requireMention:true }`
 *   `bindings += { type:'route', agentId:'main', match:{ channel:'feishu' } }`
 *   （与 `openclaw agents bind --agent main --bind feishu` 写出来的形状一致，幂等）
 */

import { existsSync, readFileSync } from 'node:fs';

export interface FeishuConfigGateway {
  getConfig(): Promise<unknown>;
  patchConfig(params: { baseHash: string; raw: string; replacePaths?: string[] }): Promise<unknown>;
}

export interface FeishuCredentialsInput {
  appId: string;
  appSecret: string;
  openId: string | null;
}

export type FeishuConfigWriteFailure = 'transport' | 'hash-conflict' | 'rejected' | 'verify-failed' | 'not-configured';

export type FeishuConfigWriteResult =
  | { ok: true; verified: boolean; appId?: string; boundAgentId?: string | null }
  | { ok: false; reason: FeishuConfigWriteFailure; message?: string };

const MAX_HASH_RETRIES = 3;
const FEISHU_CHANNEL = 'feishu';
/** 没有任何既有绑定时，新接入默认绑到主罗盘（现场 `AgentSelectionRequiredError` 的修法）。 */
export const DEFAULT_FEISHU_AGENT_ID = 'main';

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 写失败的分类（与 `relay-config.ts` 的 `classifyWriteError` 同口径）。
 * 只有乐观锁冲突值得重试 —— 重读快照会改变输入；其余重试一万次也一样。
 */
export function classifyFeishuWriteError(error: unknown): 'hash-conflict' | 'transport' | 'rejected' {
  const text = messageOf(error);
  if (/hash|config changed since last load|re-run config\.get and retry/i.test(text)) return 'hash-conflict';
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EPIPE|socket hang up|not connected|timeout/i.test(text)) {
    return 'transport';
  }
  return 'rejected';
}

/** `config.get` 快照 → 配置对象（快照形状是 `{ hash, config }`；测试里也允许直接给配置）。 */
export function configFromSnapshot(snapshot: unknown): Record<string, unknown> | null {
  const record = recordOf(snapshot);
  if (!record) return null;
  if ('config' in record) return recordOf(record['config']);
  return record;
}

function snapshotHash(snapshot: unknown): string | null {
  const hash = recordOf(snapshot)?.['hash'];
  return typeof hash === 'string' && hash.length > 0 ? hash : null;
}

function channelMatches(value: unknown): boolean {
  if (typeof value === 'string') return value === FEISHU_CHANNEL;
  return Array.isArray(value) && value.some((item) => item === FEISHU_CHANNEL);
}

/** 配置里所有**飞书路由绑定**的 agentId（保持原顺序，去重）。 */
export function readFeishuRouteBindingIds(config: unknown): string[] {
  const bindings = recordOf(config)?.['bindings'];
  if (!Array.isArray(bindings)) return [];
  const ids: string[] = [];
  for (const entry of bindings) {
    const row = recordOf(entry);
    if (!row || row['type'] !== 'route') continue;
    const match = recordOf(row['match']);
    if (!match || !channelMatches(match['channel'])) continue;
    const agentId = typeof row['agentId'] === 'string' ? row['agentId'].trim() : '';
    if (agentId && !ids.includes(agentId)) ids.push(agentId);
  }
  return ids;
}

/** 从盘上的 `openclaw.json` 读当前绑定（网关不可用时的只读回退）。 */
export function readFeishuRouteBindingsAt(configPath: string): string[] {
  try {
    if (!existsSync(configPath)) return [];
    return readFeishuRouteBindingIds(JSON.parse(readFileSync(configPath, 'utf8')));
  } catch {
    return [];
  }
}

/**
 * `channels.feishu.allowFrom` 的 replacePaths。
 *
 * 内核的 `config.patch` 会把「数组变短/换内容」当成**可能误删**而拒写
 * （`config.patch would remove entries from array path(s)…`），必须显式声明
 * 该路径是整段替换。重新扫码换了飞书账号时 base 里是旧 openId ⇒ 不声明就必被拒。
 */
export function feishuAllowFromReplacePaths(config: unknown): string[] {
  const feishu = recordOf(recordOf(recordOf(config)?.['channels'])?.[FEISHU_CHANNEL]);
  const allowFrom = feishu?.['allowFrom'];
  return Array.isArray(allowFrom) && allowFrom.length > 0 ? [`channels.${FEISHU_CHANNEL}.allowFrom`] : [];
}

/**
 * `channels.feishu` 的写入形状（深合并，只带这几个键）。
 *
 * ⚠️ 两条安全默认（2026-10-18 独立审查）：
 *  ① `groupPolicy` 必须是 **allowlist**，不能是 `open` —— 后者让群聊里**任何成员**
 *     @ 一下就能驱动本机 agent（读写共享工作区、触发付费生成）。插件向导的默认值也是
 *     allowlist；要开群必须由用户显式配置。
 *  ② **openId 缺失时不写 `dmPolicy`/`allowFrom`**：`dmPolicy:'allowlist'` + 空名单
 *     会被内核当成"谁都不许" ⇒ 连机主自己的私聊也被静默拦截。让内核保留默认的
 *     pairing 流程，比写死一个空白名单安全。
 */
export function buildFeishuChannelPatch(input: FeishuCredentialsInput): Record<string, unknown> {
  const feishu: Record<string, unknown> = {
    enabled: true,
    appId: input.appId,
    appSecret: input.appSecret,
    groupPolicy: 'allowlist',
    requireMention: true,
  };
  if (input.openId) {
    feishu['dmPolicy'] = 'allowlist';
    feishu['allowFrom'] = [input.openId];
  }
  return {
    channels: { [FEISHU_CHANNEL]: feishu },
    plugins: { entries: { [FEISHU_CHANNEL]: { enabled: true } } },
  };
}

/**
 * 绑定补丁：**保留**其它绑定，只替换飞书这一条。
 * `agentId = null` ⇒ 删掉所有飞书路由绑定（取消绑定）。
 * 返回 `null` = 与现状一致，不需要写。
 */
export function buildFeishuBindingPatch(
  config: unknown,
  agentId: string | null,
): { patch: Record<string, unknown>; replacePaths: string[] } | null {
  const existingRaw = recordOf(config)?.['bindings'];
  const existing = Array.isArray(existingRaw) ? existingRaw : [];
  const withoutFeishu = existing.filter((entry) => {
    const row = recordOf(entry);
    const match = row ? recordOf(row['match']) : null;
    return !(row && row['type'] === 'route' && match && channelMatches(match['channel']));
  });
  const next = agentId
    ? [...withoutFeishu, { type: 'route', agentId, match: { channel: FEISHU_CHANNEL } }]
    : withoutFeishu;

  const currentIds = readFeishuRouteBindingIds(config);
  const unchanged =
    agentId === null
      ? currentIds.length === 0
      : currentIds.length === 1 && currentIds[0] === agentId && existing.length === next.length;
  if (unchanged) return null;

  return { patch: { bindings: next }, replacePaths: ['bindings'] };
}

/** 回读校验：通道确实指向这个应用（`allowFrom` 由网关按数组语义落盘，不在这里比）。 */
export function verifyFeishuChannelApplied(snapshot: unknown, appId: string): boolean {
  const config = configFromSnapshot(snapshot);
  const feishu = recordOf(recordOf(config)?.['channels'])?.[FEISHU_CHANNEL];
  const row = recordOf(feishu);
  return Boolean(row && row['appId'] === appId);
}

export function verifyFeishuBindingApplied(snapshot: unknown, agentId: string | null): boolean {
  const ids = readFeishuRouteBindingIds(configFromSnapshot(snapshot));
  return agentId === null ? ids.length === 0 : ids.includes(agentId);
}

/** 读一次快照并取出 `{ hash, config }`；拿不到 hash ⇒ 无法安全写。 */
function readSnapshotOrFailure(
  snapshot: unknown,
): { ok: true; hash: string; config: Record<string, unknown> } | { ok: false; result: FeishuConfigWriteResult } {
  const hash = snapshotHash(snapshot);
  const config = configFromSnapshot(snapshot);
  if (!hash || !config) {
    return { ok: false, result: { ok: false, reason: 'transport', message: 'config snapshot has no hash' } };
  }
  return { ok: true, hash, config };
}

/**
 * 扫码成功后写入凭证，并保证**至少有一条**飞书绑定：
 *   · 原本已有绑定 ⇒ 原样保留（用户可能是手动绑到某个助手上的）；
 *   · 原本没有     ⇒ 绑到主罗盘 `main`（现场实机：飞书消息全部 `AgentSelectionRequiredError`）。
 */
export async function applyFeishuCredentials(
  gateway: FeishuConfigGateway,
  credentials: FeishuCredentialsInput,
): Promise<FeishuConfigWriteResult> {
  let lastFailure: FeishuConfigWriteFailure = 'transport';
  for (let attempt = 1; attempt <= MAX_HASH_RETRIES; attempt += 1) {
    let snapshot: unknown;
    try {
      snapshot = await gateway.getConfig();
    } catch (error) {
      return { ok: false, reason: 'transport', message: messageOf(error) };
    }
    const read = readSnapshotOrFailure(snapshot);
    if (!read.ok) return read.result;

    const existingAgents = readFeishuRouteBindingIds(read.config);
    const targetAgent = existingAgents[0] ?? DEFAULT_FEISHU_AGENT_ID;
    const bindingPatch = buildFeishuBindingPatch(read.config, targetAgent);
    const patch = {
      ...buildFeishuChannelPatch(credentials),
      ...(bindingPatch?.patch ?? {}),
    };
    const replacePaths = [...feishuAllowFromReplacePaths(read.config), ...(bindingPatch?.replacePaths ?? [])];

    try {
      await gateway.patchConfig({
        baseHash: read.hash,
        raw: JSON.stringify(patch),
        ...(replacePaths.length > 0 ? { replacePaths } : {}),
      });
    } catch (error) {
      const kind = classifyFeishuWriteError(error);
      lastFailure = kind;
      if (kind === 'hash-conflict' && attempt < MAX_HASH_RETRIES) continue;
      return { ok: false, reason: kind, message: messageOf(error) };
    }

    // 回读校验。读失败 ≠ 写失败：写已经被网关确认，只是连接可能在重启窗口里
    // （写飞书通道会触发网关自重启，监督者负责拉回）。此时返回 `verified:false`。
    try {
      const applied = await gateway.getConfig();
      if (!verifyFeishuChannelApplied(applied, credentials.appId)) {
        return { ok: false, reason: 'verify-failed' };
      }
      return {
        ok: true,
        verified: verifyFeishuBindingApplied(applied, targetAgent),
        appId: credentials.appId,
        boundAgentId: targetAgent,
      };
    } catch {
      return { ok: true, verified: false, appId: credentials.appId, boundAgentId: targetAgent };
    }
  }
  return { ok: false, reason: lastFailure };
}

/** 更换/取消绑定（`agentId = null` ⇒ 取消）。 */
export async function setFeishuRouteBinding(
  gateway: FeishuConfigGateway,
  agentId: string | null,
): Promise<FeishuConfigWriteResult> {
  let lastFailure: FeishuConfigWriteFailure = 'transport';
  for (let attempt = 1; attempt <= MAX_HASH_RETRIES; attempt += 1) {
    let snapshot: unknown;
    try {
      snapshot = await gateway.getConfig();
    } catch (error) {
      return { ok: false, reason: 'transport', message: messageOf(error) };
    }
    const read = readSnapshotOrFailure(snapshot);
    if (!read.ok) return read.result;

    const bindingPatch = buildFeishuBindingPatch(read.config, agentId);
    if (!bindingPatch) return { ok: true, verified: true, boundAgentId: agentId };

    try {
      await gateway.patchConfig({
        baseHash: read.hash,
        raw: JSON.stringify(bindingPatch.patch),
        replacePaths: bindingPatch.replacePaths,
      });
    } catch (error) {
      const kind = classifyFeishuWriteError(error);
      lastFailure = kind;
      if (kind === 'hash-conflict' && attempt < MAX_HASH_RETRIES) continue;
      return { ok: false, reason: kind, message: messageOf(error) };
    }

    try {
      const applied = await gateway.getConfig();
      if (!verifyFeishuBindingApplied(applied, agentId)) return { ok: false, reason: 'verify-failed' };
      return { ok: true, verified: true, boundAgentId: agentId };
    } catch {
      return { ok: true, verified: false, boundAgentId: agentId };
    }
  }
  return { ok: false, reason: lastFailure };
}

/**
 * 把历史配置里的 `groupPolicy: "open"` 收紧到 `"allowlist"`（BUG-169 迁移）。
 *
 * 新写入的配置已经是 allowlist；这条只处理升级前接入过的盘 ——
 * 群聊里任何成员 @ 一下就能驱动本机 agent 的窗口必须关掉。
 * 幂等；没有 feishu 配置或已经是 allowlist 时 `changed=false`。
 */
export async function hardenFeishuGroupPolicy(
  gateway: FeishuConfigGateway,
): Promise<{ ok: true; changed: boolean } | { ok: false; reason: FeishuConfigWriteFailure; message?: string }> {
  let lastFailure: FeishuConfigWriteFailure = 'transport';
  for (let attempt = 1; attempt <= MAX_HASH_RETRIES; attempt += 1) {
    let snapshot: unknown;
    try {
      snapshot = await gateway.getConfig();
    } catch (error) {
      return { ok: false, reason: 'transport', message: messageOf(error) };
    }
    const read = readSnapshotOrFailure(snapshot);
    if (!read.ok) {
      const failure = read.result;
      if (failure.ok) return { ok: false, reason: 'verify-failed' };
      return { ok: false, reason: failure.reason, ...(failure.message ? { message: failure.message } : {}) };
    }
    const feishu = recordOf(recordOf(read.config['channels'])?.[FEISHU_CHANNEL]);
    if (!feishu || feishu['groupPolicy'] !== 'open') return { ok: true, changed: false };

    try {
      await gateway.patchConfig({
        baseHash: read.hash,
        raw: JSON.stringify({ channels: { [FEISHU_CHANNEL]: { groupPolicy: 'allowlist' } } }),
      });
    } catch (error) {
      const kind = classifyFeishuWriteError(error);
      lastFailure = kind;
      if (kind === 'hash-conflict' && attempt < MAX_HASH_RETRIES) continue;
      return { ok: false, reason: kind, message: messageOf(error) };
    }
    return { ok: true, changed: true };
  }
  return { ok: false, reason: lastFailure };
}

/** 开关通道（`enabled=false` 只停通道，不删凭证：用户可以随时再打开）。 */
export async function setFeishuChannelEnabled(
  gateway: FeishuConfigGateway,
  enabled: boolean,
): Promise<FeishuConfigWriteResult> {
  let lastFailure: FeishuConfigWriteFailure = 'transport';
  for (let attempt = 1; attempt <= MAX_HASH_RETRIES; attempt += 1) {
    let snapshot: unknown;
    try {
      snapshot = await gateway.getConfig();
    } catch (error) {
      return { ok: false, reason: 'transport', message: messageOf(error) };
    }
    const read = readSnapshotOrFailure(snapshot);
    if (!read.ok) return read.result;

    const feishu = recordOf(recordOf(read.config['channels'])?.[FEISHU_CHANNEL]);
    const appId = feishu && typeof feishu['appId'] === 'string' ? feishu['appId'] : '';
    if (!appId) return { ok: false, reason: 'not-configured' };

    try {
      await gateway.patchConfig({
        baseHash: read.hash,
        raw: JSON.stringify({ channels: { [FEISHU_CHANNEL]: { enabled } } }),
      });
    } catch (error) {
      const kind = classifyFeishuWriteError(error);
      lastFailure = kind;
      if (kind === 'hash-conflict' && attempt < MAX_HASH_RETRIES) continue;
      return { ok: false, reason: kind, message: messageOf(error) };
    }

    try {
      const applied = await gateway.getConfig();
      const row = recordOf(recordOf(configFromSnapshot(applied)?.['channels'])?.[FEISHU_CHANNEL]);
      return { ok: true, verified: Boolean(row && row['enabled'] === enabled), appId };
    } catch {
      return { ok: true, verified: false, appId };
    }
  }
  return { ok: false, reason: lastFailure };
}
