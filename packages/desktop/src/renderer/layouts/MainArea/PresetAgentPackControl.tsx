import { LoaderCircle, RefreshCw, UserRoundPlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';

type PresetAgentPackStatus = 'ready' | 'installing' | 'incomplete';

interface PresetAgentPackControlProps {
  status: PresetAgentPackStatus;
  missingCount: number;
  completed: number;
  total: number;
  error?: string;
  disabled?: boolean;
  onInstall: () => void;
}

export default function PresetAgentPackControl({
  status,
  missingCount,
  completed,
  total,
  error,
  disabled = false,
  onInstall,
}: PresetAgentPackControlProps) {
  const { t } = useTranslation();
  const installing = status === 'installing';
  const incomplete = status === 'incomplete';
  const description = disabled
    ? t('presetAgents.unavailable')
    : incomplete
      ? t('presetAgents.incomplete', { count: missingCount })
      : t('presetAgents.description');

  return (
    <section
      aria-live="polite"
      className="flex flex-col gap-4 rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-4 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex min-w-0 items-start gap-3">
        <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-[var(--accent-dim)] text-[var(--accent)]">
          {installing ? <LoaderCircle size={17} className="animate-spin" /> : <UserRoundPlus size={17} />}
        </span>
        <div className="min-w-0">
          <h2 className="type-label text-[var(--text-primary)]">{t('presetAgents.title')}</h2>
          <p className="type-support mt-1 text-[var(--text-secondary)]">{description}</p>
          {error && <p className="type-support mt-1 text-[var(--danger)]">{error}</p>}
        </div>
      </div>

      <Button
        type="button"
        variant={incomplete ? 'outline' : 'default'}
        disabled={disabled || installing}
        onClick={onInstall}
        className="flex-shrink-0 gap-2"
      >
        {incomplete && <RefreshCw size={14} />}
        {installing
          ? t('presetAgents.installing', { completed, total })
          : incomplete
            ? t('presetAgents.retry')
            : t('presetAgents.install', { count: missingCount })}
      </Button>
    </section>
  );
}
