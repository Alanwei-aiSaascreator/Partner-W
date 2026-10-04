import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  BriefcaseBusiness,
  Building2,
  Calculator,
  Check,
  Clapperboard,
  GraduationCap,
  Handshake,
  Headphones,
  HeartHandshake,
  Home,
  PenLine,
  Settings2,
  ShoppingBag,
  Sparkles,
  UserRound,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  recommendAssistants,
  ONBOARDING_INDUSTRY_CODES,
  buildOnboardingWorkMatchInput,
  validateOnboardingWorkMatchReply,
  type FilePermissionPreference,
  type OnboardingIndustry,
  type OnboardingQuestionAnswer,
  type OnboardingQuestionAnswers,
  type OnboardingWorkMatch,
  type OnboardingWorkMatchInput,
  type OnboardingProfile,
  type OnboardingRoleId,
  type OnboardingUseCaseId,
  type ResponseDetail,
  type StarterId,
} from '@/lib/user-onboarding';
import logo from '@/assets/logo.png';
import GuideMascot from '@/components/GuideMascot';
import { readLoginPurpose, resolveLoginPurposeUseCase } from '@/lib/login-purpose';

interface OnboardingProps {
  userId: string;
  defaultNickname?: string;
  mode?: 'first-run' | 'edit';
  initialProfile?: OnboardingProfile | null;
  onComplete: (profile: OnboardingProfile) => void;
  onCancel?: () => void;
  workMatch?: {
    scopeKey: string;
    request: (input: OnboardingWorkMatchInput, signal: AbortSignal) => Promise<unknown>;
  };
}

const STEPS = ['role', 'purpose', 'assignment', 'personalize'] as const;

const ROLES = [
  { id: 'owner', icon: Building2 },
  { id: 'operations', icon: Settings2 },
  { id: 'sales', icon: Handshake },
  { id: 'support', icon: Headphones },
  { id: 'finance', icon: Calculator },
  { id: 'custom', icon: UserRound },
] as const satisfies ReadonlyArray<{ id: OnboardingRoleId; icon: typeof UserRound }>;

const USE_CASES = [
  { id: 'content', icon: PenLine },
  { id: 'video', icon: Clapperboard },
  { id: 'office', icon: BriefcaseBusiness },
  { id: 'ecommerce', icon: ShoppingBag },
  { id: 'research', icon: GraduationCap },
  { id: 'family', icon: HeartHandshake },
] as const satisfies ReadonlyArray<{ id: OnboardingUseCaseId; icon: typeof PenLine }>;

const ASSISTANT_ICONS: Record<StarterId, typeof Sparkles> = {
  content: PenLine,
  photography: Clapperboard,
  office: BriefcaseBusiness,
  research: GraduationCap,
  ecommerce: ShoppingBag,
  family: Home,
};

function LegacyOnboarding({
  userId,
  defaultNickname = '',
  mode = 'first-run',
  initialProfile = null,
  onComplete,
  onCancel,
}: OnboardingProps) {
  const { t } = useTranslation();
  const loginPurpose = readLoginPurpose();
  const [step, setStep] = useState(0);
  const [role, setRole] = useState<OnboardingRoleId | null>(initialProfile?.role ?? null);
  const [customRole, setCustomRole] = useState(initialProfile?.customRole ?? '');
  const [nickname, setNickname] = useState(initialProfile?.nickname ?? defaultNickname);
  const [selected, setSelected] = useState<OnboardingUseCaseId[]>(() => {
    if (initialProfile?.useCases.length) return initialProfile.useCases;
    return loginPurpose ? [resolveLoginPurposeUseCase(loginPurpose)] : [];
  });
  const [customGoal, setCustomGoal] = useState(initialProfile?.customGoal ?? '');
  const [selectedAssistantIds, setSelectedAssistantIds] = useState<StarterId[]>(
    initialProfile?.selectedAssistantIds ?? [],
  );
  const [responseDetail, setResponseDetail] = useState<ResponseDetail>(initialProfile?.responseDetail ?? 'balanced');
  const [filePermission, setFilePermission] = useState<FilePermissionPreference>(
    initialProfile?.filePermission ?? 'ask-every-time',
  );
  const [saveFailed, setSaveFailed] = useState(false);

  const draftProfile = useMemo<OnboardingProfile>(
    () => ({
      version: 2,
      userId,
      nickname: nickname.trim(),
      role: role ?? 'custom',
      customRole: customRole.trim(),
      useCases: selected,
      customGoal: customGoal.trim(),
      selectedAssistantIds,
      responseDetail,
      filePermission,
      completedAt: initialProfile?.completedAt ?? '',
    }),
    [
      customGoal,
      customRole,
      filePermission,
      initialProfile?.completedAt,
      nickname,
      responseDetail,
      role,
      selected,
      selectedAssistantIds,
      userId,
    ],
  );
  const recommendations = useMemo(() => recommendAssistants(draftProfile), [draftProfile]);

  const toggleUseCase = (id: OnboardingUseCaseId) => {
    setSelected((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  };

  const toggleAssistant = (id: StarterId) => {
    setSelectedAssistantIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  };

  const canContinue =
    step === 0
      ? Boolean(role && (role !== 'custom' || customRole.trim()))
      : step === 1
        ? selected.length > 0 || customGoal.trim().length > 0
        : step === 2
          ? selectedAssistantIds.length > 0
          : true;

  const next = () => {
    if (!canContinue) return;
    if (step === 1 && selectedAssistantIds.length === 0) {
      setSelectedAssistantIds(recommendations.map((item) => item.id));
    }
    setStep((current) => Math.min(current + 1, STEPS.length - 1));
  };

  const complete = () => {
    setSaveFailed(false);
    try {
      onComplete({
        ...draftProfile,
        version: 2,
        role: role ?? 'custom',
        selectedAssistantIds:
          selectedAssistantIds.length > 0 ? selectedAssistantIds : recommendations.map((item) => item.id),
        completedAt: new Date().toISOString(),
      });
    } catch {
      setSaveFailed(true);
    }
  };

  return (
    <div className="brand-first-run h-screen overflow-y-auto bg-[var(--surface-onboarding-page)] text-[var(--text-primary)]">
      <header className="border-b border-[var(--border-subtle)] px-5 py-4 sm:px-8">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-6">
          <div className="flex items-center gap-3">
            <img src={logo} alt={t('common.appName')} className="h-9 w-9 rounded-lg shadow-[var(--glow-accent)]" />
            <span className="type-label text-[var(--text-secondary)]">{t('common.appName')}</span>
          </div>
          <span className="sr-only">
            {t('onboarding.title')} {t('onboarding.subtitle')}
          </span>
          <ol className="hidden items-center gap-2 sm:flex" aria-label={t('onboarding.progress')}>
            {STEPS.map((item, index) => (
              <li key={item} className="flex items-center gap-2">
                {index > 0 && <span className="h-px w-5 bg-[var(--border)]" />}
                <span
                  className={cn(
                    'flex h-7 w-7 items-center justify-center rounded-full border type-support',
                    index === step
                      ? 'border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-foreground)] shadow-[var(--glow-accent)]'
                      : index < step
                        ? 'border-[var(--accent)] bg-[var(--accent-dim)] text-[var(--accent)]'
                        : 'border-[var(--border)] bg-[var(--bg-elevated)] text-[var(--text-muted)]',
                  )}
                >
                  {index < step ? <Check size={13} /> : index + 1}
                </span>
                <span
                  className={cn(
                    'type-support',
                    index === step ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]',
                  )}
                >
                  {t(`onboarding.steps.${item}`)}
                </span>
              </li>
            ))}
          </ol>
          {mode === 'first-run' && (
            <Button variant="ghost" onClick={complete}>
              {t('onboarding.skip')}
            </Button>
          )}
        </div>
      </header>

      <main className="mx-auto grid min-h-full w-full max-w-6xl gap-10 px-5 py-10 sm:px-8 lg:grid-cols-3 lg:items-stretch">
        <section className="flex min-w-0 flex-col lg:col-span-2">
          <div className="mb-7">
            <p className="type-support mb-2 text-[var(--accent)]">
              {t('onboarding.stepOf', { current: step + 1, total: STEPS.length })}
            </p>
            <h1 className="type-page-title text-balance">
              {t(
                step === 0
                  ? 'onboarding.roleTitle'
                  : step === 1
                    ? 'onboarding.purposeTitle'
                    : step === 2
                      ? 'onboarding.assignmentTitle'
                      : 'onboarding.personalizeTitle',
              )}
            </h1>
            <p className="type-body mt-2 max-w-2xl text-[var(--text-secondary)]">
              {t(
                step === 0
                  ? 'onboarding.roleSubtitle'
                  : step === 1
                    ? 'onboarding.purposeSubtitle'
                    : step === 2
                      ? 'onboarding.assignmentSubtitle'
                      : 'onboarding.personalizeSubtitle',
              )}
            </p>
          </div>

          {step === 0 && (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {ROLES.map(({ id, icon: Icon }) => {
                const active = role === id;
                return (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setRole(id)}
                    className={cn(
                      'relative min-h-28 rounded-xl border p-4 text-left transition-colors focus-visible:outline-none glow-focus',
                      active
                        ? 'border-[var(--accent)] bg-[var(--accent-dim)]'
                        : 'border-[var(--border)] bg-[var(--bg-elevated)] hover:bg-[var(--bg-hover)]',
                    )}
                  >
                    <span className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--bg-tertiary)] text-[var(--accent)]">
                      <Icon size={18} />
                    </span>
                    <span className="type-label block">{t(`onboarding.roles.${id}.title`)}</span>
                    <span className="type-support mt-1 block text-[var(--text-muted)]">
                      {t(`onboarding.roles.${id}.description`)}
                    </span>
                    {active && <Check size={15} className="absolute right-3 top-3 text-[var(--accent)]" />}
                  </button>
                );
              })}
              {role === 'custom' && (
                <label className="sm:col-span-2 lg:col-span-3">
                  <span className="sr-only">{t('onboarding.customRole')}</span>
                  <input
                    data-custom-role
                    autoFocus
                    value={customRole}
                    onChange={(event) => setCustomRole(event.target.value)}
                    placeholder={t('onboarding.customRolePlaceholder')}
                    className="type-body w-full rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] px-4 py-3 text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] glow-focus"
                  />
                </label>
              )}
            </div>
          )}

          {step === 1 && (
            <div>
              <label
                data-onboarding-goal
                className="block rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-5"
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
                <span className="type-support mt-2 block text-[var(--text-muted)]">
                  {t('onboarding.goalAnalysisHint')}
                </span>
              </label>
              <div className="mt-5 flex items-baseline justify-between gap-4">
                <h2 className="type-section-title">{t('onboarding.useCaseTitle')}</h2>
                <span className="type-support text-[var(--text-muted)]">{t('onboarding.multipleHint')}</span>
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {USE_CASES.map(({ id, icon: Icon }) => {
                  const active = selected.includes(id);
                  return (
                    <button
                      key={id}
                      type="button"
                      aria-pressed={active}
                      onClick={() => toggleUseCase(id)}
                      className={cn(
                        'relative flex min-h-20 items-start gap-3 rounded-xl border p-3.5 text-left transition-colors focus-visible:outline-none glow-focus',
                        active
                          ? 'border-[var(--accent)] bg-[var(--accent-dim)]'
                          : 'border-[var(--border)] bg-[var(--bg-elevated)] hover:bg-[var(--bg-hover)]',
                      )}
                    >
                      <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--bg-tertiary)] text-[var(--accent)]">
                        <Icon size={17} />
                      </span>
                      <span className="min-w-0 pr-6">
                        <span className="type-label block">{t(`onboarding.useCases.${id}.title`)}</span>
                        <span className="type-support mt-1 block text-[var(--text-secondary)]">
                          {t(`onboarding.useCases.${id}.description`)}
                        </span>
                      </span>
                      {active && <Check size={14} className="absolute right-3 top-3 text-[var(--accent)]" />}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-3">
              {recommendations.map(({ id, reason }) => {
                const active = selectedAssistantIds.includes(id);
                const Icon = ASSISTANT_ICONS[id];
                return (
                  <button
                    data-assistant={id}
                    key={id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => toggleAssistant(id)}
                    className={cn(
                      'flex w-full items-center gap-4 rounded-xl border p-4 text-left transition-colors focus-visible:outline-none glow-focus',
                      active
                        ? 'border-[var(--accent)] bg-[var(--accent-dim)]'
                        : 'border-[var(--border)] bg-[var(--bg-elevated)] hover:bg-[var(--bg-hover)]',
                    )}
                  >
                    <span className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl bg-[var(--bg-tertiary)] text-[var(--accent)]">
                      <Icon size={20} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="type-label block">{t(`onboarding.assistants.${id}.name`)}</span>
                      <span className="type-support mt-1 block text-[var(--text-secondary)]">{reason}</span>
                    </span>
                    <span
                      className={cn(
                        'flex h-6 w-10 items-center rounded-full p-0.5 transition-colors',
                        active ? 'justify-end bg-[var(--accent)]' : 'justify-start bg-[var(--bg-hover)]',
                      )}
                    >
                      <span className="h-5 w-5 rounded-full bg-[var(--bg-elevated)] shadow-[var(--shadow-card)]" />
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {step === 3 && (
            <div className="space-y-6">
              <label className="block">
                <span className="type-label text-[var(--text-secondary)]">{t('onboarding.nickname')}</span>
                <input
                  value={nickname}
                  onChange={(event) => setNickname(event.target.value)}
                  placeholder={t('onboarding.nicknamePlaceholder')}
                  className="type-body mt-2 w-full rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] px-4 py-3 text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] glow-focus"
                />
              </label>
              <fieldset>
                <legend className="type-label text-[var(--text-secondary)]">{t('onboarding.responseDetail')}</legend>
                <div className="mt-2 grid grid-cols-3 gap-2">
                  {(['concise', 'balanced', 'detailed'] as ResponseDetail[]).map((value) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={responseDetail === value}
                      onClick={() => setResponseDetail(value)}
                      className={cn(
                        'rounded-lg border px-3 py-2 type-support focus-visible:outline-none glow-focus',
                        responseDetail === value
                          ? 'border-[var(--accent)] bg-[var(--accent-dim)] text-[var(--text-primary)]'
                          : 'border-[var(--border)] bg-[var(--bg-elevated)] text-[var(--text-secondary)]',
                      )}
                    >
                      {t(`onboarding.responseOptions.${value}`)}
                    </button>
                  ))}
                </div>
              </fieldset>
              <fieldset>
                <legend className="type-label text-[var(--text-secondary)]">{t('onboarding.filePermission')}</legend>
                <div className="mt-2 space-y-2">
                  {(['ask-every-time', 'task-folder'] as FilePermissionPreference[]).map((value) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={filePermission === value}
                      onClick={() => setFilePermission(value)}
                      className={cn(
                        'flex w-full items-center justify-between rounded-lg border px-4 py-3 text-left focus-visible:outline-none glow-focus',
                        filePermission === value
                          ? 'border-[var(--accent)] bg-[var(--accent-dim)]'
                          : 'border-[var(--border)] bg-[var(--bg-elevated)]',
                      )}
                    >
                      <span>
                        <span className="type-label block">{t(`onboarding.fileOptions.${value}.title`)}</span>
                        <span className="type-support mt-1 block text-[var(--text-muted)]">
                          {t(`onboarding.fileOptions.${value}.description`)}
                        </span>
                      </span>
                      {filePermission === value && <Check size={16} className="text-[var(--accent)]" />}
                    </button>
                  ))}
                </div>
              </fieldset>
            </div>
          )}

          {saveFailed && (
            <p
              role="alert"
              className="mt-6 border-l-2 border-[var(--danger)] pl-3 type-support text-[var(--text-primary)]"
            >
              {t('teams.wizard.saveError')}
            </p>
          )}
          <div className="mt-auto flex items-center justify-between gap-3 pt-8">
            <div className="flex items-center gap-2">
              {step > 0 && (
                <Button variant="ghost" onClick={() => setStep((current) => current - 1)}>
                  <ArrowLeft size={15} />
                  {t('onboarding.back')}
                </Button>
              )}
              {mode === 'edit' && (
                <Button variant="ghost" onClick={onCancel}>
                  {t('onboarding.cancel')}
                </Button>
              )}
            </div>
            {step < STEPS.length - 1 ? (
              <Button data-primary-action className="brand-action" disabled={!canContinue} onClick={next}>
                {t('onboarding.next')}
                <ArrowRight size={15} />
              </Button>
            ) : (
              <Button data-primary-action className="brand-action" onClick={complete} title={t('onboarding.continue')}>
                {t(mode === 'edit' ? 'onboarding.save' : 'onboarding.finish')}
                <Check size={15} />
              </Button>
            )}
          </div>
        </section>

        <aside className="hidden min-h-full flex-col justify-between rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-onboarding-accent)] p-6 lg:flex">
          <div>
            <p className="type-label text-[var(--accent)]">{t('mainArea.compassAssistant')}</p>
            <p className="type-body mt-2 leading-6 text-[var(--text-secondary)]">
              {t(
                step === 0
                  ? 'onboarding.previewRole'
                  : step === 1
                    ? 'onboarding.previewPurpose'
                    : step === 2
                      ? 'onboarding.previewAssignment'
                      : 'onboarding.previewPersonalize',
              )}
            </p>
          </div>
          <GuideMascot pose={step >= 2 ? 'phone' : 'idle'} className="mx-auto max-w-xs" />
        </aside>
      </main>
    </div>
  );
}

const FIRST_RUN_QUESTIONS = ['popular', 'sport', 'math', 'tidy'] as const;
const FIELD_CLASS =
  'type-body mt-2 w-full rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] px-4 py-3 text-[var(--text-primary)] outline-none glow-focus';
const CHOICE_CLASS = 'rounded-xl border px-4 py-3 text-left type-support focus-visible:outline-none glow-focus';

function FirstRunOnboarding({
  userId,
  defaultNickname = '',
  mode = 'first-run',
  initialProfile,
  onComplete,
  onCancel,
  workMatch,
}: OnboardingProps) {
  const { t } = useTranslation();
  const [page, setPage] = useState<'profile' | 'matching' | 'result'>('profile');
  const [nickname, setNickname] = useState(initialProfile?.nickname ?? defaultNickname);
  const [introduction, setIntroduction] = useState(initialProfile?.introduction ?? '');
  const [industry, setIndustry] = useState<OnboardingIndustry | null>(initialProfile?.industry ?? null);
  const [role, setRole] = useState<OnboardingRoleId>(initialProfile?.role ?? 'custom');
  const [customRole, setCustomRole] = useState(initialProfile?.customRole ?? '');
  const [useCases, setUseCases] = useState<OnboardingUseCaseId[]>(initialProfile?.useCases ?? []);
  const [customGoal, setCustomGoal] = useState(initialProfile?.customGoal ?? '');
  const [answers, setAnswers] = useState<OnboardingQuestionAnswers>(
    initialProfile?.questionnaire?.answers ?? [null, null, null, null],
  );
  const [questionIndex, setQuestionIndex] = useState(0);
  const [selectedAssistantIds, setSelectedAssistantIds] = useState<StarterId[]>(
    initialProfile?.selectedAssistantIds ?? [],
  );
  const [aiAssistantOptions, setAiAssistantOptions] = useState<StarterId[]>(
    mode === 'edit' && initialProfile?.version === 3 && initialProfile.workMatch?.source === 'ai'
      ? (initialProfile.selectedAssistantIds ?? [])
      : [],
  );
  const [responseDetail, setResponseDetail] = useState<ResponseDetail>(initialProfile?.responseDetail ?? 'balanced');
  const [filePermission, setFilePermission] = useState<FilePermissionPreference>(
    initialProfile?.filePermission ?? 'ask-every-time',
  );
  const [match, setMatch] = useState<OnboardingWorkMatch | null>(
    mode === 'edit' && initialProfile?.version === 3 ? (initialProfile.workMatch ?? null) : null,
  );
  const [matchFailed, setMatchFailed] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [mayHaveUsage, setMayHaveUsage] = useState(false);
  const [slow, setSlow] = useState(false);
  const activeRequest = useRef<{ sequence: number; controller: AbortController } | null>(null);
  const sequence = useRef(0);

  useEffect(
    () => () => {
      sequence.current += 1;
      activeRequest.current?.controller.abort();
    },
    [],
  );

  useEffect(() => {
    if (page !== 'matching') return;
    const timeout = window.setTimeout(() => setSlow(true), 10_000);
    return () => window.clearTimeout(timeout);
  }, [page]);

  const draft: OnboardingProfile = {
    version: 3,
    userId,
    nickname: nickname.trim(),
    introduction: introduction.trim(),
    role,
    customRole: customRole.trim(),
    useCases,
    customGoal: customGoal.trim(),
    selectedAssistantIds,
    responseDetail,
    filePermission,
    completedAt: initialProfile?.completedAt ?? '',
    industry: industry ?? undefined,
    questionnaire: { version: 1, answers },
    persona: initialProfile?.persona ?? { id: null, source: 'default', ruleVersion: null },
  };
  const recommendations = recommendAssistants(draft).slice(0, 3);
  const canSubmit = Boolean(industry);
  const canMatch = Boolean(workMatch?.scopeKey && canSubmit);

  const answerQuestion = (answer: OnboardingQuestionAnswer) => {
    setAnswers(
      (current) =>
        current.map((value, index) => (index === questionIndex ? answer : value)) as OnboardingQuestionAnswers,
    );
    setQuestionIndex((current) => Math.min(current + 1, FIRST_RUN_QUESTIONS.length - 1));
  };

  const basic = () => {
    if (!canSubmit) return;
    sequence.current += 1;
    activeRequest.current?.controller.abort();
    activeRequest.current = null;
    const input = buildOnboardingWorkMatchInput(draft, workMatch?.scopeKey ?? 'account-local');
    setMatch({ source: 'basic', profileVersion: input.profileVersion });
    setSelectedAssistantIds(recommendations.map((item) => item.id));
    setPage('result');
  };

  const generate = async () => {
    if (!canMatch || !workMatch || activeRequest.current) return;
    const input = buildOnboardingWorkMatchInput(draft, workMatch.scopeKey);
    const current = { sequence: ++sequence.current, controller: new AbortController() };
    activeRequest.current = current;
    setMatchFailed(false);
    setMayHaveUsage(true);
    setSlow(false);
    setPage('matching');
    try {
      const response = await workMatch.request(input, current.controller.signal);
      if (sequence.current !== current.sequence) return;
      const checked = validateOnboardingWorkMatchReply(input, response);
      if (!checked) throw new Error('onboarding_match_invalid_response');
      setMatch({
        source: 'ai',
        profileVersion: checked.profileVersion,
        requestId: checked.requestId,
        runId: checked.runId,
        modelId: checked.modelId,
        summary: checked.summary,
        starters: checked.starters,
        usageStatus: checked.usageStatus,
      });
      setSelectedAssistantIds(checked.selectedAssistantIds);
      setAiAssistantOptions(checked.selectedAssistantIds);
      setPage('result');
    } catch {
      if (sequence.current !== current.sequence) return;
      setMatchFailed(true);
      setPage('profile');
    } finally {
      if (activeRequest.current?.sequence === current.sequence) activeRequest.current = null;
    }
  };

  const confirm = () => {
    if (!industry || !match || selectedAssistantIds.length === 0) return;
    setSaveFailed(false);
    try {
      onComplete({ ...draft, industry, workMatch: match, completedAt: new Date().toISOString() });
    } catch {
      setSaveFailed(true);
    }
  };
  const choice = (active: boolean) =>
    cn(
      CHOICE_CLASS,
      active
        ? 'border-[var(--accent)] bg-[var(--accent-dim)] text-[var(--text-primary)]'
        : 'border-[var(--border)] bg-[var(--bg-elevated)] text-[var(--text-secondary)]',
    );

  return (
    <div className="brand-first-run h-screen overflow-y-auto bg-[var(--surface-onboarding-page)] text-[var(--text-primary)]">
      <header className="border-b border-[var(--border-subtle)] px-5 py-4">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <img src={logo} alt={t('common.appName')} className="h-9 w-9 rounded-lg" />
            <span className="type-label">{t('common.appName')}</span>
          </div>
          <ol className="flex gap-4 type-support" aria-label={t('onboarding.progress')}>
            {(['profile', 'matching', 'result'] as const).map((item) => (
              <li
                key={item}
                aria-current={page === item ? 'step' : undefined}
                className={page === item ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'}
              >
                {t(`onboarding.firstRun.steps.${item}`)}
              </li>
            ))}
          </ol>
        </div>
      </header>
      <main className="mx-auto max-w-5xl space-y-6 px-5 py-8">
        <h1 className="type-page-title">{t(`onboarding.firstRun.titles.${page}`)}</h1>
        {page === 'profile' && (
          <>
            <p className="type-body text-[var(--text-secondary)]">{t('onboarding.firstRun.profileNotice')}</p>
            <section className="grid gap-5 rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-5 sm:grid-cols-2">
              <label className="type-label">
                {t('onboarding.nickname')}
                <input
                  data-first-run-nickname
                  value={nickname}
                  maxLength={80}
                  onChange={(event) => setNickname(event.target.value)}
                  className={FIELD_CLASS}
                />
              </label>
              <label className="type-label">
                {t('onboarding.firstRun.introduction')}
                <input
                  value={introduction}
                  maxLength={400}
                  onChange={(event) => setIntroduction(event.target.value)}
                  className={FIELD_CLASS}
                />
              </label>
              <fieldset className="space-y-3 sm:col-span-2">
                <legend className="type-label">{t('onboarding.firstRun.industry')}</legend>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  {([...ONBOARDING_INDUSTRY_CODES, 'general'] as const).map((code) => {
                    const active = code === 'general' ? industry?.generalConfirmed === true : industry?.code === code;
                    return (
                      <button
                        key={code}
                        data-industry={code}
                        type="button"
                        aria-pressed={active}
                        className={choice(active)}
                        onClick={() =>
                          setIndustry({
                            code: code === 'general' ? null : code,
                            generalConfirmed: code === 'general',
                            source: 'user',
                            catalogVersion: 1,
                          })
                        }
                      >
                        {t(`onboarding.firstRun.industries.${code}`)}
                      </button>
                    );
                  })}
                </div>
              </fieldset>
              <label className="type-label">
                {t('onboarding.firstRun.role')}
                <select
                  value={role}
                  onChange={(event) => setRole(event.target.value as OnboardingRoleId)}
                  className={FIELD_CLASS}
                >
                  {ROLES.map(({ id }) => (
                    <option key={id} value={id}>
                      {t(`onboarding.roles.${id}.title`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="type-label">
                {t('onboarding.firstRun.customRole')}
                <input
                  data-custom-role
                  value={customRole}
                  maxLength={160}
                  onChange={(event) => setCustomRole(event.target.value)}
                  className={FIELD_CLASS}
                />
              </label>
              <fieldset className="space-y-3 sm:col-span-2">
                <legend className="type-label">{t('onboarding.firstRun.tasks')}</legend>
                <div className="grid gap-2 sm:grid-cols-3">
                  {USE_CASES.map(({ id }) => (
                    <button
                      key={id}
                      type="button"
                      aria-pressed={useCases.includes(id)}
                      className={choice(useCases.includes(id))}
                      onClick={() =>
                        setUseCases((current) =>
                          current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
                        )
                      }
                    >
                      {t(`onboarding.useCases.${id}.title`)}
                    </button>
                  ))}
                </div>
              </fieldset>
              <label className="type-label sm:col-span-2">
                {t('onboarding.firstRun.goal')}
                <textarea
                  data-first-run-goal
                  value={customGoal}
                  maxLength={2_000}
                  rows={3}
                  onChange={(event) => setCustomGoal(event.target.value)}
                  className={FIELD_CLASS}
                />
              </label>
              <label className="type-label">
                {t('onboarding.responseDetail')}
                <select
                  value={responseDetail}
                  onChange={(event) => setResponseDetail(event.target.value as ResponseDetail)}
                  className={FIELD_CLASS}
                >
                  {(['concise', 'balanced', 'detailed'] as const).map((value) => (
                    <option key={value} value={value}>
                      {t(`onboarding.responseOptions.${value}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="type-label">
                {t('onboarding.filePermission')}
                <select
                  value={filePermission}
                  onChange={(event) => setFilePermission(event.target.value as FilePermissionPreference)}
                  className={FIELD_CLASS}
                >
                  {(['ask-every-time', 'task-folder'] as const).map((value) => (
                    <option key={value} value={value}>
                      {t(`onboarding.fileOptions.${value}.title`)}
                    </option>
                  ))}
                </select>
              </label>
            </section>
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
                    onClick={() => answerQuestion(answer)}
                  >
                    {t(answer === 'yes' ? 'onboarding.firstRun.answerYes' : 'onboarding.firstRun.answerNo')}
                  </button>
                ))}
              </div>
              <div className="flex items-center justify-between gap-3">
                <Button
                  variant="ghost"
                  disabled={questionIndex === 0}
                  onClick={() => setQuestionIndex((value) => Math.max(value - 1, 0))}
                >
                  {t('onboarding.firstRun.questionBack')}
                </Button>
                <span className="type-support text-[var(--text-muted)]">
                  {questionIndex + 1} / {FIRST_RUN_QUESTIONS.length}
                </span>
                <Button variant="ghost" onClick={() => answerQuestion(null)}>
                  {t('onboarding.firstRun.questionSkip')}
                </Button>
              </div>
            </section>
            <section className="space-y-3">
              <p className="type-support text-[var(--text-secondary)]">{t('onboarding.firstRun.chargeNotice')}</p>
              {!workMatch && (
                <p role="status" className="type-support text-[var(--text-muted)]">
                  {t('onboarding.firstRun.matchUnavailable')}
                </p>
              )}
              {matchFailed && (
                <p role="alert" className="type-support text-[var(--danger)]">
                  {t('onboarding.firstRun.matchFailed')}
                </p>
              )}
              {saveFailed && (
                <p
                  role="alert"
                  className="border-l-2 border-[var(--danger)] pl-3 type-support text-[var(--text-primary)]"
                >
                  {t('teams.wizard.saveError')}
                </p>
              )}
              <div className="flex flex-wrap gap-3">
                {mode === 'edit' && match && (
                  <Button disabled={!canSubmit || selectedAssistantIds.length === 0} onClick={confirm}>
                    {t('onboarding.save')}
                  </Button>
                )}
                <Button
                  data-primary-action
                  disabled={!canMatch}
                  onClick={() => {
                    void generate();
                  }}
                >
                  {t('onboarding.firstRun.generate')}
                  <Sparkles size={16} />
                </Button>
                <Button variant="secondary" disabled={!canSubmit} onClick={basic}>
                  {t('onboarding.firstRun.useBasic')}
                </Button>
                {mode === 'edit' && (
                  <Button variant="ghost" onClick={onCancel}>
                    {t('onboarding.cancel')}
                  </Button>
                )}
              </div>
            </section>
          </>
        )}
        {page === 'matching' && (
          <section
            role="status"
            className="space-y-5 rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-6"
          >
            <p className="type-body">{t('onboarding.firstRun.matching')}</p>
            {slow && <p className="type-support text-[var(--text-secondary)]">{t('onboarding.firstRun.matchSlow')}</p>}
            <p className="type-support text-[var(--text-muted)]">{t('onboarding.firstRun.inFlightNotice')}</p>
            <Button variant="secondary" onClick={basic}>
              {t('onboarding.firstRun.useBasic')}
            </Button>
          </section>
        )}
        {page === 'result' && match && (
          <>
            <section className="grid gap-5 rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-6 sm:grid-cols-3">
              <div className="space-y-3 text-center">
                <UserRound size={72} className="mx-auto text-[var(--text-muted)]" />
                <p className="type-support text-[var(--text-muted)]">{t('onboarding.firstRun.personaUnavailable')}</p>
                <p className="type-support">
                  {t(
                    draft.persona?.source === 'user'
                      ? 'onboarding.firstRun.personaSourceUser'
                      : draft.persona?.source === 'approved-rule'
                        ? 'onboarding.firstRun.personaSourceRule'
                        : 'onboarding.firstRun.personaSourceDefault',
                  )}
                </p>
              </div>
              <div className="space-y-3 sm:col-span-2">
                <p className="type-section-title">{nickname.trim() || t('onboarding.firstRun.nicknameFallback')}</p>
                <p className="type-support text-[var(--text-secondary)]">
                  {t(`onboarding.firstRun.industries.${industry?.code ?? 'general'}`)} ·{' '}
                  {customRole.trim() || t(`onboarding.roles.${role}.title`)}
                </p>
                <p data-match-source={match.source} className="type-label text-[var(--accent)]">
                  {t(match.source === 'ai' ? 'onboarding.firstRun.sourceAi' : 'onboarding.firstRun.sourceBasic')}
                </p>
                <p className="type-body">
                  {match.source === 'ai'
                    ? match.summary
                    : customGoal.trim() || t('onboarding.firstRun.basicDescription')}
                </p>
                {match.source === 'ai' && (
                  <>
                    <p className="type-support text-[var(--text-muted)]">
                      {t('onboarding.firstRun.model')}: {match.modelId}
                    </p>
                    <p className="type-support text-[var(--text-muted)]">
                      {t(
                        match.usageStatus === 'pending'
                          ? 'onboarding.firstRun.usagePending'
                          : 'onboarding.firstRun.usageSettled',
                      )}
                    </p>
                    <ul className="list-inside list-disc space-y-1 type-support">
                      {match.starters.map((entry) => (
                        <li key={entry}>{entry}</li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            </section>
            <section className="space-y-3">
              <h2 className="type-section-title">{t('onboarding.firstRun.assistantTitle')}</h2>
              <p className="type-support text-[var(--text-secondary)]">{t('onboarding.firstRun.assistantNotice')}</p>
              <div className="grid gap-3 sm:grid-cols-3">
                {(match.source === 'ai' ? aiAssistantOptions : recommendations.map((item) => item.id)).map((id) => {
                  const active = selectedAssistantIds.includes(id);
                  const Icon = ASSISTANT_ICONS[id];
                  return (
                    <button
                      key={id}
                      type="button"
                      data-assistant={id}
                      aria-pressed={active}
                      className={choice(active)}
                      onClick={() =>
                        setSelectedAssistantIds((current) =>
                          current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
                        )
                      }
                    >
                      <Icon size={22} className="mb-3 text-[var(--accent)]" />
                      <span className="type-label">{t(`onboarding.assistants.${id}.name`)}</span>
                    </button>
                  );
                })}
              </div>
            </section>
            {mayHaveUsage && match.source === 'basic' && (
              <p role="status" className="type-support text-[var(--text-muted)]">
                {t('onboarding.firstRun.inFlightNotice')}
              </p>
            )}
            {saveFailed && (
              <p
                role="alert"
                className="border-l-2 border-[var(--danger)] pl-3 type-support text-[var(--text-primary)]"
              >
                {t('teams.wizard.saveError')}
              </p>
            )}
            <div className="flex flex-wrap gap-3">
              <Button variant="ghost" onClick={() => setPage('profile')}>
                {t('onboarding.firstRun.editProfile')}
              </Button>
              <Button data-primary-action disabled={selectedAssistantIds.length === 0} onClick={confirm}>
                {t('onboarding.firstRun.confirm')}
                <Check size={16} />
              </Button>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

export default function Onboarding(props: OnboardingProps) {
  const profile = props.initialProfile?.userId === props.userId ? props.initialProfile : null;
  if (props.mode === 'edit' && profile?.version !== 3) return <LegacyOnboarding {...props} initialProfile={profile} />;
  return (
    <FirstRunOnboarding
      key={`${props.userId}:${props.workMatch?.scopeKey ?? 'account-local'}`}
      {...props}
      initialProfile={profile}
    />
  );
}
