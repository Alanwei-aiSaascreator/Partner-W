/**
 * **每轮**的长记忆检索（T27，2026-10-16）。
 *
 * ## 为什么需要单独一跳
 *
 * 平时的投影（新增/删除/启动/设置页）没有"当前提问"，只能是**全量**。而条目一旦超过
 * `MEMORY_RECALL_TOP_N`，全量就会把排在后面的记忆挤出提示词 —— 那条记忆用户以为记住了，
 * 实际从没被读到。本模块在**发送前**用这一句提问把相关的那批投影下去。
 *
 * ## 三条硬约束（都是"别把它做成有害的东西"来的）
 *
 * 1. **不超预算就不做**：已确认条目 ≤ `MEMORY_RECALL_TOP_N` 时直接返回 `below-limit`，
 *    **一次网关往返都不发** —— 绝大多数用户是这个情况，行为与从前逐字一致。
 * 2. **只投给这条会话自己的助手**：每轮给盘上 7 个助手各写一遍是纯浪费；
 *    别的助手在下一次常规投影时会拿到完整集合。
 * 3. **永不抛、永不阻塞发送**：检索/写文件任何一步失败都只记日志，
 *    调用方**不得**因为记忆没同步上而拒绝发消息（记忆是增强，不是发送的前置条件）。
 */

import { MEMORY_RECALL_TOP_N } from '@clawwork/core';
import { getDebugLogger } from '../debug/index.js';
import { currentMemoryOwnerId } from './owner.js';
import { currentMemoryStore } from './store.js';
import { syncMemoryToAgents, type MemorySyncGateway } from './sync.js';

export type RecallTurnOutcome =
  | { status: 'below-limit'; confirmed: number }
  | { status: 'synced'; confirmed: number; projected: number }
  | { status: 'skipped'; reason: string };

/**
 * 发送前的一次检索投影。**调用方不要 await 它去做发送的门禁**（见上面第 3 条）——
 * 允许 await 只为"让这一轮真的读到"，但必须容忍它失败。
 */
export async function recallMemoriesForTurn(input: {
  gateway: MemorySyncGateway;
  agentId: string;
  query: string;
  ownerUserId?: string;
}): Promise<RecallTurnOutcome> {
  const store = currentMemoryStore();
  if (!store) return { status: 'skipped', reason: 'db-unavailable' };
  const ownerUserId = input.ownerUserId ?? currentMemoryOwnerId();
  const confirmed = store.list({ ownerUserId, status: 'confirmed' });
  if (confirmed.length <= MEMORY_RECALL_TOP_N) return { status: 'below-limit', confirmed: confirmed.length };
  if (!input.query.trim()) return { status: 'skipped', reason: 'empty-query' };

  const outcome = await syncMemoryToAgents({
    gateway: input.gateway,
    ownerUserId,
    query: input.query,
    agentIds: [input.agentId],
  });
  if (!outcome.ok) {
    getDebugLogger().warn({
      domain: 'memory',
      event: 'memory.recall-turn.failed',
      data: { reason: outcome.reason, agentId: input.agentId },
    });
    return { status: 'skipped', reason: outcome.reason };
  }
  getDebugLogger().info({
    domain: 'memory',
    event: 'memory.recall-turn.projected',
    data: {
      agentId: input.agentId,
      confirmed: confirmed.length,
      projected: outcome.entries.length,
    },
  });
  return { status: 'synced', confirmed: confirmed.length, projected: outcome.entries.length };
}
