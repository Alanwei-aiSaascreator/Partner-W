import type { AgentInfo, ModelCatalogEntry, Team } from '@clawwork/shared';
import { canonicalModelRef } from '@/lib/team-model-ref';
import { relayModelsFrom } from '@/components/ChatInput/model-families';
import type { MeetingMember } from './plan';

export function meetingCatalog(
  team: Team,
  agents: AgentInfo[],
  catalog: ModelCatalogEntry[],
): { members: MeetingMember[]; models: string[] } {
  const available = relayModelsFrom(catalog).filter((entry) => entry.available !== false);
  const models = [...new Set(available.map(canonicalModelRef).filter(Boolean))];
  const members = team.agents.flatMap((member) => {
    const agent = agents.find((entry) => entry.id === member.agentId);
    if (!agent) return [];
    const requested = agent.model?.primary?.trim() ?? '';
    const matches = available.filter((entry) => entry.id === requested || canonicalModelRef(entry) === requested);
    return [
      {
        agentId: agent.id,
        name: agent.identity?.name || agent.name || agent.id,
        model: matches.length === 1 ? canonicalModelRef(matches[0]) : requested,
      },
    ];
  });
  return { members, models };
}
