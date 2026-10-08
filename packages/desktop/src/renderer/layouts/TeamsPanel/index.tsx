import { useState, useCallback, useEffect, useMemo } from 'react';
import { Users, Plus, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import type { Team, TeamHubEntry } from '@clawwork/shared';
import { cn } from '@/lib/utils';
import WindowTitlebar from '@/components/semantic/WindowTitlebar';
import EmptyState from '@/components/semantic/EmptyState';
import ConfirmDialog from '@/components/semantic/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useTeamStore } from '@/stores/teamStore';
import { useTaskStore, useUiStore } from '@/platform';
import { decideTeamChatEntry } from '@/lib/team-chat-entry';
import TeamCard from './TeamCard';
import TeamDetailView from './TeamDetailView';
import TeamHubDetailView from './TeamHubDetailView';
import CreateTeamWizard from './CreateTeamWizard';
import TeamBuilderDialog from '@/components/TeamBuilderDialog';
import TeamsHubTab from './TeamsHubTab';
import TeamRoundtable from './TeamRoundtable';

export default function TeamsPanel() {
  const { t } = useTranslation();
  const teamsMap = useTeamStore((s) => s.teams);
  const loadTeams = useTeamStore((s) => s.loadTeams);
  const deleteTeamAction = useTeamStore((s) => s.deleteTeam);
  const startNewTask = useTaskStore((s) => s.startNewTask);
  const setMainView = useUiStore((s) => s.setMainView);
  const setSelectedAgent = useUiStore((s) => s.setSelectedAgent);
  const defaultGatewayId = useUiStore((s) => s.defaultGatewayId);
  // ⭐ "这个团队的助手装在这台机器上吗"要拿**那个团队所属网关**的目录来判
  //    （团队自己带 `gatewayId`，与当前默认网关未必是同一个）。
  const agentCatalogByGateway = useUiStore((s) => s.agentCatalogByGateway);
  const [activeTab, setActiveTab] = useState<'myTeams' | 'hub'>('myTeams');
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [editTeam, setEditTeam] = useState<Team | null>(null);
  const [deletingTeamId, setDeletingTeamId] = useState<string | null>(null);
  const [selectedHubEntry, setSelectedHubEntry] = useState<(TeamHubEntry & { _registryId: string }) | null>(null);

  const teams = useMemo(() => Object.values(teamsMap), [teamsMap]);

  /**
   * ⭐ C3：哪些团队**要进的那个助手不在本机**。
   *
   * ⚠️ 判据与 `handleStartChat` 用的是**同一个** `decideTeamChatEntry` ——
   *    两处各判一次就迟早只改一处（卡片说"能聊"、点下去却被拒，那种自相矛盾最伤信任）。
   * ⚠️ 目录还没拉回来时它是 `loading`，**不算缺装** —— 那时卡片不该报"需要安装"。
   */
  const teamsNeedingInstall = useMemo(() => {
    const ids = new Set<string>();
    for (const team of teams) {
      const decision = decideTeamChatEntry({ agents: team.agents, catalog: agentCatalogByGateway[team.gatewayId] });
      if (decision.kind === 'agent-missing') ids.add(team.id);
    }
    return ids;
  }, [teams, agentCatalogByGateway]);

  useEffect(() => {
    loadTeams();
  }, [loadTeams]);

  const handleStartChat = useCallback(
    (teamId: string) => {
      const team = teamsMap[teamId];
      if (!team) {
        toast.error(t('teams.noAgents'));
        return;
      }
      // ⭐ 团队是**跟着盘**走的，助手是不是装在这台机器上是另一回事（换台机器插同一块盘，
      //    花名册在、助手不在）。判据收在 `decideTeamChatEntry` 里，它同时管着
      //    "目录还没拉回来时**不许**判缺失"那条（否则会误报，让人去装一个已经装好的助手）。
      const decision = decideTeamChatEntry({
        agents: team.agents,
        catalog: agentCatalogByGateway[team.gatewayId],
      });
      if (decision.kind !== 'start') {
        // ⚠️ **不跳进会话**：跳过去那一屏才会说"这个助手不在本机"，
        //    用户白跳一趟还要自己退回来。当面说清楚。
        // ⚠️ 用 `teams.agentNotInstalled` 而**不是** `agentMissing`：后者已经存在，
        //    属于聊天输入那条路，说的是"换一个助手再发送"—— 而这里要说的是
        //    "**这个团队的成员不在这台电脑上**"。两条路的下一步不一样，文案不许互相借用。
        //    （2026-10-06 BUG-025：措辞里不再出现"装"——正式产品结构不是 Agent Store。）
        toast.error(t(decision.kind === 'agent-missing' ? 'teams.agentNotInstalled' : 'teams.noAgents'));
        return;
      }
      // 可靠模式：团队任务先固定由主管（或第一位成员）单独完成完整工作流。
      // `teamId` 刻意保留，未来增加“创作者 → 复审者”的顺序执行时仍能找到原团队，
      // 但不再把成员数映射成 ensemble/conductor/sessions_spawn。
      setSelectedAgent(team.gatewayId, decision.agentId);
      startNewTask({ gatewayId: team.gatewayId, agentId: decision.agentId, ensemble: false, teamId });
      setMainView('chat');
    },
    [teamsMap, agentCatalogByGateway, startNewTask, setMainView, setSelectedAgent, t],
  );

  const handleEdit = useCallback(
    (teamId: string) => {
      const team = teamsMap[teamId];
      if (!team) return;
      setEditTeam(team);
      setWizardOpen(true);
    },
    [teamsMap],
  );

  const handleDelete = useCallback((teamId: string) => {
    setDeletingTeamId(teamId);
  }, []);

  const confirmDelete = useCallback(() => {
    if (deletingTeamId) deleteTeamAction(deletingTeamId);
    setDeletingTeamId(null);
  }, [deletingTeamId, deleteTeamAction]);

  const handleWizardClose = useCallback((open: boolean) => {
    if (!open) setEditTeam(null);
    setWizardOpen(open);
  }, []);

  const deletingTeam = deletingTeamId ? teamsMap[deletingTeamId] : null;
  const selectedTeam = selectedTeamId ? teamsMap[selectedTeamId] : null;

  return (
    <>
      {selectedTeam ? (
        <TeamDetailView
          team={selectedTeam}
          onBack={() => setSelectedTeamId(null)}
          onStartChat={() => handleStartChat(selectedTeam.id)}
          onEdit={() => handleEdit(selectedTeam.id)}
        />
      ) : selectedHubEntry ? (
        <TeamHubDetailView entry={selectedHubEntry} onBack={() => setSelectedHubEntry(null)} />
      ) : (
        <div className="flex flex-col h-full">
          <WindowTitlebar
            left={
              <div className="flex items-center gap-4">
                {(['myTeams', 'hub'] as const).map((tab) => (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    className={cn(
                      'type-body transition-colors',
                      activeTab === tab
                        ? 'text-[var(--text-primary)]'
                        : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]',
                    )}
                  >
                    {tab === 'myTeams' ? t('teamshub.tabMyTeams') : t('teamshub.tabHub')}
                  </button>
                ))}
              </div>
            }
            right={
              activeTab === 'myTeams' && teams.length > 0 ? (
                // ⭐ 2026-10-06（V1 收口 · 任务 08）：创建入口**保留但视觉弱化** —— 这一页的
                //    主角是「我的 AI 团队」圆桌（主罗盘 + 五岗位），不是"拉人建队"。
                <div className="flex items-center gap-1">
                  <Button size="sm" variant="ghost" onClick={() => setBuilderOpen(true)}>
                    <Sparkles size={14} />
                    {t('teams.teamBuilderTitle')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setEditTeam(null);
                      setWizardOpen(true);
                    }}
                  >
                    <Plus size={14} />
                    {t('teams.createTeam')}
                  </Button>
                </div>
              ) : undefined
            }
          />

          <ScrollArea className="flex-1 px-5 py-4">
            {activeTab === 'myTeams' ? (
              <div className="space-y-4">
                {/* ⭐ 默认页的主角：主罗盘 + 五岗位的轻量圆桌（状态只来自真实会议信号）。
                    ⚠️ 2026-10-07（质检 P3-6）：**一个团队都没有时不开圆桌** —— 新用户会先看到
                    五个岗位齐刷刷"未启用"、再看到下面"创建团队"，那是两遍空话。
                    收成一句说明，等真有团队了再把圆桌摆出来。 */}
                {teams.length === 0 ? (
                  <p data-testid="roundtable-empty-hint" className="type-meta text-[var(--text-muted)]">
                    {t('teams.roundtable.emptyHint')}
                  </p>
                ) : (
                  <TeamRoundtable />
                )}
                {teams.length === 0 ? (
                  <EmptyState
                    icon={<Users size={24} className="text-[var(--text-muted)]" />}
                    title={t('teams.emptyTitle')}
                    description={t('teams.emptyDesc')}
                    action={
                      <div className="flex items-center gap-1">
                        <Button size="sm" variant="ghost" onClick={() => setBuilderOpen(true)}>
                          <Sparkles size={14} />
                          {t('teams.teamBuilderTitle')}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setEditTeam(null);
                            setWizardOpen(true);
                          }}
                        >
                          <Plus size={14} />
                          {t('teams.createTeam')}
                        </Button>
                      </div>
                    }
                  />
                ) : (
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(var(--content-card-min),1fr))] gap-4">
                    {teams.map((team) => (
                      <TeamCard
                        key={team.id}
                        team={team}
                        needsInstall={teamsNeedingInstall.has(team.id)}
                        onSelect={() => setSelectedTeamId(team.id)}
                        onStartChat={() => handleStartChat(team.id)}
                        onEdit={() => handleEdit(team.id)}
                        onDelete={() => handleDelete(team.id)}
                      />
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <TeamsHubTab onSelectEntry={setSelectedHubEntry} />
            )}
          </ScrollArea>
        </div>
      )}

      <CreateTeamWizard
        open={wizardOpen}
        onOpenChange={handleWizardClose}
        defaultGatewayId={defaultGatewayId ?? ''}
        editTeam={editTeam}
      />

      <TeamBuilderDialog
        open={builderOpen}
        onOpenChange={setBuilderOpen}
        gatewayId={defaultGatewayId ?? ''}
        onCreated={loadTeams}
      />

      <ConfirmDialog
        open={!!deletingTeam}
        variant="danger"
        title={t('teams.confirmDeleteTitle')}
        description={t('teams.confirmDeleteDesc', { name: deletingTeam?.name ?? '' })}
        onConfirm={confirmDelete}
        onCancel={() => setDeletingTeamId(null)}
      />
    </>
  );
}
