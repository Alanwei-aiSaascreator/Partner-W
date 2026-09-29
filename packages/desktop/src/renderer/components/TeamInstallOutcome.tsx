import { useTranslation } from 'react-i18next';
import type { InstallEvent } from '@clawwork/shared';

export function TeamInstallOutcome({ events }: { events: InstallEvent[] }) {
  const { t } = useTranslation();
  const outcome = [...events].reverse().find((event) => event.type === 'done' || event.type === 'degraded');
  if (!outcome?.summary) return null;
  return (
    <div role="status" data-install-outcome={outcome.type} className="space-y-1 type-support">
      <p>{t('teams.wizard.installSummary', { ...outcome.summary })}</p>
      {outcome.type === 'degraded' && (
        <p className="text-[var(--text-warning)]">{t('teams.wizard.installDegradedHint')}</p>
      )}
    </div>
  );
}
