import { describe, expect, it } from 'vitest';
import {
  loadOnboardingProfile,
  recommendedStarterIds,
  saveOnboardingProfile,
  type OnboardingProfile,
  type OnboardingStorage,
} from '../src/renderer/lib/user-onboarding';

function memoryStorage(): OnboardingStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

describe('user onboarding profile', () => {
  it('stores multiple use cases and a custom goal per account', () => {
    const storage = memoryStorage();
    const profile: OnboardingProfile = {
      version: 1,
      userId: 'user-1',
      nickname: '小荣',
      useCases: ['video', 'content'],
      customGoal: '每周完成三条产品短视频',
      completedAt: '2026-09-14T00:00:00.000Z',
    };

    saveOnboardingProfile(profile, storage);

    expect(loadOnboardingProfile('user-1', storage)).toEqual(profile);
    expect(loadOnboardingProfile('user-2', storage)).toBeNull();
  });

  it('orders homepage starters by the selected use cases and fills the remaining slots', () => {
    const profile: OnboardingProfile = {
      version: 1,
      userId: 'user-1',
      nickname: '',
      useCases: ['video', 'ecommerce'],
      customGoal: '',
      completedAt: '2026-09-14T00:00:00.000Z',
    };

    expect(recommendedStarterIds(profile)).toEqual(['photography', 'ecommerce', 'content', 'office']);
  });
});
