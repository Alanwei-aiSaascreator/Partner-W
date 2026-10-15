import { useEffect, useMemo, useState } from 'react';
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
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Trigger as DialogTrigger } from '@radix-ui/react-dialog';
import { cn } from '@/lib/utils';
import {
  recommendAssistants,
  ONBOARDING_INDUSTRY_CODES,
  buildOnboardingWorkMatchInput,
  clearOnboardingDraft,
  onboardingDraftScope,
  readOnboardingDraft,
  saveOnboardingDraft,
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
import PortraitCard from '@/components/PortraitCard';
import PortraitQuestions, { FIRST_RUN_QUESTIONS } from '@/components/PortraitQuestions';
import {
  PORTRAIT_AGE_MAX,
  PORTRAIT_AGE_MIN,
  derivePortrait,
  parsePortraitAge,
  toOnboardingPortrait,
  withPortraitDetails,
  type OnboardingPortrait,
  type PortraitGender,
} from '@/lib/user-portrait';
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
  /**
   * V1 收口（2026-10-06）新顺序：工作资料 → 趣味画像 → 团队确认（结果）。
   * ⚠️ 旧顺序是「趣味画像 → 工作资料 → 匹配 → 结果」；本批次**不开放 AI 匹配通道**
   *    （生产从不传 workMatch），匹配页删除，生成改走本地 basic() 路径。
   * ⚠️ 编辑模式与首跑都默认落在「工作资料」；本流程改动只影响首跑页序，
   *    draft / 存储键 / 保存路径均未变。
   *
   * ⭐ 首跑草稿（2026-10-07 体检问题 7）：中途刷新/关掉应用再进来，**接着填**。
   *    作用域 = `userId:scopeKey`（与 `App` 挂这个组件用的 key 同一把）——换账号或换工作区
   *    都拿不到上一份草稿。编辑模式**不读不写**（有真档案，草稿只会打架）。
   */
  const draftScope = onboardingDraftScope(userId, workMatch?.scopeKey);
  const [restoredDraft] = useState(() => (mode === 'first-run' ? readOnboardingDraft(draftScope) : null));
  const [page, setPage] = useState<'profile' | 'portrait' | 'result'>(
    // 结果页需要那份本地回执（`page === 'result' && match` 才渲染）；名单丢了就退回资料页，
    // 不留一个白屏。
    restoredDraft?.page === 'result' && !restoredDraft.match ? 'profile' : (restoredDraft?.page ?? 'profile'),
  );
  const [portraitDone, setPortraitDone] = useState(
    restoredDraft?.portraitDone ?? (mode === 'edit' && Boolean(initialProfile?.portrait)),
  );
  /** 本次会话里**真的动过四题**没有 —— 决定保存时按新答案重算，还是原样保留档案里的旧规则画像。 */
  const [portraitTouched, setPortraitTouched] = useState(restoredDraft?.portraitTouched ?? false);
  const [nickname, setNickname] = useState(restoredDraft?.nickname ?? initialProfile?.nickname ?? defaultNickname);
  const [introduction, setIntroduction] = useState(restoredDraft?.introduction ?? initialProfile?.introduction ?? '');
  const [industry, setIndustry] = useState<OnboardingIndustry | null>(
    restoredDraft?.industry ?? initialProfile?.industry ?? null,
  );
  const [role, setRole] = useState<OnboardingRoleId>(restoredDraft?.role ?? initialProfile?.role ?? 'custom');
  const [customRole, setCustomRole] = useState(restoredDraft?.customRole ?? initialProfile?.customRole ?? '');
  const [useCases, setUseCases] = useState<OnboardingUseCaseId[]>(
    restoredDraft?.useCases ?? initialProfile?.useCases ?? [],
  );
  const [customGoal, setCustomGoal] = useState(restoredDraft?.customGoal ?? initialProfile?.customGoal ?? '');
  const [answers, setAnswers] = useState<OnboardingQuestionAnswers>(
    restoredDraft?.answers ?? initialProfile?.questionnaire?.answers ?? [null, null, null, null],
  );
  const [questionIndex, setQuestionIndex] = useState(restoredDraft?.questionIndex ?? 0);
  /**
   * 形象层补充信息（2026-10-08，16 型形象）：性别 + 年龄。
   * ⭐ 它们**不影响** `portraitTouched`（四题答没答是另一回事）：只改性别/年龄时，
   *    画像主体按档案原样保留（`withPortraitDetails`），不用新规则重算旧记录。
   * 年龄用字符串 state 托着输入（空串 = 没填），落档案时才过 `parsePortraitAge`。
   */
  const [gender, setGender] = useState<PortraitGender | null>(
    restoredDraft?.gender ?? initialProfile?.portrait?.gender ?? null,
  );
  const [ageInput, setAgeInput] = useState<string>(() => {
    const storedAge = restoredDraft?.age ?? initialProfile?.portrait?.age;
    return storedAge == null ? '' : String(storedAge);
  });
  const age = parsePortraitAge(ageInput.trim() === '' ? null : Number(ageInput.trim()));
  const [selectedAssistantIds, setSelectedAssistantIds] = useState<StarterId[]>(
    restoredDraft?.selectedAssistantIds ?? initialProfile?.selectedAssistantIds ?? [],
  );
  const [aiAssistantOptions] = useState<StarterId[]>(
    mode === 'edit' && initialProfile?.version === 3 && initialProfile.workMatch?.source === 'ai'
      ? (initialProfile.selectedAssistantIds ?? [])
      : [],
  );
  const [responseDetail, setResponseDetail] = useState<ResponseDetail>(initialProfile?.responseDetail ?? 'balanced');
  const [filePermission, setFilePermission] = useState<FilePermissionPreference>(
    initialProfile?.filePermission ?? 'ask-every-time',
  );
  const [match, setMatch] = useState<OnboardingWorkMatch | null>(
    mode === 'edit'
      ? initialProfile?.version === 3
        ? (initialProfile.workMatch ?? null)
        : null
      : (restoredDraft?.match ?? null),
  );
  const [saveFailed, setSaveFailed] = useState(false);
  const portrait = useMemo(() => derivePortrait(answers), [answers]);
  /**
   * 固化规则：
   * - 本次**真的动过四题**（答题或跳过）⇒ 以本次答案为准；四题全跳过 ⇒ 不写 portrait
   *   （红线：不生成虚构分数）。
   * - 没动过 ⇒ 原样保留档案里已有的 portrait，**不用新规则偷偷重算旧记录**
   *   （`ruleVersion` 才钉得住，施工图 §8 风险 3）。
   */
  const portraitRecord: OnboardingPortrait | undefined = portraitTouched
    ? (toOnboardingPortrait(portrait, true, { gender, age }) ?? undefined)
    : // 没动四题：画像主体一个字不动，只把形象层的性别/年龄并进去（只覆盖、不删除）。
      initialProfile?.portrait
      ? withPortraitDetails(initialProfile.portrait, { gender, age })
      : undefined;
  /** 结果区展示的必须是**将写入档案的那一份**：动过四题 = 本次派生，否则 = 档案里的旧记录。 */
  const portraitPreview: OnboardingPortrait | null = portraitTouched
    ? toOnboardingPortrait(portrait, false, { gender, age })
    : (portraitRecord ?? null);

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
    ...(portraitRecord ? { portrait: portraitRecord } : {}),
  };
  const recommendations = recommendAssistants(draft).slice(0, 3);
  const canSubmit = Boolean(industry);

  /** 把当前进度落进首跑草稿（见上面 `draftScope` 的说明）；写失败一律忽略。 */
  useEffect(() => {
    if (mode !== 'first-run') return;
    saveOnboardingDraft(draftScope, {
      version: 1,
      page,
      nickname,
      introduction,
      industry,
      role,
      customRole,
      useCases,
      customGoal,
      answers,
      questionIndex,
      portraitDone,
      portraitTouched,
      gender,
      age,
      selectedAssistantIds,
      match: match?.source === 'basic' ? { source: 'basic', profileVersion: match.profileVersion } : null,
    });
  }, [
    mode,
    draftScope,
    page,
    nickname,
    introduction,
    industry,
    role,
    customRole,
    useCases,
    customGoal,
    answers,
    questionIndex,
    portraitDone,
    portraitTouched,
    gender,
    age,
    selectedAssistantIds,
    match,
  ]);

  const answerQuestion = (answer: OnboardingQuestionAnswer) => {
    setPortraitTouched(true);
    setAnswers(
      (current) =>
        current.map((value, index) => (index === questionIndex ? answer : value)) as OnboardingQuestionAnswers,
    );
    if (questionIndex >= FIRST_RUN_QUESTIONS.length - 1) {
      setPortraitDone(true);
      return;
    }
    setQuestionIndex((current) => Math.min(current + 1, FIRST_RUN_QUESTIONS.length - 1));
  };

  /** 「重测」：回到第一题、**保留**已选答案（要清空就逐题跳过），走完四题后结果按新答案刷新。 */
  const retestPortrait = () => {
    setPortraitTouched(false);
    setQuestionIndex(0);
    setPortraitDone(false);
  };

  /**
   * 本地生成（不调模型）：按当前资料给出基础团队配置，约 1 秒内出结果。
   * target='portrait' —— 首跑点「生成我的 AI 团队」先过一遍趣味画像四题；
   * target='result'   —— 画像答完（或编辑模式显式生成）直接看结果。
   */
  const basic = (target: 'portrait' | 'result' = 'result') => {
    if (!canSubmit) return;
    const input = buildOnboardingWorkMatchInput(draft, workMatch?.scopeKey ?? 'account-local');
    setMatch({ source: 'basic', profileVersion: input.profileVersion });
    setSelectedAssistantIds(recommendations.map((item) => item.id));
    setPage(target);
  };

  /**
   * 画像页收尾：首跑跑本地 basic() 进结果页；编辑模式回到资料页保存
   * （不重算匹配，保住档案里已存的 AI 回执）。没选行业时回资料页补选。
   */
  const finishPortrait = () => {
    if (mode === 'edit' || !canSubmit) {
      setPage('profile');
      return;
    }
    basic('result');
  };

  const confirm = () => {
    if (!industry || !match || selectedAssistantIds.length === 0) return;
    setSaveFailed(false);
    try {
      onComplete({ ...draft, industry, workMatch: match, completedAt: new Date().toISOString() });
    } catch {
      // 写盘失败（配额/隐私模式）：草稿**留着**，用户重试时输入还在。
      setSaveFailed(true);
      return;
    }
    // 档案已经交出去了 ⇒ 草稿使命结束（再留着，下次进来会"复活"上一轮的输入）。
    if (mode === 'first-run') clearOnboardingDraft(draftScope);
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
          <div className="flex shrink-0 items-center gap-3">
            <img src={logo} alt={t('common.appName')} className="h-9 w-9 rounded-lg" />
            <span className="type-label whitespace-nowrap">{t('common.appName')}</span>
          </div>
          {/* 步骤条跟随新页序（工作资料 → 趣味画像 → 团队确认）；matching 步骤随 AI 匹配通道一并下线。 */}
          <ol
            className="flex min-w-0 flex-wrap justify-end gap-x-4 gap-y-1 type-support"
            aria-label={t('onboarding.progress')}
          >
            {(['profile', 'portrait', 'result'] as const).map((item) => (
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
        <div className="flex flex-wrap items-start justify-between gap-4">
          <h1 className="type-page-title min-w-0 break-words">{t(`onboarding.firstRun.titles.${page}`)}</h1>
          {page === 'result' && match && (
            <div data-result-actions className="flex flex-wrap gap-3">
              <Button data-primary-action disabled={selectedAssistantIds.length === 0} onClick={confirm}>
                {t('onboarding.firstRun.confirm')}
                <Check size={16} />
              </Button>
              <Button variant="ghost" onClick={() => setPage('profile')}>
                {t('onboarding.firstRun.editProfile')}
              </Button>
            </div>
          )}
        </div>
        {page === 'portrait' && (
          <>
            <p className="type-body text-[var(--text-secondary)]">{t('onboarding.portrait.subtitle')}</p>
            {/* 形象层补充信息（2026-10-08，16 型形象）：性别二选一 + 年龄（可空）。
                两项都不填也照样往下走 —— 没有它们就退回六角色立绘，不阻塞流程。 */}
            <section
              data-portrait-details
              className="grid gap-4 rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-5 sm:grid-cols-2"
            >
              <fieldset className="space-y-2">
                <legend className="type-label">{t('onboarding.portrait.genderLabel')}</legend>
                <div className="flex flex-wrap gap-3">
                  {(['male', 'female'] as const).map((value) => (
                    <button
                      key={value}
                      data-gender-option={value}
                      type="button"
                      aria-pressed={gender === value}
                      className={choice(gender === value)}
                      onClick={() => setGender(value)}
                    >
                      {t(`onboarding.portrait.gender.${value}`)}
                    </button>
                  ))}
                </div>
              </fieldset>
              <label className="type-label">
                {t('onboarding.portrait.ageLabel')}
                <input
                  data-portrait-age-input
                  type="number"
                  inputMode="numeric"
                  min={PORTRAIT_AGE_MIN}
                  max={PORTRAIT_AGE_MAX}
                  value={ageInput}
                  placeholder={t('onboarding.portrait.agePlaceholder')}
                  onChange={(event) => setAgeInput(event.target.value)}
                  className={FIELD_CLASS}
                />
              </label>
            </section>
            {portraitDone ? (
              <>
                {portraitPreview ? (
                  // 展示的必须是**将写入档案的那一份**（改性别立刻换形象，与保存结果同源）
                  <PortraitCard
                    axes={portraitPreview.axes}
                    letters={portraitPreview.letters}
                    role={portraitPreview.role}
                    gender={portraitPreview.gender}
                    age={portraitPreview.age}
                  />
                ) : (
                  <p
                    role="status"
                    className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-5 type-support text-[var(--text-secondary)]"
                  >
                    {t('onboarding.portrait.allSkipped')}
                  </p>
                )}
                <div className="flex flex-wrap gap-3">
                  <Button variant="secondary" data-action="portrait-retest" onClick={retestPortrait}>
                    {t('onboarding.portrait.retest')}
                  </Button>
                  <Button data-primary-action onClick={finishPortrait}>
                    {t('onboarding.portrait.next')}
                    <ArrowRight size={15} />
                  </Button>
                </div>
              </>
            ) : (
              <>
                <PortraitQuestions
                  questionIndex={questionIndex}
                  answers={answers}
                  onAnswer={answerQuestion}
                  onBack={() => setQuestionIndex((value) => Math.max(value - 1, 0))}
                  onSkip={() => answerQuestion(null)}
                />
                {mode === 'edit' && (
                  <div>
                    <Button variant="ghost" onClick={() => setPage('profile')}>
                      {t('onboarding.portrait.backToProfile')}
                    </Button>
                  </div>
                )}
              </>
            )}
          </>
        )}
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
              {/* V1 收口：回答详细程度 / 文件访问方式两块首跑不再展示（缺省值照旧保存）；
                  编辑模式保留渲染，老用户仍可改。 */}
              {mode === 'edit' && (
                <>
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
                </>
              )}
            </section>
            <section className="space-y-3">
              <p className="type-support text-[var(--text-secondary)]">{t('onboarding.firstRun.chargeNotice')}</p>
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
                {/* 主按钮：本地生成（不调模型）。首跑先过画像四题，编辑模式直接看结果。
                    旧版依赖 workMatch 的 AI 匹配在本批次不开放——生产从不传 workMatch，
                    导致按钮恒为 disabled（真机"死按钮"根因），禁用条件改为只看资料是否完整。 */}
                <Button
                  data-primary-action
                  disabled={!canSubmit}
                  onClick={() => basic(mode === 'edit' ? 'result' : 'portrait')}
                >
                  {t('onboarding.firstRun.generate')}
                  <Sparkles size={16} />
                </Button>
                {/* 次级「使用基础方案」已移除（图5 口径：同页多条路径难理解）：
                    主按钮本身就是零模型的本地生成，不再需要平行的快捷入口；
                    跳过趣味画像的旁路一并收口，首跑只有「资料 → 画像 → 结果」一条路。 */}
                <Button variant="ghost" data-action="portrait-open" onClick={() => setPage('portrait')}>
                  {t('onboarding.portrait.editEntry')}
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
        {page === 'result' && match && (
          <>
            {saveFailed && (
              <p
                role="alert"
                className="border-l-2 border-[var(--danger)] pl-3 type-support text-[var(--text-primary)]"
              >
                {t('teams.wizard.saveError')}
              </p>
            )}
            <section className="grid items-start gap-5 md:grid-cols-3">
              <div data-result-work className="min-w-0 space-y-5 break-words md:col-span-2">
                <div className="space-y-3 rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-5">
                  <h2 className="type-section-title">{nickname.trim() || t('onboarding.firstRun.nicknameFallback')}</h2>
                  <p className="type-support text-[var(--text-secondary)]">
                    {t(`onboarding.firstRun.industries.${industry?.code ?? 'general'}`)} ·{' '}
                    {customRole.trim() || t(`onboarding.roles.${role}.title`)}
                  </p>
                  {introduction.trim() && (
                    <p className="type-support text-[var(--text-secondary)]">{introduction.trim()}</p>
                  )}
                  {useCases.length > 0 && (
                    <div data-result-use-cases className="flex flex-wrap gap-2">
                      {useCases.map((id) => (
                        <span key={id} className="type-support rounded-lg bg-[var(--bg-tertiary)] px-3 py-1">
                          {t(`onboarding.useCases.${id}.title`)}
                        </span>
                      ))}
                    </div>
                  )}
                  {customGoal.trim() && (
                    <p data-result-goal className="type-body">
                      {customGoal.trim()}
                    </p>
                  )}
                  <p data-match-source={match.source} className="type-support text-[var(--accent)]">
                    {t(match.source === 'ai' ? 'onboarding.firstRun.sourceAi' : 'onboarding.firstRun.sourceBasic')}
                  </p>
                  {match.source === 'ai' ? (
                    <>
                      <p className="type-body">{match.summary}</p>
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
                      <ul className="type-support list-inside list-disc text-[var(--text-secondary)]">
                        {match.starters.map((entry) => (
                          <li key={entry}>{entry}</li>
                        ))}
                      </ul>
                    </>
                  ) : !customGoal.trim() && !useCases.length ? (
                    <p className="type-support text-[var(--text-secondary)]">
                      {t('onboarding.firstRun.basicDescription')}
                    </p>
                  ) : null}
                </div>
                <section className="space-y-3" aria-labelledby="result-capabilities-title">
                  <h2 id="result-capabilities-title" className="type-section-title">
                    {t('onboarding.firstRun.result.capabilityTitle')}
                  </h2>
                  <p className="type-support text-[var(--text-secondary)]">
                    {t('onboarding.firstRun.result.capabilityNotice')}
                  </p>
                  <div className="space-y-3">
                    {(match.source === 'ai' ? aiAssistantOptions : recommendations.map((item) => item.id)).map((id) => {
                      const active = selectedAssistantIds.includes(id);
                      const Icon = ASSISTANT_ICONS[id];
                      const recommendation = recommendations.find((item) => item.id === id);
                      return (
                        <button
                          key={id}
                          type="button"
                          data-assistant={id}
                          aria-pressed={active}
                          className={cn(choice(active), 'flex w-full min-w-0 items-start gap-3')}
                          onClick={() =>
                            setSelectedAssistantIds((current) =>
                              current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
                            )
                          }
                        >
                          <Icon size={22} className="mt-1 shrink-0 text-[var(--accent)]" />
                          <span className="min-w-0 flex-1 space-y-1 break-words">
                            <span className="type-label block">
                              {t(`onboarding.firstRun.result.capabilities.${id}`)}
                            </span>
                            <span
                              data-recommendation-reason={recommendation?.reason}
                              className="type-support block text-[var(--text-secondary)]"
                            >
                              {recommendation
                                ? t(`onboarding.firstRun.result.reasons.${id}`)
                                : t(`assistantWorkspaces.${id}.description`)}
                            </span>
                            <span data-skill-task className="type-support block text-[var(--text-muted)]">
                              {t(`assistantWorkspaces.${id}.starters.1.title`)} ·{' '}
                              {t(`assistantWorkspaces.${id}.starters.1.description`)}
                            </span>
                          </span>
                          <span
                            className="mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded border border-[var(--border)]"
                            aria-hidden="true"
                          >
                            {active && <Check size={14} className="text-[var(--accent)]" />}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </section>
              </div>
              <aside className="min-w-0 space-y-3 rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-5">
                {portraitPreview ? (
                  <>
                    <PortraitCard
                      axes={portraitPreview.axes}
                      letters={portraitPreview.letters}
                      role={portraitPreview.role}
                      gender={portraitPreview.gender}
                      age={portraitPreview.age}
                      variant="compact"
                      className="border-0 bg-transparent p-0"
                    />
                    <Dialog>
                      <DialogTrigger asChild>
                        <Button variant="ghost" className="w-full">
                          {t('onboarding.firstRun.result.viewPortrait')}
                        </Button>
                      </DialogTrigger>
                      <DialogContent className="max-w-4xl" aria-describedby={undefined}>
                        <DialogTitle className="mb-5 pr-6">{t('onboarding.portrait.resultTitle')}</DialogTitle>
                        <PortraitCard
                          axes={portraitPreview.axes}
                          letters={portraitPreview.letters}
                          role={portraitPreview.role}
                          gender={portraitPreview.gender}
                          age={portraitPreview.age}
                        />
                      </DialogContent>
                    </Dialog>
                  </>
                ) : (
                  <div className="space-y-3 text-center">
                    <UserRound size={48} className="mx-auto text-[var(--text-muted)]" />
                    <p className="type-support text-[var(--text-muted)]">
                      {t('onboarding.firstRun.personaUnavailable')}
                    </p>
                  </div>
                )}
                <p className="type-support text-[var(--text-muted)]">
                  {t(
                    draft.persona?.source === 'user'
                      ? 'onboarding.firstRun.personaSourceUser'
                      : draft.persona?.source === 'approved-rule'
                        ? 'onboarding.firstRun.personaSourceRule'
                        : 'onboarding.firstRun.personaSourceDefault',
                  )}
                </p>
              </aside>
            </section>
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
