import { Bot, Boxes, CheckCircle2, LoaderCircle, RefreshCw, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import logo from '@/assets/logo.png';
import { Button } from '@/components/ui/button';
import { PRESET_AGENT_DEFINITIONS, type PresetAgentId } from '@/lib/preset-agents';
import type { StartupReadiness } from '@/lib/startup-readiness';

interface StartupReadinessScreenProps {
  readiness: StartupReadiness;
  onRetry: () => void | Promise<void>;
}

function StateIcon({ phase }: { phase: 'active' | 'ready' | 'error' }) {
  if (phase === 'ready') return <CheckCircle2 size={18} aria-hidden="true" />;
  if (phase === 'error') return <TriangleAlert size={18} aria-hidden="true" />;
  return <LoaderCircle size={18} className="animate-spin" aria-hidden="true" />;
}

export default function StartupReadinessScreen({ readiness, onRetry }: StartupReadinessScreenProps) {
  const { t } = useTranslation();
  const assistant = readiness.assistants;
  const completed = Math.min(assistant.completed, assistant.total);
  const progressPercent = assistant.total > 0 ? (completed / assistant.total) * 100 : 0;
  const roleName = (id: PresetAgentId): string => {
    const definition = PRESET_AGENT_DEFINITIONS.find((item) => item.id === id);
    return definition ? t(definition.displayNameKey) : id;
  };
  const aiStatusKey =
    readiness.ai.phase === 'starting'
      ? 'startupReadiness.aiStarting'
      : readiness.ai.phase === 'loading-models'
        ? 'startupReadiness.aiLoadingModels'
        : readiness.ai.phase === 'error'
          ? 'startupReadiness.aiError'
          : 'startupReadiness.aiReady';
  const assistantStatus =
    assistant.phase === 'waiting'
      ? t('startupReadiness.assistantsWaiting')
      : assistant.phase === 'verifying'
        ? t('startupReadiness.assistantsVerifying')
        : assistant.phase === 'installing'
          ? t('startupReadiness.assistantsInstalling', {
              name: assistant.currentId ? roleName(assistant.currentId) : '',
            })
          : assistant.phase === 'error'
            ? t('startupReadiness.assistantsError', {
                names: assistant.missingIds.map(roleName).join(', '),
              })
            : t('startupReadiness.assistantsReady');
  const aiIconPhase = readiness.ai.phase === 'ready' ? 'ready' : readiness.ai.phase === 'error' ? 'error' : 'active';
  const assistantIconPhase = assistant.phase === 'ready' ? 'ready' : assistant.phase === 'error' ? 'error' : 'active';

  return (
    <div className="relative flex h-screen overflow-hidden bg-[var(--bg-primary)]" aria-busy={!readiness.isReady}>
      <div className="titlebar-drag fixed inset-x-0 top-0 z-50 h-8" />
      <main className="flex w-full items-center justify-center px-6 py-12">
        <div className="w-full max-w-3xl">
          <header className="mb-8 flex flex-col items-center text-center">
            <div className="relative mb-4">
              <div className="absolute inset-0 scale-[2.2] rounded-full bg-[var(--accent)] opacity-[0.06] blur-2xl" />
              <img
                src={logo}
                alt={t('common.appName')}
                className="relative h-14 w-14 rounded-xl shadow-[var(--glow-accent)]"
              />
            </div>
            <p className="type-label mb-1 text-[var(--accent)]">{t('common.appName')}</p>
            <h1 className="type-page-title text-[var(--text-primary)]">{t('startupReadiness.title')}</h1>
            <p className="type-body mt-2 max-w-xl text-[var(--text-secondary)]">{t('startupReadiness.description')}</p>
          </header>

          <section
            aria-live="polite"
            className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-5 shadow-[var(--shadow-card)]"
          >
            <div className="grid gap-4 md:grid-cols-2">
              <article className="min-h-40 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-primary)] p-5">
                <div className="mb-6 flex items-start justify-between gap-4">
                  <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--accent-dim)] text-[var(--accent)]">
                    <Bot size={19} aria-hidden="true" />
                  </span>
                  <span className={readiness.ai.phase === 'error' ? 'text-[var(--danger)]' : 'text-[var(--accent)]'}>
                    <StateIcon phase={aiIconPhase} />
                  </span>
                </div>
                <h2 className="type-section-title text-[var(--text-primary)]">{t('startupReadiness.aiTitle')}</h2>
                <p className="type-body mt-2 text-[var(--text-secondary)]">{t(aiStatusKey)}</p>
              </article>

              <article className="min-h-40 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-primary)] p-5">
                <div className="mb-5 flex items-start justify-between gap-4">
                  <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--accent-dim)] text-[var(--accent)]">
                    <Boxes size={19} aria-hidden="true" />
                  </span>
                  <span className={assistant.phase === 'error' ? 'text-[var(--danger)]' : 'text-[var(--accent)]'}>
                    <StateIcon phase={assistantIconPhase} />
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <h2 className="type-section-title text-[var(--text-primary)]">
                    {t('startupReadiness.assistantsTitle')}
                  </h2>
                  <span className="type-mono-data text-[var(--text-muted)]">
                    {t('startupReadiness.progress', { completed, total: assistant.total })}
                  </span>
                </div>
                <div
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={assistant.total}
                  aria-valuenow={completed}
                  className="mt-3 h-1.5 overflow-hidden rounded-full bg-[var(--bg-tertiary)]"
                >
                  <div
                    className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-300"
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>
                <p
                  className={`type-support mt-3 leading-relaxed ${
                    assistant.phase === 'error' ? 'text-[var(--danger)]' : 'text-[var(--text-secondary)]'
                  }`}
                >
                  {assistantStatus}
                </p>
              </article>
            </div>

            <footer className="mt-5 flex min-h-9 items-center justify-between gap-4 border-t border-[var(--border-subtle)] pt-4">
              <p className="type-support text-[var(--text-muted)]">{t('startupReadiness.keepOpen')}</p>
              {readiness.hasError && (
                <Button type="button" variant="outline" className="titlebar-no-drag shrink-0" onClick={onRetry}>
                  <RefreshCw size={15} />
                  {t('startupReadiness.retry')}
                </Button>
              )}
            </footer>
          </section>
        </div>
      </main>
    </div>
  );
}
