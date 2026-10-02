import { useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { ArrowRight, CheckCircle2, Circle, Loader2, ShieldCheck } from 'lucide-react';
import logo from '@/assets/logo.png';
import GuideMascot from '@/components/GuideMascot';
import { Button } from '@/components/ui/button';
import {
  deriveEntryPreparation,
  type EntryPreparationFacts,
  type EntryPreparationStage,
} from '@/lib/entry-preparation';
import { gatewayFailureText, startupFailureText } from '@/lib/startup-readiness';
import { motionDuration, motionEase } from '@/styles/design-tokens';
export interface EntryPreparationProps {
  facts: EntryPreparationFacts;
  onContinue: () => Promise<void>;
  onRetry: () => Promise<void>;
  onChangeAccount: () => Promise<void>;
  onChooseWorkspace: () => void;
}
const stages: EntryPreparationStage[] = ['account', 'runtime', 'relay', 'models', 'workspace', 'assistants'];
export default function EntryPreparation({
  facts,
  onContinue,
  onRetry,
  onChangeAccount,
  onChooseWorkspace,
}: EntryPreparationProps) {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotion();
  const state = deriveEntryPreparation(facts);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const locked = useRef(false);
  const actionAttempt = useRef(0);
  const active = useRef(true);
  const currentScope = useRef(facts.currentScopeKey);
  currentScope.current = facts.currentScopeKey;
  useEffect(() => {
    actionAttempt.current += 1;
    locked.current = false;
    setBusy(false);
    setError(false);
  }, [facts.currentScopeKey]);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const run = async (action: () => Promise<void>) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError(false);
    const scope = facts.currentScopeKey;
    const attempt = ++actionAttempt.current;
    try {
      await action();
    } catch {
      if (active.current && currentScope.current === scope && actionAttempt.current === attempt) setError(true);
    } finally {
      if (actionAttempt.current === attempt) locked.current = false;
      if (active.current && currentScope.current === scope && actionAttempt.current === attempt) setBusy(false);
    }
  };
  const runtimeFailure =
    facts.runtime?.ok === false
      ? gatewayFailureText({ ...facts.startup, ai: { ...facts.startup.ai, failureReason: facts.runtime.reason } }, t)
      : null;
  const failure = error
    ? t('entryPreparation.recheckFailed')
    : state.hasError
      ? (runtimeFailure ?? startupFailureText(facts.startup, t) ?? t('entryPreparation.checkFailed'))
      : null;
  const currentIndex = stages.indexOf(state.stage);
  return (
    <div className="min-h-screen bg-[var(--bg-primary)] text-[var(--text-primary)] px-6 py-8 overflow-auto">
      <header className="mx-auto flex w-full max-w-5xl items-center gap-3">
        <img src={logo} alt="" className="h-9 w-9" />
        <span className="type-title">{t('common.appName')}</span>
      </header>
      <main className="mx-auto grid w-full max-w-5xl items-center gap-6 py-6 md:grid-cols-2 md:gap-10 md:py-10">
        <section className="flex flex-col items-center text-center">
          <motion.div
            data-entry-animation
            aria-hidden="true"
            className="w-40 md:w-full md:max-w-sm"
            animate={reduceMotion || state.canContinue || state.hasError ? { y: 0 } : { y: [0, -8, 0] }}
            transition={{
              duration: motionDuration.ambient * 6,
              ease: motionEase.gentle,
              repeat: reduceMotion || state.canContinue || state.hasError ? 0 : Infinity,
            }}
          >
            <GuideMascot
              pose={state.canContinue ? 'success' : 'idle'}
              trackPointer={false}
              label={t('common.appName')}
            />
          </motion.div>
          <p className="mt-4 flex items-center gap-2 type-support text-[var(--text-secondary)]">
            <ShieldCheck size={16} className="text-[var(--accent)]" />
            {t('entryPreparation.animationNote')}
          </p>
        </section>
        <section className="min-w-0 space-y-6" aria-busy={!state.canContinue && !state.hasError}>
          <div className="space-y-3">
            <h1 className="type-page-title">
              {t(
                state.canContinue
                  ? 'entryPreparation.ready'
                  : state.hasError
                    ? 'entryPreparation.needsAttention'
                    : 'entryPreparation.title',
              )}
            </h1>
            <p className="type-body text-[var(--text-secondary)]">
              {t(state.canContinue ? 'entryPreparation.readyDetail' : 'entryPreparation.detail')}
            </p>
          </div>
          <ol className="divide-y divide-[var(--border-subtle)]" aria-label={t('entryPreparation.checks')}>
            {stages.map((stage, index) => {
              const done = state.canContinue || index < currentIndex;
              const running = !state.hasError && stage === state.stage;
              return (
                <li key={stage} data-entry-stage={stage} className="flex items-center justify-between gap-4 py-3">
                  <span className="flex min-w-0 items-center gap-3 type-body">
                    {done ? (
                      <CheckCircle2 size={18} className="shrink-0 text-[var(--accent)]" />
                    ) : running ? (
                      <Loader2
                        size={18}
                        className={reduceMotion ? 'shrink-0' : 'shrink-0 animate-spin motion-reduce:animate-none'}
                      />
                    ) : (
                      <Circle size={18} className="shrink-0 text-[var(--text-muted)]" />
                    )}
                    {t(`entryPreparation.${stage}`)}
                  </span>
                  {stage === 'assistants' && facts.startup.assistants.phase !== 'waiting' && (
                    <span className="type-support tabular-nums text-[var(--text-secondary)]">
                      {facts.startup.assistants.completed}/{facts.startup.assistants.total}
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
          <div
            role={failure ? 'alert' : 'status'}
            aria-live="polite"
            className={failure ? 'type-body text-[var(--danger)]' : 'type-support text-[var(--text-secondary)]'}
          >
            {failure ?? (state.canContinue ? t('entryPreparation.checked') : t(`entryPreparation.${state.stage}`))}
          </div>
          <div className="space-y-3">
            <Button
              data-entry-continue
              className="brand-action w-full"
              disabled={!state.canContinue || busy}
              onClick={() => {
                if (deriveEntryPreparation(facts).canContinue) void run(onContinue);
              }}
            >
              {busy ? (
                <Loader2 size={16} className="animate-spin motion-reduce:animate-none" />
              ) : (
                <>
                  {t('entryPreparation.continue')}
                  <ArrowRight size={16} />
                </>
              )}
            </Button>
            <div className="flex flex-wrap justify-center gap-2">
              <Button data-entry-retry variant="ghost" disabled={busy} onClick={() => void run(onRetry)}>
                {t('startupReadiness.retry')}
              </Button>
              <Button data-entry-workspace variant="ghost" disabled={busy} onClick={onChooseWorkspace}>
                {t('entryPreparation.chooseWorkspace')}
              </Button>
              <Button data-entry-account variant="ghost" disabled={busy} onClick={() => void run(onChangeAccount)}>
                {t('login.changeAccount')}
              </Button>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
