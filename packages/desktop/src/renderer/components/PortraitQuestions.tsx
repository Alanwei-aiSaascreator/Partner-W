import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { OnboardingQuestionAnswer, OnboardingQuestionAnswers } from '@/lib/user-onboarding';

/**
 * 首跑向导「趣味画像」页的四题步进（从 `layouts/Onboarding` 的旧 profile 页整块搬来）。
 *
 * ⚠️ 题面 i18n 键、`data-question` 锚点、按钮文案**逐字保留** —— 既有测试按这些锚点驱动，
 *    换页面不是换契约。
 */

export const FIRST_RUN_QUESTIONS = ['popular', 'sport', 'math', 'tidy'] as const;

const CHOICE_CLASS = 'rounded-xl border px-4 py-3 text-left type-support focus-visible:outline-none glow-focus';

interface PortraitQuestionsProps {
  questionIndex: number;
  answers: OnboardingQuestionAnswers;
  onAnswer: (answer: OnboardingQuestionAnswer) => void;
  onBack: () => void;
  onSkip: () => void;
}

export default function PortraitQuestions({
  questionIndex,
  answers,
  onAnswer,
  onBack,
  onSkip,
}: PortraitQuestionsProps) {
  const { t } = useTranslation();
  const choice = (active: boolean) =>
    cn(
      CHOICE_CLASS,
      active
        ? 'border-[var(--accent)] bg-[var(--accent-dim)] text-[var(--text-primary)]'
        : 'border-[var(--border)] bg-[var(--bg-elevated)] text-[var(--text-secondary)]',
    );

  return (
    <section
      data-question={FIRST_RUN_QUESTIONS[questionIndex]}
      className="space-y-4 rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-5"
    >
      <p className="type-support text-[var(--text-muted)]">{t('onboarding.firstRun.questionNotice')}</p>
      <p className="type-label">{t(`onboarding.firstRun.questions.${FIRST_RUN_QUESTIONS[questionIndex]}`)}</p>
      <div className="flex flex-wrap gap-3">
        {(['yes', 'no'] as const).map((answer) => (
          <button
            key={answer}
            type="button"
            aria-pressed={answers[questionIndex] === answer}
            className={choice(answers[questionIndex] === answer)}
            onClick={() => onAnswer(answer)}
          >
            {t(answer === 'yes' ? 'onboarding.firstRun.answerYes' : 'onboarding.firstRun.answerNo')}
          </button>
        ))}
      </div>
      <div className="flex items-center justify-between gap-3">
        <Button variant="ghost" disabled={questionIndex === 0} onClick={onBack}>
          {t('onboarding.firstRun.questionBack')}
        </Button>
        <span className="type-support text-[var(--text-muted)]">
          {questionIndex + 1} / {FIRST_RUN_QUESTIONS.length}
        </span>
        <Button variant="ghost" onClick={onSkip}>
          {t('onboarding.firstRun.questionSkip')}
        </Button>
      </div>
    </section>
  );
}
