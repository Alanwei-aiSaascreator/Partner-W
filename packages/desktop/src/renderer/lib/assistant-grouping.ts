import type { AgentInfo, Team } from '@clawwork/shared';

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
  const defaultAgent = catalog.get(input.defaultAgentId ?? 'main');
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
