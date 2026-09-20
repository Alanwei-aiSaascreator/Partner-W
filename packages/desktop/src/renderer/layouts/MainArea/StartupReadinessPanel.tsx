import { useEffect, useState } from 'react';
import { CheckCircle2, LoaderCircle, RefreshCw, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { PRESET_AGENT_DEFINITIONS } from '@/lib/preset-agents';
import type { StartupReadiness } from '@/lib/startup-readiness';

type Translate = (key: string, values?: Record<string, unknown>) => string;

function currentStatus(readiness: StartupReadiness, t: Translate): string {
  if (readiness.ai.phase === 'starting') return t('startupReadiness.aiStarting');
  if (readiness.ai.phase === 'loading-models') return t('startupReadiness.aiLoadingModels');
  if (readiness.ai.phase === 'error') return t('startupReadiness.aiError');

  const assistants = readiness.assistants;
  if (assistants.phase === 'waiting') return t('startupReadiness.assistantsWaiting');
  if (assistants.phase === 'verifying') return t('startupReadiness.assistantsVerifying');
  if (assistants.phase === 'installing') {
    const definition = PRESET_AGENT_DEFINITIONS.find((item) => item.id === assistants.currentId);
    return t('startupReadiness.assistantsInstalling', {
      name: definition ? t(definition.displayNameKey) : '',
    });
  }
  if (assistants.phase === 'error') {
    const names = assistants.missingIds
      .map((id) => PRESET_AGENT_DEFINITIONS.find((item) => item.id === id))
      .filter((definition): definition is (typeof PRESET_AGENT_DEFINITIONS)[number] => Boolean(definition))
      .map((definition) => t(definition.displayNameKey))
      .join(', ');
    return t('startupReadiness.assistantsError', { names });
  }
  return t('startupReadiness.aiReady');
}

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
  const hasAssistantProgress = readiness.ai.phase === 'ready' && readiness.assistants.total > 0;
  // ⭐ 2026-09-20（T-a28 实机）：助手没就绪时，**原因**一直躺在 `assistants.error` 里
  // （`preset-agent-bootstrap` 在"抛错"和"全部失败"两种情况下填的 missingIds 都是全部 6 个
  // ⇒ 光看「0 / 6」分不出是哪种），而这个面板从没渲染过它。原文不翻译：它是证据。
  const assistantError = readiness.assistants.phase === 'error' ? readiness.assistants.error : undefined;
  const progressPercent = hasAssistantProgress ? (completed / readiness.assistants.total) * 100 : 0;
  const status = readiness.hasError ? 'error' : readiness.isReady ? 'ready' : 'active';

  useEffect(() => {
    if (readiness.conversationReady) return;
    const timer = window.setTimeout(() => setTakingLonger(true), 90_000);
    return () => window.clearTimeout(timer);
  }, [readiness.conversationReady]);

  return (
    <section
      aria-live="polite"
      aria-busy={!readiness.isReady}
      className="mx-auto mt-3 w-full max-w-[var(--content-max-width)] rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] px-4 py-3"
    >
      <div className="flex items-center gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--accent-dim)] text-[var(--accent)]">
          {status === 'error' ? (
            <TriangleAlert size={16} aria-hidden="true" />
          ) : status === 'ready' ? (
            <CheckCircle2 size={16} aria-hidden="true" />
          ) : (
            <LoaderCircle size={16} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="type-label truncate text-[var(--text-primary)]">
              {takingLonger ? t('startupReadiness.takingLonger') : currentStatus(readiness, t)}
            </h2>
            {hasAssistantProgress && (
              <span className="type-mono-data shrink-0 text-[var(--text-muted)]">
                {t('startupReadiness.progress', { completed, total: readiness.assistants.total })}
              </span>
            )}
          </div>
          <div
            role="progressbar"
            aria-label={t('startupReadiness.overallProgress')}
            aria-valuemin={hasAssistantProgress ? 0 : undefined}
            aria-valuemax={hasAssistantProgress ? readiness.assistants.total : undefined}
            aria-valuenow={hasAssistantProgress ? completed : undefined}
            className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--bg-tertiary)]"
          >
            <div
              className={
                hasAssistantProgress
                  ? 'h-full rounded-full bg-[var(--accent)] transition-[width] duration-200 motion-reduce:transition-none'
                  : 'h-full w-1/3 rounded-full bg-[var(--accent)] animate-pulse motion-reduce:animate-none'
              }
              style={hasAssistantProgress ? { width: `${progressPercent}%` } : undefined}
            />
          </div>
          {assistantError && (
            <p className="type-meta mt-1.5 break-words text-[var(--text-danger)]" data-testid="readiness-reason">
              {assistantError}
            </p>
          )}
        </div>
        {(readiness.hasError || takingLonger) && (
          <Button type="button" variant="outline" size="sm" onClick={onRetry} className="shrink-0">
            <RefreshCw size={14} />
            {t('startupReadiness.retry')}
          </Button>
        )}
      </div>
    </section>
  );
}
