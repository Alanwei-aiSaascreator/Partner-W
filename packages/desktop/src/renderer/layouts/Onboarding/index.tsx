import { useState } from 'react';
import {
  BriefcaseBusiness,
  Check,
  Clapperboard,
  GraduationCap,
  HeartHandshake,
  PenLine,
  ShoppingBag,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { OnboardingProfile, OnboardingUseCaseId } from '@/lib/user-onboarding';
import logo from '@/assets/logo.png';
import GuideMascot from '@/components/GuideMascot';

interface OnboardingProps {
  userId: string;
  defaultNickname?: string;
  onComplete: (profile: OnboardingProfile) => void;
}

const USE_CASES = [
  { id: 'content', icon: PenLine },
  { id: 'video', icon: Clapperboard },
  { id: 'office', icon: BriefcaseBusiness },
  { id: 'ecommerce', icon: ShoppingBag },
  { id: 'research', icon: GraduationCap },
  { id: 'family', icon: HeartHandshake },
] as const satisfies ReadonlyArray<{ id: OnboardingUseCaseId; icon: typeof PenLine }>;

export default function Onboarding({ userId, defaultNickname = '', onComplete }: OnboardingProps) {
  const { t } = useTranslation();
  const [nickname, setNickname] = useState(defaultNickname);
  const [selected, setSelected] = useState<OnboardingUseCaseId[]>([]);
  const [customGoal, setCustomGoal] = useState('');
  const canContinue = selected.length > 0 || customGoal.trim().length > 0;

  const toggleUseCase = (id: OnboardingUseCaseId) => {
    setSelected((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  };

  const complete = (useCases: OnboardingUseCaseId[], goal: string) => {
    onComplete({
      version: 1,
      userId,
      nickname: nickname.trim(),
      useCases,
      customGoal: goal.trim(),
      completedAt: new Date().toISOString(),
    });
  };

  return (
    <div className="h-screen overflow-y-auto bg-[var(--surface-onboarding-page)] px-5 py-9 text-[var(--text-primary)] sm:px-8">
      <main className="mx-auto w-full max-w-6xl">
        <div className="mb-7 flex items-center gap-3">
          <img src={logo} alt={t('common.appName')} className="h-11 w-11 rounded-xl shadow-[var(--glow-accent)]" />
          <div>
            <p className="type-label text-[var(--accent)]">{t('common.appName')}</p>
            <p className="type-support mt-0.5 text-[var(--text-muted)]">{t('onboarding.progress')}</p>
          </div>
        </div>

        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div>
            <h1 className="type-page-title">{t('onboarding.title')}</h1>
            <p className="type-body mt-3 max-w-2xl text-[var(--text-secondary)]">{t('onboarding.subtitle')}</p>

            <label
              data-onboarding-goal
              className="mt-6 block rounded-2xl bg-[var(--bg-elevated)] p-5 shadow-[var(--shadow-card)]"
            >
              <span className="type-section-title">{t('onboarding.customTitle')}</span>
              <span className="type-support ml-2 text-[var(--text-muted)]">{t('onboarding.optional')}</span>
              <textarea
                value={customGoal}
                onChange={(event) => setCustomGoal(event.target.value)}
                rows={3}
                placeholder={t('onboarding.customPlaceholder')}
                className="type-body mt-3 w-full resize-none rounded-xl border border-[var(--border)] bg-[var(--surface-onboarding-page)] px-4 py-3 text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] glow-focus"
              />
              <p className="type-support mt-2 text-[var(--text-muted)]">{t('onboarding.goalAnalysisHint')}</p>
            </label>

            <section className="mt-6">
              <div className="flex items-baseline justify-between gap-4">
                <h2 className="type-section-title">{t('onboarding.useCaseTitle')}</h2>
                <span className="type-support text-[var(--text-muted)]">{t('onboarding.multipleHint')}</span>
              </div>
              <div className="mt-3 grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--border)] sm:grid-cols-2">
                {USE_CASES.map(({ id, icon: Icon }) => {
                  const active = selected.includes(id);
                  return (
                    <button
                      key={id}
                      type="button"
                      aria-pressed={active}
                      onClick={() => toggleUseCase(id)}
                      className={cn(
                        'relative flex min-h-20 items-start gap-3 p-3.5 text-left transition-colors focus-visible:z-10 focus-visible:outline-none glow-focus',
                        active ? 'bg-[var(--accent-dim)]' : 'bg-[var(--bg-elevated)] hover:bg-[var(--bg-hover)]',
                      )}
                    >
                      <span
                        className={cn(
                          'flex h-9 w-9 items-center justify-center rounded-xl',
                          active
                            ? 'bg-[var(--accent)] text-[var(--accent-foreground)]'
                            : 'bg-[var(--bg-tertiary)] text-[var(--accent)]',
                        )}
                      >
                        <Icon size={17} />
                      </span>
                      <span className="min-w-0 pr-6">
                        <span className="type-label block">{t(`onboarding.useCases.${id}.title`)}</span>
                        <span className="type-support mt-1 block text-[var(--text-secondary)]">
                          {t(`onboarding.useCases.${id}.description`)}
                        </span>
                      </span>
                      {active && (
                        <span className="absolute right-3 top-3 flex h-5 w-5 items-center justify-center rounded-full bg-[var(--accent)] text-[var(--accent-foreground)]">
                          <Check size={12} />
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </section>

            <label className="mt-5 block">
              <span className="type-label text-[var(--text-secondary)]">{t('onboarding.nickname')}</span>
              <input
                value={nickname}
                onChange={(event) => setNickname(event.target.value)}
                placeholder={t('onboarding.nicknamePlaceholder')}
                className="type-body mt-2 w-full rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] px-4 py-3 text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] glow-focus"
              />
            </label>

            <div className="mt-7 flex flex-col-reverse items-stretch justify-between gap-3 sm:flex-row sm:items-center">
              <Button variant="ghost" onClick={() => complete(['general'], '')}>
                {t('onboarding.skip')}
              </Button>
              <Button disabled={!canContinue} onClick={() => complete(selected, customGoal)}>
                {t('onboarding.continue')}
              </Button>
            </div>
          </div>

          <aside className="hidden min-h-[540px] flex-col justify-between rounded-2xl bg-[var(--surface-onboarding-accent)] p-6 lg:flex">
            <div>
              <p className="type-label text-[var(--accent)]">{t('mainArea.compassAssistant')}</p>
              <p className="type-body mt-2 leading-6 text-[var(--text-secondary)]">
                {customGoal.trim() ? t('onboarding.goalAnalysisHint') : t('assistantWorkspaces.compass.description')}
              </p>
            </div>
            <GuideMascot pose={customGoal.trim() ? 'phone' : 'idle'} className="mx-auto max-w-[280px]" />
          </aside>
        </div>
      </main>
    </div>
  );
}
