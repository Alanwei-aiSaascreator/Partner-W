import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MessagesSquare } from 'lucide-react';
import type { Team } from '@clawwork/shared';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useTaskStore, useUiStore } from '@/platform';
import { toast } from '@/lib/toast';
import { useDialogGuard } from '@/hooks/useDialogGuard';
import ConfirmDialog from '@/components/semantic/ConfirmDialog';
import TeamMeetingPanel from './TeamMeetingPanel';
import { buildMeetingPlan, type MeetingMember } from './plan';
import { meetingCatalog } from './catalog';
import { teamMeetingController, useTeamMeetingStore } from './instance';

export default function TeamMeetingEntry({ team }: { team: Team }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);
  const lifetime = useRef(0);
  useLayoutEffect(
    () => () => {
      lifetime.current++;
    },
    [team],
  );
  const catalog = useUiStore((state) => state.agentCatalogByGateway[team.gatewayId]);
  const models = useUiStore((state) => state.modelCatalogByGateway[team.gatewayId]);
  const connected = useUiStore((state) => state.gatewayStatusMap[team.gatewayId] === 'connected');
  const records = useTeamMeetingStore((state) => state.records);
  const errors = useTeamMeetingStore((state) => state.errors);
  const error = useTeamMeetingStore((state) => state.error);
  const loaded = useTeamMeetingStore((state) => state.loaded);
  const setActiveTask = useTaskStore((state) => state.setActiveTask);
  const setMainView = useUiStore((state) => state.setMainView);
  const navigate = (taskId: string) => {
    setActiveTask(taskId);
    setMainView('chat');
    setOpen(false);
    setDirty(false);
  };
  const guard = useDialogGuard({
    isDirty: () => dirty,
    onConfirmClose: () => {
      if (pendingTaskId && useTaskStore.getState().tasks.some((task) => task.id === pendingTaskId))
        navigate(pendingTaskId);
      setPendingTaskId(null);
      setOpen(false);
      setDirty(false);
    },
  });
  const available = useMemo(() => meetingCatalog(team, catalog?.agents ?? [], models ?? []), [team, catalog, models]);
  useEffect(() => {
    if (open) void teamMeetingController.load().catch(() => {});
  }, [open]);
  const start = async (question: string, members: MeetingMember[]) => {
    const generation = teamMeetingController.getGeneration();
    const entryLifetime = lifetime.current;
    const deviceId = await window.clawwork.getDeviceId();
    if (generation !== teamMeetingController.getGeneration() || entryLifetime !== lifetime.current)
      throw new Error(t('meeting.unavailable'));
    const live = useUiStore.getState();
    const current = meetingCatalog(
      team,
      live.agentCatalogByGateway[team.gatewayId]?.agents ?? [],
      live.modelCatalogByGateway[team.gatewayId] ?? [],
    );
    if (
      live.gatewayStatusMap[team.gatewayId] !== 'connected' ||
      members.some(
        (member) =>
          !current.members.some((candidate) => candidate.agentId === member.agentId) ||
          !current.models.includes(member.model),
      )
    )
      throw new Error(t('meeting.unavailable'));
    await teamMeetingController.start(
      buildMeetingPlan({ team, members, question, title: `${team.name} · ${t('meeting.title')}`, deviceId }),
    );
  };
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <MessagesSquare size={14} />
        {t('meeting.title')}
      </Button>
      <Dialog open={open} onOpenChange={guard.guardedOpenChange}>
        <DialogContent className="max-w-[var(--content-max-width)]" {...guard.contentProps}>
          <DialogHeader>
            <DialogTitle>
              {team.name} · {t('meeting.title')}
            </DialogTitle>
            <DialogDescription>{t('meeting.description')}</DialogDescription>
          </DialogHeader>
          <div className="mt-4">
            {error && (
              <p role="alert" className="type-support">
                {error}
              </p>
            )}
            {!loaded ? (
              <p role="status">{t('common.loading')}</p>
            ) : (
              <TeamMeetingPanel
                key={team.id}
                members={available.members}
                models={available.models}
                connected={connected}
                records={records.filter((record) => record.teamId === team.id)}
                errors={errors}
                onStart={start}
                onDirtyChange={setDirty}
                onStop={(id) => {
                  void teamMeetingController
                    .stop(id)
                    .catch((cause: unknown) =>
                      toast.error(cause instanceof Error ? cause.message : t('meeting.failed')),
                    );
                }}
                onOpenTask={(taskId) => {
                  if (useTaskStore.getState().tasks.some((task) => task.id === taskId)) {
                    if (dirty) {
                      setPendingTaskId(taskId);
                      guard.guardedOpenChange(false);
                    } else navigate(taskId);
                  } else toast.error(t('meeting.unavailable'));
                }}
              />
            )}
          </div>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={guard.confirmOpen}
        variant="danger"
        confirmLabel={t('common.confirm')}
        title={t('teams.detail.unsavedTitle')}
        description={t('teams.detail.unsavedDesc')}
        onConfirm={guard.confirmDiscard}
        onCancel={() => {
          setPendingTaskId(null);
          guard.cancelDiscard();
        }}
      />
    </>
  );
}
