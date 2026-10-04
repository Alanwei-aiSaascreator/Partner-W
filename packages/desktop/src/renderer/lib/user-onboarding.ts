export const ONBOARDING_USE_CASE_IDS = [
  'general',
  'content',
  'video',
  'office',
  'ecommerce',
  'research',
  'family',
] as const;

export type OnboardingUseCaseId = (typeof ONBOARDING_USE_CASE_IDS)[number];
export type StarterId = 'content' | 'photography' | 'office' | 'research' | 'ecommerce' | 'family';

export const ONBOARDING_ROLE_IDS = ['owner', 'operations', 'sales', 'support', 'finance', 'custom'] as const;
export type OnboardingRoleId = (typeof ONBOARDING_ROLE_IDS)[number];
export type ResponseDetail = 'concise' | 'balanced' | 'detailed';
export type FilePermissionPreference = 'ask-every-time' | 'task-folder';

export const ONBOARDING_INDUSTRY_CODES = ['C', 'H', 'J', 'K', 'L', 'P', 'R'] as const;
export type OnboardingIndustryCode = (typeof ONBOARDING_INDUSTRY_CODES)[number];
export type OnboardingQuestionAnswer = 'yes' | 'no' | null;
export type OnboardingQuestionAnswers = [
  OnboardingQuestionAnswer,
  OnboardingQuestionAnswer,
  OnboardingQuestionAnswer,
  OnboardingQuestionAnswer,
];

export interface OnboardingIndustry {
  code: OnboardingIndustryCode | null;
  generalConfirmed: boolean;
  source: 'user';
  catalogVersion: 1;
}

export interface OnboardingPersona {
  id: string | null;
  source: 'default' | 'user' | 'approved-rule';
  ruleVersion: string | null;
}

export type OnboardingWorkMatch =
  | { source: 'basic'; profileVersion: string }
  | {
      source: 'ai';
      profileVersion: string;
      requestId: string;
      runId: string;
      modelId: string;
      summary: string;
      starters: string[];
      usageStatus: 'settled' | 'pending';
    };

export interface OnboardingWorkMatchInput {
  userId: string;
  scopeKey: string;
  profileVersion: string;
  industryCode: OnboardingIndustryCode | null;
  generalConfirmed: boolean;
  role: OnboardingRoleId;
  customRole: string;
  useCases: OnboardingUseCaseId[];
  customGoal: string;
  responseDetail: ResponseDetail;
}

export interface OnboardingWorkMatchReply {
  profileVersion: string;
  requestId: string;
  runId: string;
  modelId: string;
  summary: string;
  selectedAssistantIds: StarterId[];
  starters: string[];
  usageStatus: 'settled' | 'pending';
}

export interface OnboardingProfile {
  version: 1 | 2 | 3;
  userId: string;
  nickname: string;
  role?: OnboardingRoleId;
  customRole?: string;
  useCases: OnboardingUseCaseId[];
  customGoal: string;
  selectedAssistantIds?: StarterId[];
  responseDetail?: ResponseDetail;
  filePermission?: FilePermissionPreference;
  completedAt: string;
  introduction?: string;
  industry?: OnboardingIndustry;
  questionnaire?: { version: 1; answers: OnboardingQuestionAnswers };
  persona?: OnboardingPersona;
  workMatch?: OnboardingWorkMatch;
}

export interface NormalizedOnboardingProfile extends OnboardingProfile {
  version: 2 | 3;
  role: OnboardingRoleId;
  customRole: string;
  selectedAssistantIds: StarterId[];
  responseDetail: ResponseDetail;
  filePermission: FilePermissionPreference;
}

export interface AssistantRecommendation {
  id: StarterId;
  reason: string;
}

export interface OnboardingStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

const STORAGE_PREFIX = 'rongying-cube:onboarding:v1:';
const FIRST_RUN_STORAGE_PREFIX = 'rongying-cube:onboarding:v3:';
const DEFAULT_STARTERS: StarterId[] = ['content', 'office', 'photography', 'research', 'ecommerce', 'family'];

function boundedText(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= limit;
}

function firstRunFields(
  parsed: Partial<OnboardingProfile>,
): Pick<OnboardingProfile, 'introduction' | 'industry' | 'questionnaire' | 'persona' | 'workMatch'> | null {
  const industry = parsed.industry;
  if (
    !industry ||
    industry.source !== 'user' ||
    industry.catalogVersion !== 1 ||
    (industry.code !== null && !ONBOARDING_INDUSTRY_CODES.includes(industry.code)) ||
    (industry.code === null ? industry.generalConfirmed !== true : industry.generalConfirmed !== false)
  )
    return null;
  const questionnaire = parsed.questionnaire;
  if (
    questionnaire?.version !== 1 ||
    !Array.isArray(questionnaire.answers) ||
    questionnaire.answers.length !== 4 ||
    !questionnaire.answers.every((answer) => answer === 'yes' || answer === 'no' || answer === null)
  )
    return null;
  const persona = parsed.persona;
  if (
    !persona ||
    !['default', 'user', 'approved-rule'].includes(persona.source) ||
    (persona.id !== null && (typeof persona.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(persona.id))) ||
    (persona.ruleVersion !== null && typeof persona.ruleVersion !== 'string') ||
    (persona.source === 'approved-rule' && (!persona.id || !persona.ruleVersion))
  )
    return null;
  const workMatch = parsed.workMatch;
  if (!workMatch || typeof workMatch.profileVersion !== 'string' || !workMatch.profileVersion) return null;
  if (workMatch.source === 'ai') {
    if (
      !boundedText(workMatch.requestId, 160) ||
      !boundedText(workMatch.runId, 160) ||
      !boundedText(workMatch.modelId, 160) ||
      typeof workMatch.summary !== 'string' ||
      !workMatch.summary.trim() ||
      workMatch.summary.length > 240 ||
      !Array.isArray(workMatch.starters) ||
      workMatch.starters.length > 3 ||
      !workMatch.starters.every((entry) => typeof entry === 'string' && entry.trim() && entry.length <= 160) ||
      !['settled', 'pending'].includes(workMatch.usageStatus)
    )
      return null;
  } else if (workMatch.source !== 'basic') return null;
  return {
    introduction: typeof parsed.introduction === 'string' ? parsed.introduction : '',
    industry: { ...industry },
    questionnaire: { version: 1, answers: [...questionnaire.answers] },
    persona: { ...persona },
    workMatch: workMatch.source === 'basic' ? { ...workMatch } : { ...workMatch, starters: [...workMatch.starters] },
  };
}

export function buildOnboardingWorkMatchInput(profile: OnboardingProfile, scopeKey: string): OnboardingWorkMatchInput {
  const industry = profile.industry;
  if (!industry || !profile.userId || !scopeKey) throw new Error('onboarding_match_scope_or_industry_missing');
  const fields = {
    userId: profile.userId,
    scopeKey,
    industryCode: industry.code,
    generalConfirmed: industry.generalConfirmed,
    role: profile.role ?? 'custom',
    customRole: profile.customRole?.trim().replace(/\s+/g, ' ') ?? '',
    useCases: [...profile.useCases].sort(),
    customGoal: profile.customGoal.trim().replace(/\s+/g, ' '),
    responseDetail: profile.responseDetail ?? 'balanced',
  };
  const serialized = JSON.stringify(fields);
  let hash = 2166136261;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return { ...fields, profileVersion: (hash >>> 0).toString(36) };
}

export function validateOnboardingWorkMatchReply(
  input: OnboardingWorkMatchInput,
  value: unknown,
): OnboardingWorkMatchReply | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const reply = value as Partial<OnboardingWorkMatchReply>;
  if (
    reply.profileVersion !== input.profileVersion ||
    !boundedText(reply.requestId, 160) ||
    !boundedText(reply.runId, 160) ||
    !boundedText(reply.modelId, 160) ||
    !boundedText(reply.summary, 240) ||
    !Array.isArray(reply.selectedAssistantIds) ||
    reply.selectedAssistantIds.length < 1 ||
    reply.selectedAssistantIds.length > 3 ||
    !reply.selectedAssistantIds.every((id) => DEFAULT_STARTERS.includes(id)) ||
    new Set(reply.selectedAssistantIds).size !== reply.selectedAssistantIds.length ||
    !Array.isArray(reply.starters) ||
    reply.starters.length < 1 ||
    reply.starters.length > 3 ||
    !reply.starters.every((entry) => boundedText(entry, 160)) ||
    (reply.usageStatus !== 'settled' && reply.usageStatus !== 'pending')
  )
    return null;
  return {
    profileVersion: input.profileVersion,
    requestId: reply.requestId,
    runId: reply.runId,
    modelId: reply.modelId,
    summary: reply.summary.trim(),
    selectedAssistantIds: [...reply.selectedAssistantIds],
    starters: reply.starters.map((entry) => entry.trim()),
    usageStatus: reply.usageStatus,
  };
}

function storageKey(userId: string): string {
  return `${STORAGE_PREFIX}${userId}`;
}

export function loadOnboardingProfile(
  userId: string,
  storage: OnboardingStorage = window.localStorage,
): NormalizedOnboardingProfile | null {
  try {
    const current = storage.getItem(`${FIRST_RUN_STORAGE_PREFIX}${userId}`);
    const raw = current ?? storage.getItem(storageKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<OnboardingProfile>;
    if (current !== null && parsed.version !== 3) return null;
    if (![1, 2, 3].includes(parsed.version ?? 0) || parsed.userId !== userId || !Array.isArray(parsed.useCases)) {
      return null;
    }
    const useCases = parsed.useCases.filter((value): value is OnboardingUseCaseId =>
      ONBOARDING_USE_CASE_IDS.includes(value as OnboardingUseCaseId),
    );
    const role = ONBOARDING_ROLE_IDS.includes(parsed.role as OnboardingRoleId)
      ? (parsed.role as OnboardingRoleId)
      : 'custom';
    const selectedAssistantIds = Array.isArray(parsed.selectedAssistantIds)
      ? parsed.selectedAssistantIds.filter((value): value is StarterId => DEFAULT_STARTERS.includes(value as StarterId))
      : [];
    const responseDetail: ResponseDetail = ['concise', 'balanced', 'detailed'].includes(parsed.responseDetail as string)
      ? (parsed.responseDetail as ResponseDetail)
      : 'balanced';
    const extra = parsed.version === 3 ? firstRunFields(parsed) : {};
    if (!extra) return null;
    return {
      version: parsed.version === 3 ? 3 : 2,
      userId,
      nickname: typeof parsed.nickname === 'string' ? parsed.nickname : '',
      role,
      customRole: typeof parsed.customRole === 'string' ? parsed.customRole : '',
      useCases,
      customGoal: typeof parsed.customGoal === 'string' ? parsed.customGoal : '',
      selectedAssistantIds,
      responseDetail,
      filePermission: parsed.filePermission === 'task-folder' ? 'task-folder' : 'ask-every-time',
      completedAt: typeof parsed.completedAt === 'string' ? parsed.completedAt : '',
      ...extra,
    };
  } catch {
    return null;
  }
}

export function saveOnboardingProfile(
  profile: OnboardingProfile,
  storage: OnboardingStorage = window.localStorage,
): void {
  const key = profile.version === 3 ? `${FIRST_RUN_STORAGE_PREFIX}${profile.userId}` : storageKey(profile.userId);
  storage.setItem(key, JSON.stringify(profile));
}

export function goalAnalysisVersion(profile: OnboardingProfile): string {
  const normalized = JSON.stringify({
    userId: profile.userId.trim(),
    role: profile.role ?? 'custom',
    customRole: profile.customRole?.trim().replace(/\s+/g, ' ') ?? '',
    useCases: [...profile.useCases].sort(),
    customGoal: profile.customGoal.trim().replace(/\s+/g, ' '),
    selectedAssistantIds: [...(profile.selectedAssistantIds ?? [])].sort(),
  });
  let hash = 2166136261;
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function recommendedStarterIds(profile: OnboardingProfile | null): StarterId[] {
  const selected: StarterId[] = [];
  const useCaseToStarter: Partial<Record<OnboardingUseCaseId, StarterId>> = {
    content: 'content',
    video: 'photography',
    office: 'office',
    ecommerce: 'ecommerce',
    research: 'research',
    family: 'family',
  };

  for (const useCase of profile?.useCases ?? []) {
    const starter = useCaseToStarter[useCase];
    if (starter && !selected.includes(starter)) selected.push(starter);
  }
  for (const starter of DEFAULT_STARTERS) {
    if (!selected.includes(starter)) selected.push(starter);
  }
  return selected.slice(0, 4);
}

const ROLE_RECOMMENDATIONS: Record<OnboardingRoleId, StarterId[]> = {
  owner: ['office', 'research', 'ecommerce'],
  operations: ['ecommerce', 'office', 'content'],
  sales: ['ecommerce', 'content', 'office'],
  support: ['office', 'research', 'family'],
  finance: ['office', 'research'],
  custom: [],
};

const ASSISTANT_REASON: Record<StarterId, string> = {
  content: '内容创作与文案整理',
  photography: '短视频脚本与拍摄剪辑',
  office: '办公提效与数据整理',
  research: '学习研究与资料分析',
  ecommerce: '电商运营、竞品与经营分析',
  family: '生活家庭与日常规划',
};

const GOAL_KEYWORDS: Array<{ pattern: RegExp; id: StarterId }> = [
  { pattern: /短视频|拍摄|剪辑|镜头|口播/, id: 'photography' },
  { pattern: /文案|文章|选题|内容|小红书|公众号/, id: 'content' },
  { pattern: /电商|商品|竞品|经营|店铺|销量|直播/, id: 'ecommerce' },
  { pattern: /表格|报表|会议|总结|办公|文件|数据/, id: 'office' },
  { pattern: /研究|学习|论文|资料|调研|分析/, id: 'research' },
  { pattern: /家庭|旅行|健康|生活|亲子/, id: 'family' },
];

export function recommendAssistants(profile: OnboardingProfile): AssistantRecommendation[] {
  const score = new Map<StarterId, number>(DEFAULT_STARTERS.map((id) => [id, 0]));
  const useCaseToStarter: Partial<Record<OnboardingUseCaseId, StarterId>> = {
    content: 'content',
    video: 'photography',
    office: 'office',
    ecommerce: 'ecommerce',
    research: 'research',
    family: 'family',
  };

  profile.useCases.forEach((useCase, index) => {
    const id = useCaseToStarter[useCase];
    if (id) score.set(id, (score.get(id) ?? 0) + 20 - index);
  });
  ROLE_RECOMMENDATIONS[profile.role ?? 'custom'].forEach((id, index) => {
    score.set(id, (score.get(id) ?? 0) + 6 - index);
  });

  const goal = `${profile.customRole ?? ''} ${profile.customGoal}`.trim();
  for (const item of GOAL_KEYWORDS) {
    if (item.pattern.test(goal)) score.set(item.id, (score.get(item.id) ?? 0) + 8);
  }

  return [...DEFAULT_STARTERS]
    .sort(
      (a, b) => (score.get(b) ?? 0) - (score.get(a) ?? 0) || DEFAULT_STARTERS.indexOf(a) - DEFAULT_STARTERS.indexOf(b),
    )
    .slice(0, 4)
    .map((id) => ({ id, reason: ASSISTANT_REASON[id] }));
}
