import { describe, expect, it } from 'vitest';
import { resolveAppEntryScreen } from '../src/renderer/lib/app-entry-flow';

const readyState = {
  authState: 'ok' as const,
  onboardingResolved: true,
  hasOnboardingAccount: true,
  hasOnboardingProfile: true,
  needsSetup: false,
  ready: true,
};

describe('resolveAppEntryScreen', () => {
  it.each([
    [{ ...readyState, authState: 'checking' as const }, 'loading'],
    [{ ...readyState, authState: 'required' as const }, 'login'],
    [{ ...readyState, onboardingResolved: false }, 'loading'],
    [{ ...readyState, hasOnboardingAccount: false }, 'loading'],
    [{ ...readyState, hasOnboardingProfile: false, needsSetup: true, ready: false }, 'onboarding'],
    [{ ...readyState, needsSetup: true, ready: false }, 'setup'],
    [{ ...readyState, ready: false }, 'loading'],
    [readyState, 'workspace'],
  ] as const)('returns %s for %o', (state, expected) => {
    expect(resolveAppEntryScreen(state)).toBe(expected);
  });
});
