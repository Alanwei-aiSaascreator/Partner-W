import { describe, expect, it } from 'vitest';
import {
  goalAnalysisVersion,
  loadOnboardingProfile,
  recommendAssistants,
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
      version: 2,
      userId: 'user-1',
      nickname: '小荣',
      role: 'operations',
      customRole: '',
      useCases: ['video', 'content'],
      customGoal: '每周完成三条产品短视频',
      selectedAssistantIds: ['content', 'photography'],
      responseDetail: 'balanced',
      filePermission: 'ask-every-time',
      completedAt: '2026-09-14T00:00:00.000Z',
    };

    saveOnboardingProfile(profile, storage);

    expect(loadOnboardingProfile('user-1', storage)).toEqual(profile);
    expect(loadOnboardingProfile('user-2', storage)).toBeNull();
  });

  it('migrates a stored v1 profile to safe v2 defaults without losing goals', () => {
    const storage = memoryStorage();
    storage.setItem(
      'rongying-cube:onboarding:v1:user-1',
      JSON.stringify({
        version: 1,
        userId: 'user-1',
        nickname: '旧用户',
        useCases: ['content'],
        customGoal: '每周写三篇文章',
        completedAt: '2026-09-14T00:00:00.000Z',
      }),
    );

    expect(loadOnboardingProfile('user-1', storage)).toEqual({
      version: 2,
      userId: 'user-1',
      nickname: '旧用户',
      role: 'custom',
      customRole: '',
      useCases: ['content'],
      customGoal: '每周写三篇文章',
      selectedAssistantIds: [],
      responseDetail: 'balanced',
      filePermission: 'ask-every-time',
      completedAt: '2026-09-14T00:00:00.000Z',
    });
  });

  it('orders homepage starters by the selected use cases and fills the remaining slots', () => {
    const profile: OnboardingProfile = {
      version: 2,
      userId: 'user-1',
      nickname: '',
      role: 'sales',
      customRole: '',
      useCases: ['video', 'ecommerce'],
      customGoal: '',
      selectedAssistantIds: [],
      responseDetail: 'balanced',
      filePermission: 'ask-every-time',
      completedAt: '2026-09-14T00:00:00.000Z',
    };

    expect(recommendedStarterIds(profile)).toEqual(['photography', 'ecommerce', 'content', 'office']);
  });

  it('generates the same analysis version for equivalent normalized goals', () => {
    const base: OnboardingProfile = {
      version: 2,
      userId: 'user-1',
      nickname: '',
      role: 'operations',
      customRole: '',
      useCases: ['content', 'video'],
      customGoal: '每周完成三条短视频',
      selectedAssistantIds: ['content', 'photography'],
      responseDetail: 'balanced',
      filePermission: 'ask-every-time',
      completedAt: '2026-09-14T00:00:00.000Z',
    };

    expect(goalAnalysisVersion(base)).toBe(
      goalAnalysisVersion({
        ...base,
        useCases: ['video', 'content'],
        customGoal: '  每周完成三条短视频  ',
        completedAt: '2026-09-15T00:00:00.000Z',
      }),
    );
    expect(goalAnalysisVersion({ ...base, customGoal: '每周完成五条短视频' })).not.toBe(goalAnalysisVersion(base));
  });

  it('explains role and goal based assistant recommendations', () => {
    const profile: OnboardingProfile = {
      version: 2,
      userId: 'user-1',
      nickname: '',
      role: 'operations',
      customRole: '',
      useCases: ['ecommerce', 'office'],
      customGoal: '分析竞品并整理本周经营数据',
      selectedAssistantIds: [],
      responseDetail: 'balanced',
      filePermission: 'ask-every-time',
      completedAt: '2026-09-14T00:00:00.000Z',
    };

    const recommendations = recommendAssistants(profile);
    expect(recommendations.slice(0, 2).map((item) => item.id)).toEqual(['ecommerce', 'office']);
    expect(recommendations[0]?.reason).toContain('电商');
  });
});
