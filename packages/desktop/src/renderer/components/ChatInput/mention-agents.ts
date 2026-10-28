import { resolvePerformerAgentName } from '@clawwork/shared';
import type { AgentMentionEntry } from '../MentionPicker';

/**
 * `@` 提及选择器里那一行 worker 显示什么 —— T-a7 家族**第三个**显示面。
 *
 * 症状（改之前）：旧房间（`RoomPerformer.agentName` 是裸 id 的存量脏数据）里
 * `@` 一个 worker，选择器显示 `partner-w-tpl-78b62899`；消息头与团队页早就正常了
 * （那两个面在 `45c672ba` 已改成目录优先），只有这里直接读 `p.agentName`。
 *
 * ⚠️ 顺带修好的是**搜索**：过滤是按 `agentName` 匹配的，名字是裸 id 时
 * 用户只能打出那串 id 才找得到人。
 *
 * 规则**不在这里重写** —— 统一走 `resolvePerformerAgentName`（目录 → 快照 → 裸 id）。
 * 这个函数只负责把 `performers` × 目录拼成选择器要的形状。
 *
 * `agentId` / `sessionKey` 原样带着：发消息时 `@` 的载荷用的是 **id**（`composer.send`
 * 的 `mentions`），名字纯展示。
 */
export function buildMentionAgents(params: {
  performers: ReadonlyArray<{ agentId: string; agentName?: string; emoji?: string; sessionKey: string }> | undefined;
  catalogAgents: ReadonlyArray<{ id: string; name?: string; identity?: { avatarUrl?: string } }> | undefined;
  gatewayId: string | undefined;
}): AgentMentionEntry[] {
  const { performers, catalogAgents, gatewayId } = params;
  if (!performers?.length) return [];

  const catalogById = new Map((catalogAgents ?? []).map((agent) => [agent.id, agent]));
  // 按 agentId 去重：同一个 agent 可能有好几个会话（重复 @ 会重复派活）
  const byAgent = new Map<string, AgentMentionEntry>();
  for (const performer of performers) {
    const catalogEntry = catalogById.get(performer.agentId);
    byAgent.set(performer.agentId, {
      agentId: performer.agentId,
      agentName: resolvePerformerAgentName(performer, catalogEntry),
      emoji: performer.emoji,
      avatarUrl: catalogEntry?.identity?.avatarUrl,
      gatewayId,
      sessionKey: performer.sessionKey,
    });
  }
  return [...byAgent.values()];
}
