import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useDeliveryActivityStore } from '../stores/deliveryActivityStore';
import { useTaskStore } from '../stores/taskStore';
import { formatElapsed } from '../lib/waiting-copy';

export default function ArtifactDeliveryActivity({ sessionKey }: { sessionKey: string | null }) {
  const { t } = useTranslation();
  const active = useDeliveryActivityStore((state) => state.active);
  const ownerEpoch = useDeliveryActivityStore((state) => state.workspaceEpoch);
  const epoch = useTaskStore((state) => state.workspaceEpoch);
  const taskId = useTaskStore((state) => state.activeTaskId);
  const activities =
    ownerEpoch === epoch && useTaskStore.getState().workspaceEpoch === epoch
      ? active.filter((activity) => activity.taskId === taskId && activity.sessionKey === sessionKey)
      : [];
  const running = activities.length > 0;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  if (!sessionKey || !running) return null;
  return (
    <div className="mb-2 space-y-1 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-3 py-2">
      {activities.map((activity) => (
        <div
          key={activity.operationId}
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
      ))}
    </div>
  );
}
