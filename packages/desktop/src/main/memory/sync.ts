/**
 * 「库 → 每个助手的 `MEMORY.md`」这一跳的编排（读库、取助手名单、投影、回读）。
 *
 * 三处调用它：启动后的一次注入、设置页读记忆时、以及每次增删改之后。
 *
 * ⚠️ **助手名单从网关来**（`agents.list`），不从渲染层的目录缓存来：换账号 / 换盘 /
 *    刚建完助手这些时刻，渲染层的目录可能还是上一份。名单解析用与
 *    `ws/gateway-client.ts` 的 `isAgentListed` **同一形状**（`payload.agents[].id`）。
 */

import { memoryBlockEntryLines, selectMemoriesForQuery, type MemoryEntry } from '@clawwork/core';
import { getDebugLogger } from '../debug/index.js';
import { agentFileContent, materializeMemory, type MaterializeResult, type MemoryGatewayApi } from './materialize.js';
import { currentMemoryOwnerId } from './owner.js';
import { currentMemoryStore } from './store.js';

export interface MemorySyncGateway extends MemoryGatewayApi {
  listAgents(): Promise<Record<string, unknown>>;
}

export type MemorySyncOutcome =
  | { ok: true; agentIds: string[]; entries: MemoryEntry[]; result: MaterializeResult }
  | { ok: false; reason: 'db-unavailable' | 'no-agents' | 'list-failed' };

/** `agents.list` 载荷 → 助手 id（保持网关给的出现顺序，去重）。 */
export function agentIdsFromCatalog(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const agents = (payload as { agents?: unknown }).agents;
  if (!Array.isArray(agents)) return [];
  const ids: string[] = [];
  for (const agent of agents) {
    if (!agent || typeof agent !== 'object') continue;
    const id = (agent as { id?: unknown }).id;
    if (typeof id === 'string' && id.length > 0 && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * 把当前账号的**已确认**记忆投影到盘上每个助手的 `MEMORY.md`。
 *
 * ⚠️ 只投影 `status === 'confirmed'`：草案与已拒绝的条目**永不**进召回通道。
 *    账户维度在读取处生效 —— 换账号后这次同步写的是**新账号那批**，
 *    所以上一账号的记忆不会通过提示词泄给下一账号。
 */
export async function syncMemoryToAgents(input: {
  gateway: MemorySyncGateway;
  ownerUserId?: string;
  /**
   * T27 本地检索：**本轮提问**。给了就在"超出注入预算"时按相关度选子集
   * （`selectMemoriesForQuery`）；条目 ≤ 预算时原样全量，行为不变。
   */
  query?: string;
  /** 只投影给这些助手（缺省 = 网关名单里的全部）。 */
  agentIds?: readonly string[];
}): Promise<MemorySyncOutcome> {
  const store = currentMemoryStore();
  if (!store) return { ok: false, reason: 'db-unavailable' };
  const ownerUserId = input.ownerUserId ?? currentMemoryOwnerId();

  let agentIds: string[];
  if (input.agentIds && input.agentIds.length > 0) {
    agentIds = [...input.agentIds];
  } else {
    let catalog: Record<string, unknown>;
    try {
      catalog = await input.gateway.listAgents();
    } catch {
      return { ok: false, reason: 'list-failed' };
    }
    agentIds = agentIdsFromCatalog(catalog);
    if (agentIds.length === 0) return { ok: false, reason: 'no-agents' };
  }

  const all = store.list({ ownerUserId, status: 'confirmed' });
  const entries = selectMemoriesForQuery(all, input.query ?? '');
  const result = await materializeMemory({ gateway: input.gateway, agentIds, entries });
  return { ok: true, agentIds, entries, result };
}

/**
 * 启动期可以重试的失败：**只有"网关还没连上"这一种**。
 *
 * 现场（2026-10-17）：`kickMemoryInjection()` 在 `app.whenReady()` 里立刻发 `agents.list`，
 * 而 WS 握手晚几百毫秒 ⇒ 每次冷启动都撞 `GATEWAY_NOT_CONNECTED` → `list-failed`，
 * 三次实机启动无一例外。其余理由（库没开 / 网关说没有助手）重试也没用，
 * 拖成几十秒只会掩盖真正的原因。
 */
const RETRYABLE_SYNC_REASONS: readonly string[] = ['list-failed'];

/**
 * `syncMemoryToAgents` 的**启动期**包装：撞在握手之前就退避重试，直到连上或退避用尽。
 *
 * 与 `memory/contract.ts` 的 `ensureMemoryContractPromptWithRetry` 同形状 ——
 * 启动时那三个注入必须同一姿态，否则"契约写进去了、记忆没投影"这种半成品最难查。
 * 首档延迟取 1.5s（握手实测亚秒级），后面逐档拉开，总代价 ≤ 50s 且不挡窗口。
 */
export async function syncMemoryToAgentsWithRetry(
  gateway: MemorySyncGateway,
  options: { delaysMs?: readonly number[]; sleep?: (ms: number) => Promise<void> } = {},
): Promise<MemorySyncOutcome> {
  const delays = options.delaysMs ?? [1500, 5000, 15000, 30000];
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let outcome = await syncMemoryToAgents({ gateway });
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (outcome.ok || !RETRYABLE_SYNC_REASONS.includes(outcome.reason)) return outcome;
    const delay = delays[attempt];
    if (delay === undefined) break;
    getDebugLogger().info({
      domain: 'memory',
      event: 'memory.startup-sync.retry',
      data: { attempt: attempt + 1, reason: outcome.reason, delayMs: delay },
    });
    await sleep(delay);
    outcome = await syncMemoryToAgents({ gateway });
  }
  return outcome;
}

/**
 * 取证：**只读**地从每个助手的 `MEMORY.md` 里把受管区块的条目行读回来。
 *
 * 不写任何东西 —— 给"删除后确实不再召回"和"换账号读不到"两条验收提供可复现的证据。
 */
export async function readMemoryRecallSnapshot(input: {
  gateway: MemorySyncGateway;
  ownerUserId?: string;
}): Promise<{ ok: true; entries: MemoryEntry[]; files: Record<string, string[]> } | { ok: false; reason: string }> {
  const store = currentMemoryStore();
  if (!store) return { ok: false, reason: 'db-unavailable' };
  const ownerUserId = input.ownerUserId ?? currentMemoryOwnerId();
  let agentIds: string[] = [];
  try {
    agentIds = agentIdsFromCatalog(await input.gateway.listAgents());
  } catch {
    return { ok: false, reason: 'list-failed' };
  }
  const files: Record<string, string[]> = {};
  for (const agentId of agentIds) {
    try {
      const content = agentFileContent(await input.gateway.getAgentFile(agentId, 'MEMORY.md'));
      files[agentId] = content === null ? [] : memoryBlockEntryLines(content);
    } catch {
      files[agentId] = [];
    }
  }
  return { ok: true, entries: store.list({ ownerUserId, status: 'confirmed' }), files };
}
