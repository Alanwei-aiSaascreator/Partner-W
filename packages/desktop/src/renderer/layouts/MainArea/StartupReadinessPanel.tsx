import { useEffect, useState } from 'react';
import { Bot, Boxes, CheckCircle2, Cloud, LoaderCircle, RefreshCw, Sparkles, TriangleAlert } from 'lucide-react';
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
  const assistantRatio = readiness.assistants.total > 0 ? completed / readiness.assistants.total : 0;
  const serviceDone = readiness.ai.phase !== 'starting';
  const modelsDone = readiness.ai.phase === 'ready';
  const percent = Math.round(
    (serviceDone ? 25 : 0) + (modelsDone ? 25 : 0) + assistantRatio * 25 + (readiness.isReady ? 25 : 0),
  );

  useEffect(() => {
    if (readiness.conversationReady) return;
    const timer = window.setTimeout(() => setTakingLonger(true), 90_000);
    return () => window.clearTimeout(timer);
  }, [readiness.conversationReady]);

  const aiError = readiness.ai.phase === 'error';
  const assistantsReady = readiness.assistants.phase === 'ready';
  const assistantsError = readiness.assistants.phase === 'error';

  return (
    <section
      aria-live="polite"
      aria-busy={!readiness.isReady}
      className="mx-auto mt-4 w-full max-w-[var(--content-max-width)] rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-5"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="type-section-title text-[var(--text-primary)]">{t('startupReadiness.title')}</h2>
          <p className="type-support mt-1 text-[var(--text-secondary)]">
            {takingLonger ? t('startupReadiness.takingLonger') : t('startupReadiness.keepOpen')}
          </p>
        </div>
        {(readiness.hasError || takingLonger) && (
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            <RefreshCw size={14} />
            {t('startupReadiness.retry')}
          </Button>
        )}
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        {[
          { key: 'startupReadiness.stageService', icon: Cloud, done: serviceDone, error: aiError && !serviceDone },
          { key: 'startupReadiness.stageModels', icon: Bot, done: modelsDone, error: aiError },
          { key: 'startupReadiness.stageAssistants', icon: Boxes, done: assistantsReady, error: assistantsError },
          { key: 'startupReadiness.stageReady', icon: Sparkles, done: readiness.isReady, error: readiness.hasError },
        ].map(({ key, icon: Icon, done, error: rowError }) => (
          <div key={key} className="flex items-center gap-3 rounded-lg bg-[var(--bg-tertiary)] px-3 py-2.5">
            <Icon size={16} className={done ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'} />
            <span className="type-support flex-1 text-[var(--text-primary)]">{t(key)}</span>
            {key === 'startupReadiness.stageAssistants' && !done && !rowError && (
              <span className="type-meta text-[var(--text-muted)]">
                {completed}/{readiness.assistants.total}
              </span>
            )}
            {done ? (
              <CheckCircle2 size={16} className="text-[var(--accent)]" />
            ) : rowError ? (
              <TriangleAlert size={16} className="text-[var(--danger)]" />
            ) : (
              <LoaderCircle size={16} className="animate-spin text-[var(--text-muted)]" />
            )}
          </div>
        ))}
      </div>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="mt-4 h-2 overflow-hidden rounded-full bg-[var(--bg-tertiary)]"
      >
        <div className="h-full rounded-full bg-[var(--accent)] transition-[width]" style={{ width: `${percent}%` }} />
      </div>
      <div className="mt-2 flex justify-between type-meta text-[var(--text-muted)]">
        <span>{t('startupReadiness.overallProgress')}</span>
        <span>{percent}%</span>
      </div>
      {(takingLonger || readiness.hasError) && (
        <details className="mt-3 rounded-lg bg-[var(--bg-tertiary)] px-3 py-2">
          <summary className="type-support cursor-pointer text-[var(--text-secondary)]">
            {t('startupReadiness.details')}
          </summary>
          <p className="type-support mt-2 text-[var(--text-muted)]">{t('startupReadiness.description')}</p>
        </details>
      )}
    </section>
  );
}
