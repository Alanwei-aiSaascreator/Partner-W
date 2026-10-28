import type { AgentInfo, ModelCatalogEntry, Team } from '@clawwork/shared';
import { canonicalModelRef } from '@/lib/team-model-ref';
import { selectableModelsFrom } from '@/components/ChatInput/model-families';
import type { MeetingMember } from './plan';

export function meetingCatalog(
  team: Team,
  agents: AgentInfo[],
  catalog: ModelCatalogEntry[],
): { members: MeetingMember[]; models: string[] } {
  // 2026-10-12：与建队/发送同一把尺（selectableModelsFrom 含剔除模式别名——会议角色不会解析到内部别名）。
  const available = selectableModelsFrom(catalog);
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
