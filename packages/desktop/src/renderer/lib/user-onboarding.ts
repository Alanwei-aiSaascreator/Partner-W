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

export interface OnboardingProfile {
  version: 1 | 2;
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
}

export interface NormalizedOnboardingProfile extends OnboardingProfile {
  version: 2;
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
const DEFAULT_STARTERS: StarterId[] = ['content', 'office', 'photography', 'research', 'ecommerce', 'family'];

function storageKey(userId: string): string {
  return `${STORAGE_PREFIX}${userId}`;
}

export function loadOnboardingProfile(
  userId: string,
  storage: OnboardingStorage = window.localStorage,
): NormalizedOnboardingProfile | null {
  try {
    const raw = storage.getItem(storageKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<OnboardingProfile>;
    if ((parsed.version !== 1 && parsed.version !== 2) || parsed.userId !== userId || !Array.isArray(parsed.useCases)) {
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
    return {
      version: 2,
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
    };
  } catch {
    return null;
  }
}

export function saveOnboardingProfile(
  profile: OnboardingProfile,
  storage: OnboardingStorage = window.localStorage,
): void {
  storage.setItem(storageKey(profile.userId), JSON.stringify(profile));
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
