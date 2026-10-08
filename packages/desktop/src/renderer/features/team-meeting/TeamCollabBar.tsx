import { useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Loader2,
  MinusCircle,
  Users,
} from 'lucide-react';
import { useTaskStore, useUiStore } from '@/platform';
import { useTeamStore } from '@/stores/teamStore';
import { cn } from '@/lib/utils';
import { teamMeetingController, useTeamMeetingStore } from './instance';
import { recordPhase, turnsPhase, type MeetingPhase } from './status';

/**
 * 聊天页的「团队协作」条（2026-10-06，V1 收口 · 任务 10/11）。
 *
 * - **可折叠**，默认收起；收起时只有一行：团队名 + 状态灯。
 * - **参与岗位 + 状态，只来自真实信号**：团队花名册（`Team.agents`，真实数据）+
 *   最近一次团队开会的 `MeetingTurn` 真实 status（映射见 `status.ts`）。
 *   **没有真实信号 ⇒ 显「未启用」**（未入团队）或「待命」；这里**不许**出现任何假进度。
 * - 只是**展示层**：不写记录、不改 controller（`load()` 是既有的一次性拉取）。
 */
type BarStatus = MeetingPhase | 'disabled';

const STATUS_CLASSES: Record<BarStatus, string> = {
  idle: 'text-[var(--text-muted)]',
  working: 'text-[var(--accent)]',
  done: 'text-[var(--accent)]',
  attention: 'text-[var(--text-warning)]',
  disabled: 'text-[var(--text-muted)] opacity-70',
};

function StatusIcon({ status }: { status: BarStatus }) {
  const className = cn('h-3 w-3 shrink-0', STATUS_CLASSES[status]);
  if (status === 'working') return <Loader2 className={cn(className, 'animate-spin')} />;
  if (status === 'done') return <CheckCircle2 className={className} />;
  if (status === 'attention') return <AlertTriangle className={className} />;
  if (status === 'disabled') return <MinusCircle className={className} />;
  return <Circle className={className} />;
}

export default function TeamCollabBar({ taskId }: { taskId: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const contentId = useId();
  const task = useTaskStore((s) => s.tasks.find((row) => row.id === taskId));
  const team = useTeamStore((s) => (task?.teamId ? s.teams[task.teamId] : undefined));
  const agents = useUiStore((s) => (team?.gatewayId ? s.agentCatalogByGateway[team.gatewayId]?.agents : undefined));
  const records = useTeamMeetingStore((s) => s.records);
  const loaded = useTeamMeetingStore((s) => s.loaded);

  useEffect(() => {
    if (!loaded) void teamMeetingController.load().catch(() => {});
  }, [loaded]);

  const catalogById = useMemo(() => new Map((agents ?? []).map((agent) => [agent.id, agent])), [agents]);
  const latest = useMemo(
    () =>
      records
        .filter((entry) => entry.teamId === team?.id)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt))[0],
    [records, team?.id],
  );

  // ⚠️ 2026-10-07（质检 P3-1）：**"还没开会"不是"未启用"**。没入团队才是「未启用」；
  //    在团队里但一次会都没开过 ⇒ 如实说「待命」（`meeting.collabNoMeeting` 在展开区解释）。
  const overall: BarStatus = !team ? 'disabled' : !latest ? 'idle' : recordPhase(latest);
  const members = useMemo(
    () =>
      (team?.agents ?? []).map((member) => {
        const turns = latest ? latest.turns.filter((turn) => turn.agentId === member.agentId) : [];
        const phase: MeetingPhase = turnsPhase(turns) ?? 'idle';
        return {
          agentId: member.agentId,
          name: catalogById.get(member.agentId)?.name ?? member.agentId,
          positionKey: member.position ? `teams.position.${member.position}` : null,
          manager: member.isManager,
          phase,
        };
      }),
    [team?.agents, latest, catalogById],
  );

  if (!task) return null;

  return (
    <section
      data-testid="team-collab-bar"
      data-status={overall}
      className="flex-shrink-0 border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)]"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen((previous) => !previous)}
        className="glow-focus flex w-full items-center gap-2 px-5 py-1.5 text-left type-meta text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)]"
      >
        {open ? <ChevronDown size={13} className="shrink-0" /> : <ChevronRight size={13} className="shrink-0" />}
        <Users size={14} className="shrink-0" />
        <span className="shrink-0 text-[var(--text-primary)]">{t('meeting.collabTitle')}</span>
        {team && <span className="min-w-0 truncate">· {team.name}</span>}
        <span className={cn('ml-auto flex shrink-0 items-center gap-1', STATUS_CLASSES[overall])}>
          <StatusIcon status={overall} />
          {t(`teams.roundtable.status.${overall}`)}
        </span>
      </button>
      {open && (
        <div id={contentId} className="px-5 pb-2">
          {!team ? (
            <p className="type-meta text-[var(--text-muted)]">{t('meeting.collabNotTeam')}</p>
          ) : (
            <>
              {!latest && <p className="type-meta text-[var(--text-muted)]">{t('meeting.collabNoMeeting')}</p>}
              <p className="type-meta text-[var(--text-muted)]">{t('meeting.collabMembers')}</p>
              <ul className="mt-1 space-y-1">
                {members.map((member) => (
                  <li key={member.agentId} className="flex items-center gap-2 type-meta">
                    <span className="min-w-0 truncate text-[var(--text-primary)]">{member.name}</span>
                    <span className="shrink-0 text-[var(--text-muted)]">
                      {member.positionKey
                        ? t(member.positionKey)
                        : t(member.manager ? 'teams.wizard.coordinator' : 'teams.wizard.worker')}
                    </span>
                    <span className={cn('ml-auto flex shrink-0 items-center gap-1', STATUS_CLASSES[member.phase])}>
                      <StatusIcon status={member.phase} />
                      {t(`teams.roundtable.status.${member.phase}`)}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </section>
  );
}
