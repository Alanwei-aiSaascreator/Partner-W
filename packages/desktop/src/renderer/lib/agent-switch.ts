import type { PendingNewTask } from '@clawwork/core';
import { removeAssistantTaskPresetTags } from '@/lib/assistant-task-preset-tags';

/**
 * 切助手时，把"打到一半的新任务"（`pendingNewTask`）整理成什么样。
 *
 * 抽成纯函数是因为这段逻辑**很细且两条路容易写反**：
 * - 换到**别的**助手 ⇒ 旧助手的任务预设标签（`assistant-preset:*`）作废，必须清掉，
 *   否则下一个任务会带着上一个助手的预设发出去；
 * - 点的是**同一个**助手 ⇒ 标签保留（用户自己选的，别悄悄丢掉）。
 *
 * 其余字段（model / thinkingLevel / ensemble / teamId）原样带过去 —— 它们与助手无关。
 */
export function resolvePendingAfterAgentSwitch(
  pending: PendingNewTask | null,
  gatewayId: string,
  agentId: string,
): PendingNewTask {
  const sameScope = pending?.gatewayId === gatewayId && pending.agentId === agentId;
  const { tags: _previousTags, ...pendingWithoutTags } = pending ?? {};
  const tags = sameScope ? pending?.tags : removeAssistantTaskPresetTags(pending?.tags ?? []);
  return {
    ...(sameScope ? pending : pendingWithoutTags),
    gatewayId,
    agentId,
    ...(tags && tags.length > 0 ? { tags } : {}),
  };
}
