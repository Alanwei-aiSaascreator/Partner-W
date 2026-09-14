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
    <div className="h-screen overflow-y-auto bg-[var(--bg-primary)] px-6 py-10 text-[var(--text-primary)]">
      <main className="mx-auto w-full max-w-[var(--content-max-width)]">
        <div className="mb-8 flex items-center gap-3">
          <img src={logo} alt={t('common.appName')} className="h-11 w-11 rounded-xl shadow-[var(--glow-accent)]" />
          <div>
            <p className="type-label text-[var(--accent)]">{t('common.appName')}</p>
            <p className="type-support mt-0.5 text-[var(--text-muted)]">{t('onboarding.progress')}</p>
          </div>
        </div>

        <h1 className="type-page-title">{t('onboarding.title')}</h1>
        <p className="type-body mt-3 max-w-2xl text-[var(--text-secondary)]">{t('onboarding.subtitle')}</p>

        <label className="mt-8 block">
          <span className="type-label text-[var(--text-secondary)]">{t('onboarding.nickname')}</span>
          <input
            value={nickname}
            onChange={(event) => setNickname(event.target.value)}
            placeholder={t('onboarding.nicknamePlaceholder')}
            className="type-body mt-2 w-full rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-3 text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] glow-focus"
          />
        </label>

        <section className="mt-7">
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
                    'relative flex min-h-24 items-start gap-3 p-4 text-left transition-colors focus-visible:z-10 focus-visible:outline-none glow-focus',
                    active ? 'bg-[var(--accent-dim)]' : 'bg-[var(--bg-secondary)] hover:bg-[var(--bg-hover)]',
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

        <label className="mt-7 block">
          <span className="type-section-title">{t('onboarding.customTitle')}</span>
          <span className="type-support ml-2 text-[var(--text-muted)]">{t('onboarding.optional')}</span>
          <textarea
            value={customGoal}
            onChange={(event) => setCustomGoal(event.target.value)}
            rows={3}
            placeholder={t('onboarding.customPlaceholder')}
            className="type-body mt-3 w-full resize-none rounded-2xl border border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-3 text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] glow-focus"
          />
        </label>

        <div className="mt-8 flex flex-col-reverse items-stretch justify-between gap-3 sm:flex-row sm:items-center">
          <Button variant="ghost" onClick={() => complete(['general'], '')}>
            {t('onboarding.skip')}
          </Button>
          <Button disabled={!canContinue} onClick={() => complete(selected, customGoal)}>
            {t('onboarding.continue')}
          </Button>
        </div>
      </main>
    </div>
  );
}
