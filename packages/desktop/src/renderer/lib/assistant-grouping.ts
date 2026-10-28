import { resolveCatalogAgentId } from '@clawwork/core';
import type { AgentInfo, Team } from '@clawwork/shared';
import { ASSISTANT_ID_BY_WORKSPACE } from '@/lib/assistant-task-presets';

export function groupAssistants(input: {
  agents: readonly AgentInfo[];
  teams: readonly Team[];
  gatewayId?: string;
  defaultAgentId?: string;
}): {
  defaultAgent: AgentInfo | undefined;
  teams: Array<{ team: Team; agents: AgentInfo[] }>;
  independent: AgentInfo[];
} {
  const catalog = new Map<string, AgentInfo>();
  for (const agent of input.agents) {
    if (!catalog.has(agent.id)) catalog.set(agent.id, agent);
  }
  /**
   * ⭐ 2026-10-07（质检 P2-2）：默认助手与左栏用**同一份判据**（core `resolveCatalogAgentId`：
   * 网关默认 id 必须在目录里、目录只有一位时那位就是默认，**拒绝"目录第一个"兜底**），
   * 解不出来时缺省固定**主罗盘**。
   *
   * ⚠️ 老写法 `catalog.get(input.defaultAgentId ?? 'main')` 有个空串 bug：
   *    `'' ?? 'main'` 得 `''`（`??` 只认 null/undefined）⇒ 网关没给默认值时主罗盘**不会**
   *    被钉成默认行，反而掉进「技能与能力」折叠组。
   */
  const defaultAgentId =
    resolveCatalogAgentId({ defaultId: input.defaultAgentId, agents: input.agents }) ??
    ASSISTANT_ID_BY_WORKSPACE.compass;
  const defaultAgent = catalog.get(defaultAgentId);
  const claimed = new Set(defaultAgent ? [defaultAgent.id] : []);
  const teams = input.teams
    .filter((team) => team.gatewayId === input.gatewayId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .map((team) => {
      const agents: AgentInfo[] = [];
      for (const member of team.agents) {
        const agent = catalog.get(member.agentId);
        if (!agent || claimed.has(agent.id)) continue;
        claimed.add(agent.id);
        agents.push(agent);
      }
      return { team, agents };
    })
    .filter((group) => group.agents.length > 0);
  return { defaultAgent, teams, independent: [...catalog.values()].filter((agent) => !claimed.has(agent.id)) };
}
