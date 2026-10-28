import type { OnboardingUseCaseId } from '@/lib/user-onboarding';

export const LOGIN_PURPOSE_STORAGE_KEY = 'partner-w-login-purpose';

export const LOGIN_PURPOSE_IDS = ['content', 'office', 'ecommerce', 'research'] as const;
export type LoginPurpose = (typeof LOGIN_PURPOSE_IDS)[number];

type ReadableStorage = Pick<Storage, 'getItem'>;

export function readLoginPurpose(storage: ReadableStorage = window.localStorage): LoginPurpose | null {
  const stored = storage.getItem(LOGIN_PURPOSE_STORAGE_KEY);
  return LOGIN_PURPOSE_IDS.includes(stored as LoginPurpose) ? (stored as LoginPurpose) : null;
}

export function resolveLoginPurposeUseCase(purpose: LoginPurpose): OnboardingUseCaseId {
  return purpose;
}
