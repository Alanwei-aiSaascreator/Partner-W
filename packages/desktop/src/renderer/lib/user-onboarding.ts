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

export interface OnboardingProfile {
  version: 1;
  userId: string;
  nickname: string;
  useCases: OnboardingUseCaseId[];
  customGoal: string;
  completedAt: string;
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
): OnboardingProfile | null {
  try {
    const raw = storage.getItem(storageKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<OnboardingProfile>;
    if (parsed.version !== 1 || parsed.userId !== userId || !Array.isArray(parsed.useCases)) return null;
    const useCases = parsed.useCases.filter((value): value is OnboardingUseCaseId =>
      ONBOARDING_USE_CASE_IDS.includes(value as OnboardingUseCaseId),
    );
    return {
      version: 1,
      userId,
      nickname: typeof parsed.nickname === 'string' ? parsed.nickname : '',
      useCases,
      customGoal: typeof parsed.customGoal === 'string' ? parsed.customGoal : '',
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
