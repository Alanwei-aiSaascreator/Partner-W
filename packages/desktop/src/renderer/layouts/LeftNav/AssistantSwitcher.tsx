import { useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, ChevronRight, Plus, Sparkles, Users } from 'lucide-react';
import type { AgentInfo, Team, TeamAgent } from '@clawwork/shared';
import AgentIcon from '@/components/AgentIcon';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { groupAssistants } from '@/lib/assistant-grouping';
import { resolveAgentDisplayNameKey } from '@/lib/preset-agents';
import { cn } from '@/lib/utils';

export interface AssistantSwitcherProps {
  agents: AgentInfo[];
  teams?: Team[];
  gatewayId?: string;
  defaultAgentId?: string;
  selectedAgentId: string;
  onSelect: (agentId: string) => void;
  onAddAssistant: () => void;
  collapsed?: boolean;
}

const EMPTY_TEAMS: Team[] = [];

function agentLabel(agent: AgentInfo, t: (k: string) => string): string {
  const key = resolveAgentDisplayNameKey(agent.id);
  return key ? t(key) : agent.identity?.name || agent.name || agent.id;
}

export default function AssistantSwitcher({
  agents,
  teams = EMPTY_TEAMS,
  gatewayId,
  defaultAgentId,
  selectedAgentId,
  onSelect,
  onAddAssistant,
  collapsed = false,
}: AssistantSwitcherProps) {
  const { t } = useTranslation();
  const groupId = useId();
  const [open, setOpen] = useState(false);
  const [expandedTeams, setExpandedTeams] = useState<Record<string, boolean>>({});
  /**
   * ⭐ 2026-10-06（V1 收口 · 呈现层降级）：六类预置助手（内容创作/电商运营/拍摄剪辑/高效办公/
   * 学习研究/生活家庭）**不再是一级身份**，它们是 Skill/能力。默认视图 = 主罗盘 + 用户团队；
   * 这组助手收进**次级折叠组**（文案「技能与能力」，`leftNav.independentAssistants`），
   * 默认收起、点开才出现 —— 别把它们删掉，也别改成一级列表。
   */
  const [skillsOpen, setSkillsOpen] = useState(false);
  const groups = useMemo(
    () => groupAssistants({ agents, teams, gatewayId, defaultAgentId }),
    [agents, teams, gatewayId, defaultAgentId],
  );
  const selectedTeam = groups.teams.find((group) => group.agents.some((agent) => agent.id === selectedAgentId));
  const selectedTeamId = selectedTeam?.team.id;
  useEffect(() => {
    if (selectedTeamId) setExpandedTeams((previous) => ({ ...previous, [selectedTeamId]: true }));
  }, [selectedTeamId]);

  const current =
    agents.find((agent) => agent.id === selectedAgentId) ??
    (selectedAgentId ? undefined : (groups.defaultAgent ?? agents[0]));
  const currentLabel = current ? agentLabel(current, t) : t('leftNav.myAssistants');
  const missing = !current && Boolean(selectedAgentId);
  const currentMember = selectedTeam?.team.agents.find((member) => member.agentId === current?.id);

  function icon(agent: AgentInfo, member?: TeamAgent) {
    return (
      <AgentIcon
        gatewayId={gatewayId}
        agentId={agent.id}
        gatewayAvatarUrl={agent.identity?.avatarUrl}
        emoji={agent.identity?.emoji}
        position={member?.position}
        role={member?.role}
        iconSize={18}
        imgClass="h-5 w-5 shrink-0 rounded object-cover"
        iconClass="shrink-0 text-[var(--text-secondary)]"
      />
    );
  }

  function agentRow(agent: AgentInfo, member?: TeamAgent) {
    const selected = agent.id === selectedAgentId;
    return (
      <li key={agent.id}>
        <button
          type="button"
          data-agent={agent.id}
          aria-current={selected ? 'true' : undefined}
          onClick={() => {
            onSelect(agent.id);
            setOpen(false);
          }}
          className={cn(
            'glow-focus flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left type-body transition-colors',
            selected
              ? 'bg-[var(--state-selected)] text-[var(--text-primary)]'
              : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
          )}
        >
          {icon(agent, member)}
          <span className="min-w-0 flex-1 truncate" title={agentLabel(agent, t)}>
            {agentLabel(agent, t)}
          </span>
          {agent.id === groups.defaultAgent?.id && (
            <span className="type-meta text-[var(--text-muted)]">{t('settings.agentDefault')}</span>
          )}
          {selected && <Check size={14} className="shrink-0 text-[var(--accent)]" />}
        </button>
      </li>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="assistant-switcher"
          data-missing={missing ? 'true' : undefined}
          aria-label={
            missing
              ? `${t('leftNav.myAssistants')} — ${t('agent.missingTitle', { agentId: selectedAgentId })}`
              : t('leftNav.myAssistants')
          }
          className={cn(
            'titlebar-no-drag glow-focus relative flex w-full items-center rounded-md text-left type-body text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] data-[state=open]:bg-[var(--bg-hover)] data-[state=open]:text-[var(--text-primary)]',
            collapsed ? 'justify-center py-2' : 'gap-2.5 px-2.5 py-1.5',
          )}
        >
          {current ? (
            icon(current, currentMember)
          ) : (
            <span className="h-5 w-5 shrink-0 rounded bg-[var(--bg-tertiary)]" />
          )}
          <span className={cn('min-w-0 flex-1 truncate font-semibold', collapsed && 'hidden')}>{currentLabel}</span>
          <ChevronDown size={14} className={cn('shrink-0 opacity-70', collapsed && 'hidden')} />
          {collapsed && missing && (
            <span
              data-testid="assistant-missing-dot"
              className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-[var(--warning)]"
            />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent side="right" align="start" className="w-72 p-1">
        <ul aria-label={t('leftNav.myAssistants')} className="max-h-96 overflow-y-auto">
          {groups.defaultAgent && agentRow(groups.defaultAgent)}
          {groups.teams.map(({ team, agents: members }) => {
            const expanded = expandedTeams[team.id] ?? false;
            const contentId = `${groupId}-${team.id}`;
            return (
              <li key={team.id} data-team={team.id} className="border-t border-[var(--border-subtle)] py-1">
                <button
                  type="button"
                  aria-expanded={expanded}
                  aria-controls={contentId}
                  onClick={() => setExpandedTeams((previous) => ({ ...previous, [team.id]: !expanded }))}
                  className="glow-focus flex w-full items-center gap-2 rounded-md px-2 py-2 text-left type-label text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                >
                  {expanded ? (
                    <ChevronDown size={14} className="shrink-0" />
                  ) : (
                    <ChevronRight size={14} className="shrink-0" />
                  )}
                  <Users size={16} className="shrink-0" />
                  <span className="min-w-0 flex-1 truncate" title={team.name}>
                    {team.name}
                  </span>
                  <span className="type-meta text-[var(--text-muted)]">{members.length}</span>
                </button>
                <ul id={contentId} hidden={!expanded} className="pl-4">
                  {members.map((agent) =>
                    agentRow(
                      agent,
                      team.agents.find((member) => member.agentId === agent.id),
                    ),
                  )}
                </ul>
              </li>
            );
          })}
          {groups.independent.length > 0 && (
            <li data-independent-assistants className="border-t border-[var(--border-subtle)] pt-1">
              {/* 次级折叠组：标题本身就是开关（`aria-expanded` 是判据，测试钉在它上面）。 */}
              <button
                type="button"
                aria-expanded={skillsOpen}
                aria-controls={`${groupId}-skills`}
                onClick={() => setSkillsOpen((previous) => !previous)}
                className="glow-focus flex w-full items-center gap-2 rounded-md px-2 py-2 text-left type-label text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
              >
                {skillsOpen ? (
                  <ChevronDown size={14} className="shrink-0" />
                ) : (
                  <ChevronRight size={14} className="shrink-0" />
                )}
                <Sparkles size={16} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate" title={t('leftNav.independentAssistants')}>
                  {t('leftNav.independentAssistants')}
                </span>
                <span className="type-meta text-[var(--text-muted)]">{groups.independent.length}</span>
              </button>
              <ul id={`${groupId}-skills`} hidden={!skillsOpen}>
                {groups.independent.map((agent) => {
                  return agentRow(agent);
                })}
              </ul>
            </li>
          )}
        </ul>
        <div className="my-1 border-t border-[var(--border-subtle)]" />
        <button
          type="button"
          data-action="add-assistant"
          onClick={() => {
            setOpen(false);
            onAddAssistant();
          }}
          className="glow-focus flex w-full items-center gap-2 rounded-md px-2 py-2 text-left type-body text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        >
          <Plus size={15} className="shrink-0" />
          <span className="truncate">{t('leftNav.addAssistant')}</span>
        </button>
      </PopoverContent>
    </Popover>
  );
}
