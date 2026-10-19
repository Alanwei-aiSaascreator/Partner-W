/**
 * **助手提记忆草案**的入口（本轮之前完全没实施的那一半）。
 *
 * ## 它接在哪条缝上
 *
 * 助手回复的终态消息在主进程落库那一步（`ipc/data-handlers.ts` 的
 * `finalizeAssistantArtifacts` 旁边，**与交付链完全解耦**：不消费 artifact run、
 * 不影响登记回执）。这里只做一件事：扫出回复里的 ```memory 块，落成 `pending` 草案。
 *
 * ## 🔴 三条不许破的纪律
 *
 * · **草案不落召回通道**：草案只进库，**绝不**写 `MEMORY.md` —— 那个文件每轮全文进提示词，
 *   写进去就等于"用户还没点头已经被记住了"（产品口径：一期不做自动写入）。
 * · **重复不重复提醒**：库里已有同一件事（pending/confirmed/rejected 任一）⇒ 什么都不做。
 *   这是"拒绝之后不再重复提同一件"的落点。
 * · **永不抛、永不挡交付**：解析/写库出任何问题都只留一条日志。
 *   记忆是**附加价值**，不能因为它把一条正常回复的收尾搞挂。
 */

import { scanMemoryDraftFences } from '@clawwork/core';
import { getDebugLogger } from '../debug/index.js';
import { currentMemoryOwnerId } from './owner.js';
import { currentMemoryStore } from './store.js';

export interface MemoryDraftIntakeInput {
  content: string;
  taskId?: string;
  messageId?: string;
  /** 归属账号，仅供测试注入；默认取当前绑定账号。 */
  ownerUserId?: string;
  /** 草案建立时的广播口子（测试注入）。默认往所有窗口发 `memory:draft-proposed`。 */
  notify?: (payload: { count: number }) => void;
}

export interface MemoryDraftIntakeResult {
  created: number;
  duplicate: number;
  discarded: number;
  overflow: number;
  /** 库还没打开 / 拿不到 → 0，且**不假装成功**。 */
  skipped: boolean;
}

/**
 * 扫一条助手回复，把草案落到库。**同步、永不抛**（sqlite 调用是同步的）。
 */
export function collectMemoryDrafts(input: MemoryDraftIntakeInput): MemoryDraftIntakeResult {
  const result: MemoryDraftIntakeResult = { created: 0, duplicate: 0, discarded: 0, overflow: 0, skipped: false };
  try {
    if (typeof input.content !== 'string' || input.content.length === 0) {
      result.skipped = true;
      return result;
    }
    const scan = scanMemoryDraftFences(input.content);
    result.discarded = scan.discarded;
    result.overflow = scan.overflow;
    if (scan.proposals.length === 0) return result;

    const store = currentMemoryStore();
    if (!store) {
      // 库没打开（冷启动 / 工作区没准备好）：**如实跳过**，不落半条。
      getDebugLogger().warn({ domain: 'memory', event: 'memory.draft.skipped', data: { reason: 'db-unavailable' } });
      result.skipped = true;
      return result;
    }

    const ownerUserId = input.ownerUserId ?? currentMemoryOwnerId();
    for (const proposal of scan.proposals) {
      const outcome = store.propose({
        ownerUserId,
        text: proposal.text,
        sourceTaskId: input.taskId ?? null,
        sourceMessageId: input.messageId ?? null,
      });
      if (outcome.ok) result.created += 1;
      else if (outcome.reason === 'duplicate') result.duplicate += 1;
      else result.discarded += 1;
    }

    if (result.created > 0) {
      getDebugLogger().info({
        domain: 'memory',
        event: 'memory.draft.proposed',
        data: { created: result.created, duplicate: result.duplicate, taskId: input.taskId ?? null },
      });
      input.notify?.({ count: result.created });
    }
    return result;
  } catch (error) {
    getDebugLogger().warn({
      domain: 'memory',
      event: 'memory.draft.failed',
      data: { reason: error instanceof Error ? error.message : 'unknown' },
    });
    result.skipped = true;
    return result;
  }
}
