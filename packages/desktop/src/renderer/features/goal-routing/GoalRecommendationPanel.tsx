import { useState } from 'react';
import { Bot, CheckCircle2, LoaderCircle, RefreshCw, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import type { CustomGoalAnalysis, GoalAnalysisResult } from './goal-analysis';
import type { GoalAnalysisStatus } from './useGoalAnalysis';

interface GoalRecommendationPanelProps {
  status: GoalAnalysisStatus;
  result: GoalAnalysisResult | null;
  error: string | null;
  onRetry: () => void;
  onSelectAssistant: (assistantId: string) => void;
  onSelectStarter: (prompt: string) => void;
  onCreateCustom: (analysis: CustomGoalAnalysis) => Promise<void>;
}

export default function GoalRecommendationPanel({
  status,
  result,
  error,
  onRetry,
  onSelectAssistant,
  onSelectStarter,
  onCreateCustom,
}: GoalRecommendationPanelProps) {
  const { t } = useTranslation();
  const [creating, setCreating] = useState(false);

  if (status === 'idle') return null;

  if (status === 'waiting' || status === 'analyzing') {
    return (
      <section
        className="mx-auto mt-4 flex w-full max-w-[var(--content-max-width)] items-center gap-3 rounded-xl bg-[var(--accent-soft)] px-4 py-3"
        aria-live="polite"
      >
        <LoaderCircle
          size={17}
          className={status === 'analyzing' ? 'animate-spin text-[var(--accent)]' : 'text-[var(--text-muted)]'}
        />
        <div>
          <p className="type-label text-[var(--text-primary)]">
            {status === 'analyzing' ? t('goalRouting.analyzing') : t('goalRouting.waiting')}
          </p>
          <p className="type-support mt-0.5 text-[var(--text-secondary)]">{t('goalRouting.saved')}</p>
        </div>
      </section>
    );
  }

  if (status === 'error' || !result) {
    return (
      <section
        className="mx-auto mt-4 flex w-full max-w-[var(--content-max-width)] items-center gap-3 rounded-xl bg-[var(--danger-bg)] px-4 py-3"
        role="alert"
      >
        <RefreshCw size={17} className="text-[var(--danger)]" />
        <div className="min-w-0 flex-1">
          <p className="type-label text-[var(--text-primary)]">{t('goalRouting.failed')}</p>
          <p className="type-support mt-0.5 truncate text-[var(--text-secondary)]">{error ?? t('errors.failed')}</p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          {t('goalRouting.retry')}
        </Button>
      </section>
    );
  }

  const create = async () => {
    if (result.kind !== 'custom' || creating) return;
    setCreating(true);
    try {
      await onCreateCustom(result);
    } finally {
      setCreating(false);
    }
  };

  return (
    <section
      className="mx-auto mt-4 w-full max-w-[var(--content-max-width)] rounded-xl border border-[var(--border-accent)] bg-[var(--bg-elevated)] p-4"
      aria-live="polite"
    >
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent)]">
          {result.kind === 'preset' ? <CheckCircle2 size={18} /> : <Sparkles size={18} />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="type-label text-[var(--text-primary)]">
            {result.kind === 'preset' ? t('goalRouting.recommendationReady') : t('goalRouting.customReady')}
          </p>
          <h3 className="type-section-title mt-1 text-[var(--text-primary)]">
            {result.kind === 'preset'
              ? t(`presetAgents.roles.${result.assistantId.replace('rongying-', '')}`)
              : result.draft.name}
          </h3>
          <p className="type-body mt-1 text-[var(--text-secondary)]">{result.reason}</p>
          <p className="type-support mt-2 text-[var(--text-muted)]">
            {t('goalRouting.recommendedModel')}: {result.model}
          </p>
        </div>
        {result.kind === 'preset' ? (
          <Button type="button" size="sm" onClick={() => onSelectAssistant(result.assistantId)}>
            <Bot size={14} />
            {t('goalRouting.useAssistant')}
          </Button>
        ) : (
          <Button type="button" size="sm" disabled={creating} onClick={() => void create()}>
            {creating ? <LoaderCircle size={14} className="animate-spin" /> : <Sparkles size={14} />}
            {t('goalRouting.createAssistant')}
          </Button>
        )}
      </div>

      {result.kind === 'custom' && (
        <details className="mt-3 rounded-lg bg-[var(--bg-tertiary)] px-3 py-2">
          <summary className="type-label cursor-pointer text-[var(--text-secondary)]">
            {t('goalRouting.promptPreview')}
          </summary>
          <p className="type-support mt-2 text-[var(--text-secondary)]">{result.draft.description}</p>
          <p className="type-support mt-2 whitespace-pre-wrap text-[var(--text-primary)]">{result.draft.identity}</p>
          <p className="type-support mt-2 text-[var(--text-muted)]">{result.draft.boundaries}</p>
        </details>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {result.starters.map((starter) => (
          <button
            key={starter}
            type="button"
            onClick={() => onSelectStarter(starter)}
            className="rounded-lg bg-[var(--bg-tertiary)] px-3 py-2 text-left type-support text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)]"
          >
            {starter}
          </button>
        ))}
      </div>
    </section>
  );
}
