import { describe, expect, it, vi } from 'vitest';
import {
  anonymousAccountFingerprint,
  clearOnboardingDraft,
  goalAnalysisVersion,
  loadOnboardingProfile,
  loadOnboardingProfileResult,
  onboardingDraftScope,
  readOnboardingDraft,
  readStoredPortraitIdentity,
  readStoredPortraitRole,
  recommendAssistants,
  recommendedStarterIds,
  reportOnboardingProfileLoad,
  reportOnboardingProfileSave,
  saveOnboardingDraft,
  saveOnboardingProfile,
  type OnboardingDraft,
  type OnboardingDraftStorage,
  type OnboardingProfile,
  type OnboardingStorage,
  type OnboardingStorageReader,
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

/**
 * 06 头像链的**只读**选择器：本机档案里的六角色 code。
 * 只读、不缓存；坏数据/无档案/存储不可用一律 `null`（头像退回可选图标）。
 */
describe('readStoredPortraitRole', () => {
  function reader(values: Record<string, string>): OnboardingStorageReader {
    const keys = Object.keys(values);
    return {
      length: keys.length,
      key: (index) => keys[index] ?? null,
      getItem: (key) => values[key] ?? null,
    };
  }

  function v3Profile(role: string, account = 'user-1'): string {
    const profile: OnboardingProfile = {
      version: 3,
      userId: account,
      nickname: '',
      useCases: ['content'],
      customGoal: '',
      completedAt: '2026-10-05T00:00:00.000Z',
      industry: { code: 'C', generalConfirmed: false, source: 'user', catalogVersion: 1 },
      // ⚠️ v3 记录要过 `firstRunFields` 的四件套（industry/questionnaire/persona/workMatch），
      //    少一件 `loadOnboardingProfile` 就整份拒收 —— 选择器于是返回 null（假红过一次）。
      questionnaire: { version: 1, answers: [null, null, null, null] },
      persona: { id: null, source: 'default', ruleVersion: null },
      workMatch: { source: 'basic', profileVersion: 'v1' },
      portrait: {
        axes: { 外向力: 60, 探索力: 60, 理性力: 60, 条理力: 60, 共情力: 60 },
        letters: 'ESTJ',
        role: role as NonNullable<OnboardingProfile['portrait']>['role'],
        ruleVersion: 'portrait-v1',
        locked: true,
      },
    };
    return JSON.stringify(profile);
  }

  it('returns the stored portrait role of the requested account', () => {
    expect(
      readStoredPortraitRole('user-1', reader({ 'rongying-cube:onboarding:v3:user-1': v3Profile('hengchuan') })),
    ).toBe('hengchuan');
  });

  it('⭐ 盘上有两个账号时读的是点名那一个，不是"第一份"（2026-10-07 体检问题 5）', () => {
    const storage = reader({
      'rongying-cube:onboarding:v3:user-1': v3Profile('hengchuan', 'user-1'),
      'rongying-cube:onboarding:v3:user-2': v3Profile('baina', 'user-2'),
    });
    expect(readStoredPortraitRole('user-2', storage)).toBe('baina');
    expect(readStoredPortraitRole('user-1', storage)).toBe('hengchuan');
    // 不是这个账号的点名：名下没有档案就是 null，绝不拿别人的顶上
    expect(readStoredPortraitRole('user-3', storage)).toBeNull();
  });

  it('returns null when there is no profile at all', () => {
    expect(readStoredPortraitRole('user-1', reader({}))).toBeNull();
    expect(readStoredPortraitRole('user-1', reader({ 'rongying-cube:onboarding:v1:user-1': '{}' }))).toBeNull();
  });

  it('returns null for a profile whose portrait no longer passes validation', () => {
    expect(
      readStoredPortraitRole('user-1', reader({ 'rongying-cube:onboarding:v3:user-1': v3Profile('nope') })),
    ).toBeNull();
    expect(readStoredPortraitRole('user-1', reader({ 'rongying-cube:onboarding:v3:user-1': 'not json' }))).toBeNull();
  });

  it('never throws when the storage itself fails', () => {
    const broken: OnboardingStorageReader = {
      length: 1,
      key: () => {
        throw new Error('blocked');
      },
      getItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readStoredPortraitRole('user-1', broken)).toBeNull();
    // 没给账号（旧兜底）时扫前缀也不许炸
    expect(readStoredPortraitRole(undefined, broken)).toBeNull();
  });

  it('不带账号时的旧兜底仍然只读、坏数据一律 null（扫描第一份）', () => {
    expect(
      readStoredPortraitRole(undefined, reader({ 'rongying-cube:onboarding:v3:user-1': v3Profile('zhiwei') })),
    ).toBe('zhiwei');
    expect(readStoredPortraitRole(undefined, reader({ 'rongying-cube:onboarding:v3:user-1': 'not json' }))).toBeNull();
  });

  it('readStoredPortraitIdentity：连性别一起读（没填过 = null），与角色同源同口径', () => {
    const withGender = JSON.stringify({
      ...(JSON.parse(v3Profile('hengchuan')) as OnboardingProfile),
      portrait: {
        axes: { 外向力: 60, 探索力: 60, 理性力: 60, 条理力: 60, 共情力: 60 },
        letters: 'ESTJ',
        role: 'hengchuan',
        ruleVersion: 'portrait-v1',
        locked: true,
        gender: 'female',
        age: 33,
      },
    });
    expect(readStoredPortraitIdentity('user-1', reader({ 'rongying-cube:onboarding:v3:user-1': withGender }))).toEqual({
      role: 'hengchuan',
      letters: 'ESTJ',
      gender: 'female',
    });
    // 旧档案（无 gender 键）照读，性别如实为 null —— 头像退回六角色立绘
    expect(
      readStoredPortraitIdentity('user-1', reader({ 'rongying-cube:onboarding:v3:user-1': v3Profile('baina') })),
    ).toEqual({ role: 'baina', letters: 'ESTJ', gender: null });
    // 没有档案 / 坏数据 / 存储炸了：null（与 readStoredPortraitRole 同一出口）
    expect(readStoredPortraitIdentity('user-9', reader({}))).toBeNull();
    expect(
      readStoredPortraitIdentity('user-1', reader({ 'rongying-cube:onboarding:v3:user-1': 'not json' })),
    ).toBeNull();
    expect(
      readStoredPortraitIdentity(undefined, reader({ 'rongying-cube:onboarding:v3:user-1': v3Profile('zhiwei') })),
    ).toEqual({ role: 'zhiwei', letters: 'ESTJ', gender: null });
  });
});

/**
 * 画像形象层补充信息（2026-10-08，16 型形象）：性别/年龄是**可选**键。
 * 判据两条：①旧档案（压根没这两键）照读、不注入默认值；②坏值只丢它自己，不连整份画像作废。
 */
describe('画像形象层补充信息（校验器）', () => {
  function memoryStorage(): OnboardingStorage & { values: Map<string, string> } {
    const values = new Map<string, string>();
    return {
      values,
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => void values.set(key, value),
    };
  }

  function profileWith(portrait: unknown): OnboardingProfile {
    return {
      version: 3,
      userId: 'user-1',
      nickname: '王老板',
      useCases: ['content'],
      customGoal: '',
      completedAt: '2026-10-05T00:00:00.000Z',
      industry: { code: 'C', generalConfirmed: false, source: 'user', catalogVersion: 1 },
      questionnaire: { version: 1, answers: [null, null, null, null] },
      persona: { id: null, source: 'default', ruleVersion: null },
      workMatch: { source: 'basic', profileVersion: 'v1' },
      portrait: portrait as OnboardingProfile['portrait'],
    };
  }

  const basePortrait = {
    axes: { 外向力: 60, 探索力: 60, 理性力: 60, 条理力: 60, 共情力: 60 },
    letters: 'ENFJ',
    role: 'hewei',
    ruleVersion: 'portrait-v1',
    locked: true,
  };

  it('性别/年龄写进档案后原样读回', () => {
    const storage = memoryStorage();
    saveOnboardingProfile(profileWith({ ...basePortrait, gender: 'female', age: 28 }), storage);
    const loaded = loadOnboardingProfile('user-1', storage);
    expect(loaded?.portrait?.gender).toBe('female');
    expect(loaded?.portrait?.age).toBe(28);
  });

  it('旧档案（没有 gender/age 键）照读，且不许注入默认键', () => {
    const storage = memoryStorage();
    saveOnboardingProfile(profileWith({ ...basePortrait }), storage);
    const loaded = loadOnboardingProfile('user-1', storage);
    expect(loaded?.portrait?.role).toBe('hewei');
    expect(loaded?.portrait).not.toHaveProperty('gender');
    expect(loaded?.portrait).not.toHaveProperty('age');
    // 手写的老 JSON（连画像都还没有 gender 概念）同样合法
    storage.values.set(
      'rongying-cube:onboarding:v3:user-1',
      JSON.stringify({ ...profileWith({ ...basePortrait }), portrait: { ...basePortrait } }),
    );
    expect(loadOnboardingProfile('user-1', storage)?.portrait?.letters).toBe('ENFJ');
  });

  it('坏性别 / 坏年龄只丢那一项，不连累画像（昵称、角色、四字码照在）', () => {
    const storage = memoryStorage();
    storage.values.set(
      'rongying-cube:onboarding:v3:user-1',
      JSON.stringify(profileWith({ ...basePortrait, gender: 'woman', age: 999 })),
    );
    const loaded = loadOnboardingProfile('user-1', storage);
    expect(loaded?.nickname).toBe('王老板');
    expect(loaded?.portrait?.role).toBe('hewei');
    expect(loaded?.portrait).not.toHaveProperty('gender');
    expect(loaded?.portrait).not.toHaveProperty('age');

    // 一半好一半坏：好的那半留下
    storage.values.set(
      'rongying-cube:onboarding:v3:user-1',
      JSON.stringify(profileWith({ ...basePortrait, gender: 'male', age: -3 })),
    );
    const half = loadOnboardingProfile('user-1', storage);
    expect(half?.portrait?.gender).toBe('male');
    expect(half?.portrait).not.toHaveProperty('age');
  });
});

describe('首跑草稿（问题 7）', () => {
  function draftStorage(): OnboardingDraftStorage & { values: Map<string, string> } {
    const values = new Map<string, string>();
    return {
      values,
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => void values.set(key, value),
      removeItem: (key) => void values.delete(key),
    };
  }

  const draft: OnboardingDraft = {
    version: 1,
    page: 'portrait',
    nickname: '填到一半',
    introduction: '做小家电的',
    industry: { code: 'C', generalConfirmed: false, source: 'user', catalogVersion: 1 },
    role: 'operations',
    customRole: '运营',
    useCases: ['content', 'video'],
    customGoal: '每周三条视频',
    answers: ['yes', 'no', null, 'yes'],
    questionIndex: 2,
    portraitDone: false,
    portraitTouched: true,
    selectedAssistantIds: ['content', 'office'],
    match: { source: 'basic', profileVersion: 'abc' },
  };

  it('⭐ 存进去再读回来是同一份（按 userId:scopeKey 分键）', () => {
    const storage = draftStorage();
    const scope = onboardingDraftScope('user-1', 'workspace-a');
    saveOnboardingDraft(scope, draft, storage);

    expect(readOnboardingDraft(scope, storage)).toEqual(draft);
    expect(readOnboardingDraft(onboardingDraftScope('user-1', 'workspace-b'), storage)).toBeNull();
    expect(readOnboardingDraft(onboardingDraftScope('user-2', 'workspace-a'), storage)).toBeNull();
  });

  it('清掉之后读不到（确认完成后不再"复活"上一轮输入）', () => {
    const storage = draftStorage();
    saveOnboardingDraft('user-1:account-local', draft, storage);
    clearOnboardingDraft('user-1:account-local', storage);
    expect(readOnboardingDraft('user-1:account-local', storage)).toBeNull();
  });

  it('没存过 / 坏 JSON / 版本不对 ⇒ null（向导从默认值起步）', () => {
    const storage = draftStorage();
    expect(readOnboardingDraft('user-1:account-local', storage)).toBeNull();

    storage.setItem('rongying-cube:onboarding-draft:v1:user-1:account-local', 'not json');
    expect(readOnboardingDraft('user-1:account-local', storage)).toBeNull();

    storage.setItem('rongying-cube:onboarding-draft:v1:user-1:account-local', JSON.stringify({ ...draft, version: 2 }));
    expect(readOnboardingDraft('user-1:account-local', storage)).toBeNull();
  });

  it('逐字段消毒：陌生枚举回默认、坏行业/坏回执丢掉，不许把坏数据带进向导', () => {
    const storage = draftStorage();
    storage.setItem(
      'rongying-cube:onboarding-draft:v1:user-1:account-local',
      JSON.stringify({
        ...draft,
        page: 'matching',
        role: 'not-a-role',
        useCases: ['content', 'not-a-usecase'],
        answers: ['yes', 'no'],
        questionIndex: 99,
        selectedAssistantIds: ['office', 'not-a-starter'],
        industry: { code: 'Z', generalConfirmed: false, source: 'user', catalogVersion: 1 },
        match: { source: 'ai', profileVersion: 'x' },
      }),
    );

    const restored = readOnboardingDraft('user-1:account-local', storage);
    expect(restored).toMatchObject({
      page: 'profile',
      role: 'custom',
      useCases: ['content'],
      answers: [null, null, null, null],
      questionIndex: 0,
      selectedAssistantIds: ['office'],
      industry: null,
      match: null,
    });
  });

  it('形象层补充信息也进草稿：刷新后不用重选性别/年龄；没填就不占键', () => {
    const storage = draftStorage();
    const scope = 'user-1:account-local';
    saveOnboardingDraft(scope, { ...draft, gender: 'female', age: 28 }, storage);
    expect(readOnboardingDraft(scope, storage)).toMatchObject({ gender: 'female', age: 28 });

    saveOnboardingDraft(scope, draft, storage);
    const bare = readOnboardingDraft(scope, storage);
    expect(bare).not.toHaveProperty('gender');
    expect(bare).not.toHaveProperty('age');

    // 坏值当没填（不清空草稿、不抛）
    storage.setItem(
      'rongying-cube:onboarding-draft:v1:user-1:account-local',
      JSON.stringify({ ...draft, gender: 'woman', age: 999 }),
    );
    expect(readOnboardingDraft(scope, storage)).not.toHaveProperty('gender');
    expect(readOnboardingDraft(scope, storage)).not.toHaveProperty('age');
  });

  it('存储本身炸了也不许把首跑带崩', () => {
    const broken: OnboardingDraftStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readOnboardingDraft('user-1:account-local', broken)).toBeNull();
    expect(() => saveOnboardingDraft('user-1:account-local', draft, broken)).not.toThrow();
    expect(() => clearOnboardingDraft('user-1:account-local', broken)).not.toThrow();
  });
});

describe('saveOnboardingProfile 的存储键纪律', () => {
  function memoryStorage(): OnboardingStorage & { values: Map<string, string> } {
    const values = new Map<string, string>();
    return {
      values,
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => void values.set(key, value),
      removeItem: (key) => void values.delete(key),
    };
  }

  const v3: OnboardingProfile = {
    version: 3,
    userId: 'user-1',
    nickname: '',
    useCases: ['content'],
    customGoal: '',
    completedAt: '2026-10-07T00:00:00.000Z',
    industry: { code: 'C', generalConfirmed: false, source: 'user', catalogVersion: 1 },
  };

  it('⭐ 写 v3 时把同账号的 v1 老键清掉（2026-10-07 体检问题 12d）', () => {
    const storage = memoryStorage();
    storage.setItem('rongying-cube:onboarding:v1:user-1', '{"version":1}');
    saveOnboardingProfile(v3, storage);

    expect(storage.values.has('rongying-cube:onboarding:v3:user-1')).toBe(true);
    expect(storage.values.has('rongying-cube:onboarding:v1:user-1')).toBe(false);
  });

  it('别的账号的老键一个都不许碰', () => {
    const storage = memoryStorage();
    storage.setItem('rongying-cube:onboarding:v1:user-2', '{"version":1}');
    saveOnboardingProfile(v3, storage);
    expect(storage.values.get('rongying-cube:onboarding:v1:user-2')).toBe('{"version":1}');
  });

  it('假存储没有 removeItem 时照常保存（不炸）', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (k: string) => values.get(k) ?? null,
      setItem: (k: string, v: string) => void values.set(k, v),
    };
    saveOnboardingProfile(v3, storage);
    expect(values.has('rongying-cube:onboarding:v3:user-1')).toBe(true);
  });
});

/**
 * BUG-034：问卷"重问"先分因。加载结果必须把 missing / parse-invalid / schema-invalid /
 * owner-mismatch / storage-error 分开 —— 否则"读不到"这五个字会掩盖完全不同的现场。
 */
describe('画像加载诊断（BUG-034）', () => {
  function disk(): OnboardingStorage & { values: Map<string, string> } {
    const values = new Map<string, string>();
    return {
      values,
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => void values.set(key, value),
      removeItem: (key) => void values.delete(key),
    };
  }

  /** 一份合法 v3 记录（首跑四件套齐全）。 */
  const v3Record = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    version: 3,
    userId: 'user-1',
    nickname: '王老板',
    introduction: '做小家电的',
    role: 'sales',
    customRole: '',
    useCases: ['content', 'office'],
    customGoal: '每周三条短视频',
    selectedAssistantIds: ['content', 'office'],
    responseDetail: 'balanced',
    filePermission: 'ask-every-time',
    completedAt: '2026-10-06T11:49:12.975Z',
    industry: { code: null, generalConfirmed: true, source: 'user', catalogVersion: 1 },
    questionnaire: { version: 1, answers: ['yes', 'yes', 'no', 'yes'] },
    persona: { id: null, source: 'default', ruleVersion: null },
    workMatch: { source: 'basic', profileVersion: '1m5g94p' },
    ...overrides,
  });

  const V3_KEY = 'rongying-cube:onboarding:v3:user-1';
  const V1_KEY = 'rongying-cube:onboarding:v1:user-1';

  it('合法 v3 重开（同一个盘、换成一份新的存储视图）⇒ ok，且旧入口拿到同一份档案', () => {
    const first = disk();
    saveOnboardingProfile(v3Record() as unknown as OnboardingProfile, first);
    // "正常退出、重开"在最底层就是：同一批字节上再建一份存储视图。
    const reopened = disk();
    reopened.values.set(V3_KEY, first.values.get(V3_KEY)!);

    const result = loadOnboardingProfileResult('user-1', reopened);
    expect(result.reason).toBe('ok');
    expect(result.profile).not.toBeNull();
    expect(result.profile).toEqual(loadOnboardingProfile('user-1', reopened));
    // App 的入口判定吃的是"profile 非空" ⇒ 合法档案绝不会因为重开变成首次注册。
    expect(Boolean(result.profile)).toBe(true);
  });

  it('没有记录 ⇒ missing（keyKind 为 null）；空串记录同样按 missing 收口', () => {
    const storage = disk();
    expect(loadOnboardingProfileResult('user-1', storage)).toMatchObject({
      reason: 'missing',
      profile: null,
      diagnostic: { keyKind: null, recordVersion: null, sections: [] },
    });
    storage.values.set(V3_KEY, '');
    expect(loadOnboardingProfileResult('user-1', storage)).toMatchObject({
      reason: 'missing',
      diagnostic: { keyKind: 'v3' },
    });
  });

  it('坏 JSON ⇒ parse-invalid；缺字段 ⇒ schema-invalid（两个原因不同，且段名可读）', () => {
    const storage = disk();
    storage.values.set(V3_KEY, '{"version":3,"userId":"user-1"');
    const truncated = loadOnboardingProfileResult('user-1', storage);
    expect(truncated.reason).toBe('parse-invalid');
    expect(truncated.diagnostic).toMatchObject({ keyKind: 'v3', recordVersion: null, sections: [] });

    storage.values.set(V3_KEY, JSON.stringify(v3Record({ persona: undefined })));
    const missingSection = loadOnboardingProfileResult('user-1', storage);
    expect(missingSection.reason).toBe('schema-invalid');
    expect(missingSection.profile).toBeNull();
    expect(missingSection.diagnostic.recordVersion).toBe(3);
    expect(missingSection.diagnostic.sections).toEqual(['persona']);
  });

  it('多段同时坏 ⇒ 全部段名都报出来（industry + workMatch）', () => {
    const storage = disk();
    storage.values.set(
      V3_KEY,
      JSON.stringify(v3Record({ industry: { code: 'Z' }, workMatch: { source: 'ai', profileVersion: 'p' } })),
    );
    const result = loadOnboardingProfileResult('user-1', storage);
    expect(result.reason).toBe('schema-invalid');
    expect(result.diagnostic.sections).toEqual(['industry', 'workMatch']);
  });

  it('版本不认识 / v3 键里塞了旧版本 ⇒ schema-invalid(version)，不按老键回读', () => {
    const storage = disk();
    storage.values.set(V3_KEY, JSON.stringify({ ...v3Record(), version: 2 }));
    expect(loadOnboardingProfileResult('user-1', storage)).toMatchObject({
      reason: 'schema-invalid',
      diagnostic: { keyKind: 'v3', recordVersion: 2, sections: ['version'] },
    });

    storage.values.delete(V3_KEY);
    storage.values.set(V1_KEY, JSON.stringify({ ...v3Record(), version: 9 }));
    expect(loadOnboardingProfileResult('user-1', storage)).toMatchObject({
      reason: 'schema-invalid',
      diagnostic: { keyKind: 'legacy', recordVersion: 9, sections: ['version'] },
    });
  });

  it('记录属于别的账号 ⇒ owner-mismatch：不拒自家人、也绝不回借（v3 与新老键各验一次）', () => {
    const storage = disk();
    storage.values.set(V3_KEY, JSON.stringify(v3Record({ userId: 'another-account' })));
    const mismatch = loadOnboardingProfileResult('user-1', storage);
    expect(mismatch.reason).toBe('owner-mismatch');
    expect(mismatch.profile).toBeNull();
    expect(mismatch.diagnostic).toMatchObject({ keyKind: 'v3', recordVersion: 3 });

    storage.values.delete(V3_KEY);
    storage.values.set(V1_KEY, JSON.stringify({ ...v3Record(), version: 1, userId: 'another-account' }));
    expect(loadOnboardingProfileResult('user-1', storage).reason).toBe('owner-mismatch');
  });

  it('存储读取抛错 ⇒ storage-error（不是 missing），且旧入口不炸', () => {
    const broken = {
      getItem: (): string | null => {
        throw new DOMException('Storage disabled', 'SecurityError');
      },
    };
    expect(loadOnboardingProfileResult('user-1', broken)).toMatchObject({
      reason: 'storage-error',
      profile: null,
      diagnostic: { keyKind: null },
    });
    expect(loadOnboardingProfile('user-1', broken)).toBeNull();
  });

  it('连 window 都没有（node 环境未注入存储）⇒ storage-error，而不是抛', () => {
    expect(loadOnboardingProfileResult('user-1')).toMatchObject({ reason: 'storage-error', profile: null });
  });

  it('旧 v1 档案按既定迁移保留：ok + version 2 + 字段不丢；v2 原样照读', () => {
    const storage = disk();
    storage.values.set(
      V1_KEY,
      JSON.stringify({
        version: 1,
        userId: 'user-1',
        nickname: '旧用户',
        useCases: ['content'],
        customGoal: '每周写三篇文章',
        completedAt: '2026-09-14T00:00:00.000Z',
      }),
    );
    const migrated = loadOnboardingProfileResult('user-1', storage);
    expect(migrated.reason).toBe('ok');
    expect(migrated.diagnostic).toMatchObject({ keyKind: 'legacy', recordVersion: 1 });
    expect(migrated.profile).toEqual({
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

  it('结果与旧入口逐例恒等（兼容包装不许走样）', () => {
    const cases: Array<[string, string, string]> = [
      ['合法 v3', V3_KEY, JSON.stringify(v3Record())],
      ['v3 键里写旧版本（版本错位）', V3_KEY, JSON.stringify({ ...v3Record(), version: 2 })],
      ['老键里的合法 v2（无首跑字段）', V1_KEY, JSON.stringify({ ...v3Record(), version: 2 })],
      ['坏 JSON', V3_KEY, 'not json'],
      ['缺 persona', V3_KEY, JSON.stringify(v3Record({ persona: undefined }))],
      ['别的账号', V3_KEY, JSON.stringify(v3Record({ userId: 'user-2' }))],
      ['空串', V3_KEY, ''],
    ];
    for (const [label, key, raw] of cases) {
      const storage = disk();
      storage.values.set(key, raw);
      expect(loadOnboardingProfileResult('user-1', storage).profile, label).toEqual(
        loadOnboardingProfile('user-1', storage),
      );
    }
  });

  it('匿名指纹：同账号稳定、不同账号不同、不落明文', () => {
    const fingerprint = anonymousAccountFingerprint('66435693-c7de-4359-b141-fa6df7d78d66');
    expect(fingerprint).toBe(anonymousAccountFingerprint('66435693-c7de-4359-b141-fa6df7d78d66'));
    expect(fingerprint).not.toBe(anonymousAccountFingerprint('local'));
    expect(fingerprint).toMatch(/^acc-[0-9a-f]{8}$/);
    expect(fingerprint).not.toContain('66435693');
  });

  it('加载记录只报原因/schema/指纹，不含画像内容；出口缺失或抛错都不崩', () => {
    const storage = disk();
    storage.values.set(V3_KEY, JSON.stringify(v3Record({ persona: undefined })));
    const result = loadOnboardingProfileResult('user-1', storage);
    type ReportEvent = { domain: string; event: string; data?: Record<string, unknown> };
    const sink = vi.fn<(event: ReportEvent) => void>();
    expect(reportOnboardingProfileLoad(result, 'user-1', { source: 'entry', report: sink })).toBe(true);
    expect(sink).toHaveBeenCalledTimes(1);
    const event = sink.mock.calls[0]![0];
    expect(event.domain).toBe('renderer');
    expect(event.event).toBe('onboarding.profile.load');
    expect(event.data).toMatchObject({
      reason: 'schema-invalid',
      keyKind: 'v3',
      recordVersion: 3,
      sections: ['persona'],
      source: 'entry',
      account: anonymousAccountFingerprint('user-1'),
    });
    const serialized = JSON.stringify(event);
    for (const leak of ['王老板', '小家电', '每周三条短视频', 'user-1']) expect(serialized).not.toContain(leak);

    // 出口抛错：不许把入口带崩，如实返回 false
    expect(
      reportOnboardingProfileLoad(result, 'user-1', {
        report: () => {
          throw new Error('bridge closed');
        },
      }),
    ).toBe(false);
    // node 环境没有桥：静默跳过
    expect(reportOnboardingProfileLoad(result, 'user-1')).toBe(false);
  });

  it('诊断入口传了 diagnostics 才上报：不传是纯读取，不碰出口', () => {
    type ReportEvent = { domain: string; event: string; data?: Record<string, unknown> };
    const storage = disk();
    storage.values.set(V3_KEY, JSON.stringify(v3Record()));
    const sink = vi.fn<(event: ReportEvent) => void>();
    const silent = loadOnboardingProfileResult('user-1', storage);
    expect(silent.reason).toBe('ok');
    expect(sink).not.toHaveBeenCalled();
    expect(loadOnboardingProfileResult('user-1', storage, { source: 'entry', report: sink }).reason).toBe('ok');
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0]![0].data).toMatchObject({ reason: 'ok', keyKind: 'v3', source: 'entry' });
  });

  it('保存记录（对账另一半）：成功报 keyKind，失败只报异常名', () => {
    type ReportEvent = { domain: string; event: string; data?: Record<string, unknown> };
    const okSink = vi.fn<(event: ReportEvent) => void>();
    expect(reportOnboardingProfileSave({ ok: true, keyKind: 'v3' }, 'user-1', { report: okSink })).toBe(true);
    expect(okSink.mock.calls[0]![0]).toMatchObject({
      event: 'onboarding.profile.save',
      data: { ok: true, keyKind: 'v3', account: anonymousAccountFingerprint('user-1') },
    });
    const failSink = vi.fn<(event: ReportEvent) => void>();
    reportOnboardingProfileSave({ ok: false, errorKind: 'QuotaExceededError' }, 'user-1', { report: failSink });
    expect(failSink.mock.calls[0]![0]).toMatchObject({
      data: { ok: false, errorKind: 'QuotaExceededError' },
    });
  });
});

/**
 * setItem 抛错 **不得**被吞成"保存成功"（App 的完成回调依赖这次抛出留住编辑页）。
 * 这是既有行为的直接钉板：失败向上抛，且 v1 老键清理不许半途执行；带 diagnostics 时
 * 失败也要留痕（但绝不影响抛出）。
 */
describe('保存失败必须向上抛（不许吞）', () => {
  const profile: OnboardingProfile = {
    version: 3,
    userId: 'user-1',
    nickname: '',
    useCases: ['content'],
    customGoal: '',
    completedAt: '2026-10-07T00:00:00.000Z',
    industry: { code: 'C', generalConfirmed: false, source: 'user', catalogVersion: 1 },
  };

  it('setItem 抛错 ⇒ saveOnboardingProfile 抛出，removeItem 清理不执行', () => {
    const removeItem = vi.fn();
    const storage: OnboardingStorage = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('Storage unavailable', 'QuotaExceededError');
      },
      removeItem,
    };
    expect(() => saveOnboardingProfile(profile, storage)).toThrow('Storage unavailable');
    expect(removeItem).not.toHaveBeenCalled();
  });

  it('带 diagnostics 时：成功报回执；失败留痕后仍然抛出（不许吞）', () => {
    type ReportEvent = { domain: string; event: string; data?: Record<string, unknown> };
    const okSink = vi.fn<(event: ReportEvent) => void>();
    const okStorage = {
      getItem: () => null,
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };
    saveOnboardingProfile(profile, okStorage, { source: 'entry-complete', report: okSink });
    expect(okStorage.setItem).toHaveBeenCalledTimes(1);
    expect(okSink.mock.calls[0]![0]).toMatchObject({
      event: 'onboarding.profile.save',
      data: { ok: true, keyKind: 'v3', source: 'entry-complete' },
    });

    const failSink = vi.fn<(event: ReportEvent) => void>();
    const failing: OnboardingStorage = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('Storage unavailable', 'QuotaExceededError');
      },
      removeItem: vi.fn(),
    };
    expect(() => saveOnboardingProfile(profile, failing, { report: failSink })).toThrow('Storage unavailable');
    expect(failSink.mock.calls[0]![0]).toMatchObject({
      data: { ok: false, errorKind: 'QuotaExceededError' },
    });
  });
});
