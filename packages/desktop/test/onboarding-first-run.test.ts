import { describe, expect, it } from 'vitest';
import {
  buildOnboardingWorkMatchInput,
  validateOnboardingWorkMatchReply,
  loadOnboardingProfile,
  saveOnboardingProfile,
  type OnboardingProfile,
  type OnboardingStorage,
} from '../src/renderer/lib/user-onboarding';

function storageFor(value: unknown): OnboardingStorage {
  const values = new Map([['rongying-cube:onboarding:v1:user-1', JSON.stringify(value)]]);
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, content) => {
      values.set(key, content);
    },
  };
}

const firstRunProfile = {
  version: 3,
  userId: 'user-1',
  nickname: 'Test user',
  role: 'finance',
  customRole: 'Hotel finance',
  useCases: ['office'],
  customGoal: 'Prepare monthly reports',
  selectedAssistantIds: ['office'],
  responseDetail: 'balanced',
  filePermission: 'ask-every-time',
  completedAt: '2026-10-03T00:00:00.000Z',
  introduction: 'Prepare hotel budgets',
  industry: { code: 'H', generalConfirmed: false, source: 'user', catalogVersion: 1 },
  questionnaire: { version: 1, answers: ['yes', 'no', null, 'yes'] },
  persona: { id: null, source: 'default', ruleVersion: null },
  workMatch: { source: 'basic', profileVersion: 'profile-version' },
};

describe('first-run profile persistence', () => {
  it('preserves confirmed industry, all four answers and basic result provenance', () => {
    expect(loadOnboardingProfile('user-1', storageFor(firstRunProfile))).toEqual(firstRunProfile);
  });

  it('does not invent an industry or questionnaire for legacy profiles', () => {
    const legacy = { ...firstRunProfile, version: 2 };
    const result = loadOnboardingProfile('user-1', storageFor(legacy));
    expect(result?.version).toBe(2);
    expect(result).not.toHaveProperty('industry');
    expect(result).not.toHaveProperty('questionnaire');
  });

  it('rejects unknown industry codes instead of treating them as confirmed general', () => {
    const malformed = { ...firstRunProfile, industry: { ...firstRunProfile.industry, code: 'Z' } };
    expect(loadOnboardingProfile('user-1', storageFor(malformed))).toBeNull();
  });

  it('rejects malformed answers without silently converting them to no', () => {
    const malformed = { ...firstRunProfile, questionnaire: { version: 1, answers: ['yes', 'false', null, 'no'] } };
    expect(loadOnboardingProfile('user-1', storageFor(malformed))).toBeNull();
  });

  it('requires explicit general selection when no industry code was confirmed', () => {
    const malformed = { ...firstRunProfile, industry: { ...firstRunProfile.industry, code: null } };
    expect(loadOnboardingProfile('user-1', storageFor(malformed))).toBeNull();
  });

  it('never loads another account profile', () => {
    expect(loadOnboardingProfile('user-2', storageFor(firstRunProfile))).toBeNull();
  });

  it('rejects AI provenance without real receipt identifiers', () => {
    const malformed = {
      ...firstRunProfile,
      workMatch: {
        source: 'ai',
        profileVersion: 'p',
        requestId: {},
        runId: 'r',
        modelId: 'm',
        summary: 's',
        starters: ['task'],
        usageStatus: 'pending',
      },
    };
    expect(loadOnboardingProfile('user-1', storageFor(malformed))).toBeNull();
  });

  it('saves the new profile under a separate versioned key without overwriting legacy data', () => {
    const storage = storageFor({ ...firstRunProfile, version: 2 });
    const original = storage.getItem('rongying-cube:onboarding:v1:user-1');
    const normalized = loadOnboardingProfile('user-1', storageFor(firstRunProfile));
    expect(normalized).not.toBeNull();
    saveOnboardingProfile(normalized!, storage);
    expect(storage.getItem('rongying-cube:onboarding:v1:user-1')).toBe(original);
    expect(storage.getItem('rongying-cube:onboarding:v3:user-1')).not.toBeNull();
    expect(loadOnboardingProfile('user-1', storage)?.version).toBe(3);
  });

  it('does not silently revive stale legacy data when a new-version record is invalid', () => {
    const storage = storageFor({ ...firstRunProfile, version: 2 });
    storage.setItem(
      'rongying-cube:onboarding:v3:user-1',
      JSON.stringify({ ...firstRunProfile, userId: 'another-account' }),
    );
    expect(loadOnboardingProfile('user-1', storage)).toBeNull();
  });

  it('round-trips a locked portrait, never injects one, and rejects malformed shapes', () => {
    const portrait = {
      axes: { 外向力: 80, 探索力: 70, 理性力: 80, 条理力: 80, 共情力: 65 },
      letters: 'ESTJ',
      role: 'hengchuan',
      ruleVersion: 'portrait-v1',
      locked: true,
    };
    const withPortrait = { ...firstRunProfile, portrait };
    expect(loadOnboardingProfile('user-1', storageFor(withPortrait))?.portrait).toEqual(portrait);

    // 旧记录没有这个键 ⇒ 读回来也不许多出这个键（不注入默认画像）
    const withoutPortrait = loadOnboardingProfile('user-1', storageFor(firstRunProfile));
    expect(withoutPortrait).not.toBeNull();
    expect(withoutPortrait).not.toHaveProperty('portrait');

    // ⭐ 形状非法 ⇒ **只丢画像**（2026-10-07 体检问题 8：坏一张立绘不该连昵称/岗位/作答
    //    一起作废），而不是编一个默认画像 —— 宁缺毋造。
    for (const malformed of [
      { ...withPortrait, portrait: { ...portrait, letters: 'ZZZZ' } },
      { ...withPortrait, portrait: { ...portrait, role: 'unknown-role' } },
      { ...withPortrait, portrait: { ...portrait, axes: { ...portrait.axes, 外向力: 101 } } },
    ]) {
      const degraded = loadOnboardingProfile('user-1', storageFor(malformed));
      expect(degraded).not.toBeNull();
      expect(degraded).not.toHaveProperty('portrait');
      // 其余字段一个都不许少（整份档案的核心）
      expect(degraded).toMatchObject({
        nickname: 'Test user',
        role: 'finance',
        industry: { code: 'H' },
        questionnaire: { answers: ['yes', 'no', null, 'yes'] },
      });
    }
  });

  it('产业目录版本按 <= 当前 判：老记录照读，高出版本的才拒收（问题 8）', () => {
    const withVersion = (catalogVersion: number) => ({
      ...firstRunProfile,
      industry: { ...firstRunProfile.industry, catalogVersion },
    });

    // 当前版本：照读（并归一成当前版本号）
    expect(loadOnboardingProfile('user-1', storageFor(withVersion(1)))?.industry).toEqual({
      code: 'H',
      generalConfirmed: false,
      source: 'user',
      catalogVersion: 1,
    });
    // 别的版本的应用写的（2 > 当前 1）：看不懂 ⇒ 拒收
    expect(loadOnboardingProfile('user-1', storageFor(withVersion(2)))).toBeNull();
    // 0 / 版本号缺失：不是任何一天写出来的东西 ⇒ 拒收
    expect(loadOnboardingProfile('user-1', storageFor(withVersion(0)))).toBeNull();
    expect(
      loadOnboardingProfile(
        'user-1',
        storageFor({ ...firstRunProfile, industry: { code: 'H', generalConfirmed: false, source: 'user' } }),
      ),
    ).toBeNull();
  });
});

describe('explicit work matching input and result', () => {
  const profile: OnboardingProfile = {
    ...firstRunProfile,
    version: 3,
    role: 'finance',
    useCases: ['office'],
    responseDetail: 'balanced',
    filePermission: 'ask-every-time',
    selectedAssistantIds: ['office'],
    industry: { code: 'H', generalConfirmed: false, source: 'user', catalogVersion: 1 },
    questionnaire: { version: 1, answers: ['yes', 'no', null, 'yes'] },
    persona: { id: null, source: 'default', ruleVersion: null },
    workMatch: { source: 'basic', profileVersion: 'profile-version' },
  };

  it('sends only confirmed work fields, never the nickname or four answers', () => {
    const input = buildOnboardingWorkMatchInput(profile, 'workspace-a');
    expect(input).toEqual({
      userId: 'user-1',
      scopeKey: 'workspace-a',
      profileVersion: expect.any(String),
      industryCode: 'H',
      generalConfirmed: false,
      role: 'finance',
      customRole: 'Hotel finance',
      useCases: ['office'],
      customGoal: 'Prepare monthly reports',
      responseDetail: 'balanced',
    });
    expect(input).not.toHaveProperty('nickname');
    expect(input).not.toHaveProperty('questionnaire');
  });

  it('changes the input version when confirmed industry changes but not answers', () => {
    const input = buildOnboardingWorkMatchInput(profile, 'workspace-a');
    expect(
      buildOnboardingWorkMatchInput(
        { ...profile, industry: { code: 'C', generalConfirmed: false, source: 'user', catalogVersion: 1 } },
        'workspace-a',
      ).profileVersion,
    ).not.toBe(input.profileVersion);
    expect(
      buildOnboardingWorkMatchInput(
        { ...profile, questionnaire: { version: 1, answers: [null, null, null, null] } },
        'workspace-a',
      ).profileVersion,
    ).toBe(input.profileVersion);
    expect(buildOnboardingWorkMatchInput(profile, 'workspace-b').profileVersion).not.toBe(input.profileVersion);
  });

  it('rejects stale input versions and unknown assistants', () => {
    const input = buildOnboardingWorkMatchInput(profile, 'workspace-a');
    const reply = {
      requestId: 'request-1',
      runId: 'run-1',
      modelId: 'actual-model',
      profileVersion: input.profileVersion,
      summary: 'Prepare clear reports',
      selectedAssistantIds: ['office'],
      starters: ['Organize reports'],
      usageStatus: 'settled',
    };
    expect(validateOnboardingWorkMatchReply(input, reply)).toEqual(reply);
    expect(validateOnboardingWorkMatchReply(input, { ...reply, profileVersion: 'old' })).toBeNull();
    expect(
      validateOnboardingWorkMatchReply(input, { ...reply, selectedAssistantIds: ['invented-assistant'] }),
    ).toBeNull();
    expect(validateOnboardingWorkMatchReply(input, { ...reply, usageStatus: 'free' })).toBeNull();
  });
});
