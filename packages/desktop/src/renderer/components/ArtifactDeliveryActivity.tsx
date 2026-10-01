import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ArtifactDeliveryActivity as DeliveryActivity } from '@clawwork/shared';
import { isArtifactDeliveryPageProgress } from '@clawwork/shared';
import { useDeliveryActivityStore } from '../stores/deliveryActivityStore';
import { useTaskStore } from '../stores/taskStore';
import { formatElapsed } from '../lib/waiting-copy';

function ObservedPhases({ activity }: { activity: DeliveryActivity }) {
  const { t } = useTranslation();
  return (
    <div className="mt-2 space-y-2">
      {activity.historyTruncated && (
        <p className="type-caption text-[var(--text-muted)]">{t('chatInput.deliveryHistory.truncated')}</p>
      )}
      <ol
        className="max-h-40 space-y-1.5 overflow-y-auto"
        tabIndex={0}
        aria-label={t('chatInput.deliveryHistory.details')}
      >
        {(activity.observedPhases ?? []).map((step) => (
          <li key={step.sequence} className="flex items-start justify-between gap-3">
            <span className="type-caption min-w-0 break-words text-[var(--text-secondary)]">
              {t(`chatInput.deliveryHistory.phaseTypes.${step.phase}`)}
            </span>
            <time
              dateTime={new Date(step.observedAt).toISOString()}
              className="type-mono-data shrink-0 text-[var(--text-muted)]"
            >
              {new Date(step.observedAt).toLocaleTimeString()}
            </time>
          </li>
        ))}
      </ol>
    </div>
  );
}

function PageProgress({ activity }: { activity: DeliveryActivity }) {
  const { t } = useTranslation();
  if (activity.phase !== 'generating-presentation' || !isArtifactDeliveryPageProgress(activity.pageProgress))
    return null;
  const { completed, total } = activity.pageProgress;
  const label = t('chatInput.deliveryPageProgress', { completed, total });
  return (
    <div className="mt-2 space-y-1">
      <p className="type-caption text-[var(--text-secondary)]">{label}</p>
      <progress
        value={completed}
        max={total}
        aria-label={label}
        className="h-1.5 w-full appearance-none overflow-hidden rounded-full [&::-webkit-progress-bar]:bg-[var(--bg-hover)] [&::-webkit-progress-value]:bg-[var(--accent)] [&::-moz-progress-bar]:bg-[var(--accent)]"
      />
    </div>
  );
}

export default function ArtifactDeliveryActivity({ sessionKey }: { sessionKey: string | null }) {
  const { t } = useTranslation();
  const active = useDeliveryActivityStore((state) => state.active);
  const records = useDeliveryActivityStore((state) => state.records);
  const ownerEpoch = useDeliveryActivityStore((state) => state.workspaceEpoch);
  const epoch = useTaskStore((state) => state.workspaceEpoch);
  const taskId = useTaskStore((state) => state.activeTaskId);
  const currentWorkspace = ownerEpoch === epoch && useTaskStore.getState().workspaceEpoch === epoch;
  const activities = currentWorkspace
    ? active.filter((activity) => activity.taskId === taskId && activity.sessionKey === sessionKey)
    : [];
  const completed = currentWorkspace
    ? Object.values(records)
        .filter(
          (activity) =>
            activity.status !== 'active' && activity.taskId === taskId && activity.sessionKey === sessionKey,
        )
        .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt))
        .slice(0, 5)
    : [];
  const running = activities.length > 0;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  if (!sessionKey || (!running && completed.length === 0)) return null;
  return (
    <div className="mb-2 space-y-1 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-3 py-2">
      {activities.map((activity) => (
        <div key={activity.operationId}>
          <div
            data-testid="artifact-delivery-activity"
            data-phase={activity.phase}
            className="flex items-center gap-2.5"
          >
            <Loader2 size={14} className="shrink-0 animate-spin text-[var(--accent)]" aria-hidden />
            <span className="type-label min-w-0 flex-1 truncate text-[var(--text-secondary)]" aria-live="polite">
              {t(`chatInput.deliveryActivity.${activity.phase}`)}
            </span>
            <span className="type-mono-data shrink-0 text-[var(--text-muted)]">
              {formatElapsed(Math.max(0, now - activity.startedAt))}
            </span>
          </div>
          <PageProgress activity={activity} />
          {Boolean(activity.observedPhases?.length) && (
            <details className="mt-1">
              <summary className="type-caption cursor-pointer text-[var(--text-muted)]">
                {t('chatInput.deliveryHistory.details')}
              </summary>
              <ObservedPhases activity={activity} />
            </details>
          )}
        </div>
      ))}
      {completed.length > 0 && (
        <section
          className="max-h-48 space-y-2 overflow-y-auto"
          tabIndex={0}
          aria-label={t('chatInput.deliveryHistory.recent')}
        >
          <p className="type-caption text-[var(--text-muted)]">{t('chatInput.deliveryHistory.recent')}</p>
          {completed.map((activity) => (
            <details key={activity.operationId} data-testid="artifact-delivery-history">
              <summary className="type-label cursor-pointer text-[var(--text-secondary)]">
                <span>
                  {t(`chatInput.deliveryHistory.phaseTypes.${activity.observedPhases?.[0]?.phase ?? activity.phase}`)}
                  {' · '}
                  {t(`chatInput.deliveryHistory.${activity.status}`)}
                </span>
                {typeof activity.endedAt === 'number' && (
                  <span className="type-mono-data ml-3 inline-block text-[var(--text-muted)]">
                    {formatElapsed(Math.max(0, activity.endedAt - activity.startedAt))}
                  </span>
                )}
              </summary>
              <ObservedPhases activity={activity} />
            </details>
          ))}
        </section>
      )}
    </div>
  );
}
