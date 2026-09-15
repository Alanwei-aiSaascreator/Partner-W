import { useEffect, useState } from 'react';
import { Bot, Boxes, CheckCircle2, LoaderCircle, RefreshCw, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import type { StartupReadiness } from '@/lib/startup-readiness';

export default function StartupReadinessPanel({
  readiness,
  onRetry,
}: {
  readiness: StartupReadiness;
  onRetry: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [takingLonger, setTakingLonger] = useState(false);
  const completed = Math.min(readiness.assistants.completed, readiness.assistants.total);
  const percent = readiness.assistants.total > 0 ? (completed / readiness.assistants.total) * 100 : 0;

  useEffect(() => {
    if (readiness.conversationReady) return;
    const timer = window.setTimeout(() => setTakingLonger(true), 90_000);
    return () => window.clearTimeout(timer);
  }, [readiness.conversationReady]);

  const aiReady = readiness.ai.phase === 'ready';
  const aiError = readiness.ai.phase === 'error';
  const assistantsReady = readiness.assistants.phase === 'ready';
  const assistantsError = readiness.assistants.phase === 'error';

  return (
    <section
      aria-live="polite"
      className="mx-auto mt-4 w-full max-w-[var(--content-max-width)] rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-5"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="type-section-title text-[var(--text-primary)]">{t('startupReadiness.title')}</h2>
          <p className="type-support mt-1 text-[var(--text-secondary)]">
            {takingLonger ? t('startupReadiness.description') : t('startupReadiness.keepOpen')}
          </p>
        </div>
        {(readiness.hasError || takingLonger) && (
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            <RefreshCw size={14} />
            {t('startupReadiness.retry')}
          </Button>
        )}
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="flex items-center gap-3 rounded-lg bg-[var(--bg-tertiary)] p-3">
          <Bot size={17} className="text-[var(--accent)]" />
          <span className="type-support flex-1 text-[var(--text-primary)]">{t('startupReadiness.aiTitle')}</span>
          {aiReady ? (
            <CheckCircle2 size={17} className="text-[var(--accent)]" />
          ) : aiError ? (
            <TriangleAlert size={17} className="text-[var(--danger)]" />
          ) : (
            <LoaderCircle size={17} className="animate-spin text-[var(--accent)]" />
          )}
        </div>
        <div className="flex items-center gap-3 rounded-lg bg-[var(--bg-tertiary)] p-3">
          <Boxes size={17} className="text-[var(--accent)]" />
          <span className="type-support flex-1 text-[var(--text-primary)]">
            {t('startupReadiness.progress', { completed, total: readiness.assistants.total })}
          </span>
          {assistantsReady ? (
            <CheckCircle2 size={17} className="text-[var(--accent)]" />
          ) : assistantsError ? (
            <TriangleAlert size={17} className="text-[var(--danger)]" />
          ) : (
            <LoaderCircle size={17} className="animate-spin text-[var(--accent)]" />
          )}
        </div>
      </div>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={readiness.assistants.total}
        aria-valuenow={completed}
        className="mt-3 h-1.5 overflow-hidden rounded-full bg-[var(--bg-tertiary)]"
      >
        <div className="h-full rounded-full bg-[var(--accent)] transition-[width]" style={{ width: `${percent}%` }} />
      </div>
    </section>
  );
}
