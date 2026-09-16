export type AppEntryScreen = 'loading' | 'login' | 'onboarding' | 'setup' | 'workspace';

export interface AppEntryState {
  authState: 'checking' | 'required' | 'ok';
  onboardingResolved: boolean;
  hasOnboardingAccount: boolean;
  hasOnboardingProfile: boolean;
  needsSetup: boolean;
  ready: boolean;
}

export function resolveAppEntryScreen(state: AppEntryState): AppEntryScreen {
  if (state.authState === 'checking') return 'loading';
  if (state.authState === 'required') return 'login';
  if (!state.onboardingResolved || !state.hasOnboardingAccount) return 'loading';
  if (!state.hasOnboardingProfile) return 'onboarding';
  if (state.needsSetup) return 'setup';
  if (!state.ready) return 'loading';
  return 'workspace';
}
