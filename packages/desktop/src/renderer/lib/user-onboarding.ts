import {
  PORTRAIT_AXES,
  PORTRAIT_ROLE_CODES,
  isPortraitGender,
  parsePortraitAge,
  type OnboardingPortrait,
  type PortraitAxis,
  type PortraitGender,
  type PortraitRoleCode,
} from './user-portrait';

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

/**
 * 产业目录版本（`OnboardingIndustry.catalogVersion` 的当前值）。
 *
 * ⚠️ 判据是 **`<= 本常量`**（2026-10-07 体检问题 8）：以前是 `!== 1` —— 目录升到 2 的那一刻，
 *    全部存量档案（写着 1）会被判成非法、**整份拒收**（昵称/岗位/画像全丢、重跑首跑）。
 *    老记录必须照读（它按写入时的目录语义解释）；只有**高于本版本**的记录
 *    （别的版本的应用写的、我们看不懂）才拒收。
 */
export const INDUSTRY_CATALOG_VERSION = 1;
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
  /**
   * 3a 趣味画像（可选）。**旧记录没有这个键就是合法的**（`loadOnboardingProfile` 不注入默认值，
   * 见 `firstRunFields`）；写入只在用户真的答过题、且四题不全跳过时发生（不生成虚构分数）。
   */
  portrait?: OnboardingPortrait;
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
  /**
   * 可选：保存 v3 时把同账号的 v1 老键清掉（见 `saveOnboardingProfile`）。
   * 老的单测假存储可以没有它 —— 缺了就跳过清理，不影响保存。
   */
  removeItem?: (key: string) => void;
}

/**
 * 只读存储视图（06 头像链的选择器用）。`window.localStorage` 结构上就满足它，
 * 单测也可以塞一个只实现这三样的假货 —— 有意**不含 `setItem`**：读选择器不许写。
 */
export interface OnboardingStorageReader {
  readonly length: number;
  key: (index: number) => string | null;
  getItem: (key: string) => string | null;
}

const STORAGE_PREFIX = 'rongying-cube:onboarding:v1:';
const FIRST_RUN_STORAGE_PREFIX = 'rongying-cube:onboarding:v3:';
const DEFAULT_STARTERS: StarterId[] = ['content', 'office', 'photography', 'research', 'ecommerce', 'family'];

function boundedText(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= limit;
}

/** 趣味四字码：E/I、S/N、T/F、J/P 各取一位；跳过的那位是 X。 */
const PORTRAIT_LETTERS_RE = /^[EISTNFJPX]{4}$/;

/**
 * 解析并校验固化画像。
 * 返回 `undefined` = 记录里没有这个键（**合法**：旧记录兼容，且不注入默认值）；
 * `null` = 有但形状非法 ⇒ 整份 profile 拒收（与 industry / questionnaire / persona 同一风格）。
 *
 * ⚠️ 只校验**形状**、不重算分数：规则可能已换代，旧数据按它自己的 `ruleVersion` 解释，
 *    换规则不清洗旧记录（施工图 §8 风险 3）。
 */
function parsePortrait(value: unknown): OnboardingPortrait | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const portrait = value as Partial<OnboardingPortrait>;
  if (typeof portrait.letters !== 'string' || !PORTRAIT_LETTERS_RE.test(portrait.letters)) return null;
  if (!PORTRAIT_ROLE_CODES.includes(portrait.role as (typeof PORTRAIT_ROLE_CODES)[number])) return null;
  if (!boundedText(portrait.ruleVersion, 40)) return null;
  if (typeof portrait.locked !== 'boolean') return null;
  const axes = portrait.axes as Partial<Record<PortraitAxis, unknown>> | undefined;
  if (typeof axes !== 'object' || axes === null || Array.isArray(axes)) return null;
  const scores = {} as Record<PortraitAxis, number>;
  for (const axis of PORTRAIT_AXES) {
    const score = axes[axis];
    if (typeof score !== 'number' || !Number.isInteger(score) || score < 0 || score > 100) return null;
    scores[axis] = score;
  }
  /**
   * 形象层补充信息（2026-10-08）：**只认形状**——旧档案没有这两键照读；值坏了/越界也只丢
   * 那一项，不连整份画像一起作废（画像 = 形象层，丢一份头像就够了）。不加键时**不许注入
   * `undefined`**（既有 `toEqual` 测试盯着画像对象，键的顺序/有无都算数）。
   */
  const gender = isPortraitGender(portrait.gender) ? portrait.gender : undefined;
  const age = parsePortraitAge(portrait.age);
  return {
    axes: scores,
    letters: portrait.letters,
    role: portrait.role as (typeof PORTRAIT_ROLE_CODES)[number],
    ruleVersion: portrait.ruleVersion,
    locked: portrait.locked,
    ...(gender ? { gender } : {}),
    ...(age !== null ? { age } : {}),
  };
}

/** 产业选择的形状校验（v3 档案与首跑草稿共用）：非法返回 `null`。 */
function parseIndustry(value: unknown): OnboardingIndustry | null {
  if (!value || typeof value !== 'object') return null;
  const industry = value as Partial<OnboardingIndustry>;
  // 版本语义是 `<= 当前`（见 `INDUSTRY_CATALOG_VERSION`）：老记录照读，高出版本才拒。
  if (
    industry.source !== 'user' ||
    typeof industry.catalogVersion !== 'number' ||
    industry.catalogVersion < 1 ||
    industry.catalogVersion > INDUSTRY_CATALOG_VERSION ||
    (industry.code !== null &&
      industry.code !== undefined &&
      !ONBOARDING_INDUSTRY_CODES.includes(industry.code as (typeof ONBOARDING_INDUSTRY_CODES)[number])) ||
    (industry.code === null || industry.code === undefined
      ? industry.generalConfirmed !== true
      : industry.generalConfirmed !== false)
  )
    return null;
  return {
    code: (industry.code ?? null) as OnboardingIndustryCode | null,
    generalConfirmed: industry.generalConfirmed === true,
    source: 'user',
    catalogVersion: INDUSTRY_CATALOG_VERSION,
  };
}

/** v3 四件套的形状判据（`firstRunFields` 与诊断共用 —— 判据只有这一份，不会走样）。 */
function validQuestionnaire(value: unknown): value is { version: 1; answers: OnboardingQuestionAnswers } {
  const questionnaire = value as { version?: unknown; answers?: unknown } | null | undefined;
  if (questionnaire?.version !== 1) return false;
  const answers = questionnaire.answers;
  if (!Array.isArray(answers) || answers.length !== 4) return false;
  return answers.every((answer: unknown) => answer === 'yes' || answer === 'no' || answer === null);
}

function validPersona(value: unknown): value is OnboardingPersona {
  const persona = value as Partial<OnboardingPersona> | null | undefined;
  return (
    !!persona &&
    ['default', 'user', 'approved-rule'].includes(persona.source as string) &&
    (persona.id === null || (typeof persona.id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(persona.id))) &&
    (persona.ruleVersion === null || typeof persona.ruleVersion === 'string') &&
    !(persona.source === 'approved-rule' && (!persona.id || !persona.ruleVersion))
  );
}

function validWorkMatch(value: unknown): value is OnboardingWorkMatch {
  const workMatch = value as
    | {
        profileVersion?: unknown;
        source?: unknown;
        requestId?: unknown;
        runId?: unknown;
        modelId?: unknown;
        summary?: unknown;
        starters?: unknown;
        usageStatus?: unknown;
      }
    | null
    | undefined;
  if (!workMatch || typeof workMatch.profileVersion !== 'string' || !workMatch.profileVersion) return false;
  if (workMatch.source === 'ai') {
    const starters = workMatch.starters;
    return (
      boundedText(workMatch.requestId, 160) &&
      boundedText(workMatch.runId, 160) &&
      boundedText(workMatch.modelId, 160) &&
      typeof workMatch.summary === 'string' &&
      workMatch.summary.trim().length > 0 &&
      workMatch.summary.length <= 240 &&
      Array.isArray(starters) &&
      starters.length <= 3 &&
      starters.every((entry: unknown) => typeof entry === 'string' && entry.trim().length > 0 && entry.length <= 160) &&
      (workMatch.usageStatus === 'settled' || workMatch.usageStatus === 'pending')
    );
  }
  return workMatch.source === 'basic';
}

function firstRunFields(
  parsed: Partial<OnboardingProfile>,
): Pick<
  OnboardingProfile,
  'introduction' | 'industry' | 'questionnaire' | 'persona' | 'portrait' | 'workMatch'
> | null {
  const industry = parseIndustry(parsed.industry);
  if (!industry) return null;
  const questionnaire = parsed.questionnaire;
  if (!validQuestionnaire(questionnaire)) return null;
  const persona = parsed.persona;
  if (!validPersona(persona)) return null;
  /**
   * ⭐ 画像**逐字段降级**（2026-10-07 体检问题 8）：画像只是形象层，形状坏了就丢它自己，
   *    **不许**连昵称/岗位/作答一起作废（那是"画坏一张头像 ⇒ 整份档案消失"）。
   *    仍然不编默认画像：丢了就是 `undefined`，一头像退回图标。
   */
  const portrait = parsePortrait(parsed.portrait);
  const workMatch = parsed.workMatch;
  if (!validWorkMatch(workMatch)) return null;
  return {
    introduction: typeof parsed.introduction === 'string' ? parsed.introduction : '',
    industry: { ...industry },
    questionnaire: { version: 1, answers: [...questionnaire.answers] },
    persona: { ...persona },
    // ⚠️ 没有就**不加键**（不许注入 `undefined`/默认画像）—— 两条既有 `toEqual` 测试盯着这里。
    ...(portrait ? { portrait } : {}),
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

/* ────────────────────────── 加载诊断（BUG-034，2026-10-13） ────────────────────────── */

/**
 * 画像加载结果的**闭集原因**。只陈述"这一次读取发生了什么"，不猜根因（BUG-034 的纪律：
 * 先识别失败原因，禁止先加 flush 再声称找到根因）：
 *
 * | 原因 | 含义 | 排查注意 |
 * |---|---|---|
 * | `ok` | 读到并解析出一份合法档案 | — |
 * | `missing` | 两个键都没有可用记录（含空串） | **不等于**"用户没填过"：写入没落盘、
 *   或这次读的不是同一份存储，都会长这样 —— 要跟保存侧记录与 `app.start` 的 userData 对账 |
 * | `parse-invalid` | 记录在，但 `JSON.parse` 失败（半写/截断/乱码） | |
 * | `schema-invalid` | JSON 能解析但结构不认识（版本、缺段、形状非法） | `sections` 指出出错段 |
 * | `owner-mismatch` | 记录自称属于别的 userId（旧盘残留/串号） | 绝不回借给别的账号 |
 * | `storage-error` | 读存储本身抛错（localStorage 不可用/被拒） | **不等于** `missing` |
 *
 * ⚠️ 这是**诊断**分类，不参与接受/拒绝决定：`profile` 是否为空只由既有 schema 判据说了算
 *    （`ok` ⇔ `profile !== null`），分类只解释"为什么是空"。
 */
export type OnboardingProfileLoadReason =
  | 'ok'
  | 'missing'
  | 'parse-invalid'
  | 'schema-invalid'
  | 'owner-mismatch'
  | 'storage-error';

/**
 * v3 记录里结构不合法的**段名闭集**（只有键名，永远不含值）。
 * 诊断用：把"schema 坏了"细到哪一段 —— 缺字段与新字段兼容问题一眼可分。
 */
export type OnboardingProfileSchemaSection =
  | 'version'
  | 'userId'
  | 'useCases'
  | 'industry'
  | 'questionnaire'
  | 'persona'
  | 'workMatch';

export interface OnboardingProfileLoadResult {
  reason: OnboardingProfileLoadReason;
  /**
   * 只有 `ok` 非空；其余原因一律 `null` —— 与旧入口 `loadOnboardingProfile` 的返回值**恒等**
   * （`loadOnboardingProfile` 现在是它的一层薄壳）。
   */
  profile: NormalizedOnboardingProfile | null;
  /** 诊断元数据：命中哪个键、记录自报的 schema 版本、失败的段名。**不含画像内容**。 */
  diagnostic: {
    keyKind: 'v3' | 'legacy' | null;
    recordVersion: number | null;
    sections: OnboardingProfileSchemaSection[];
  };
}

/** 复用与 `firstRunFields` 同一组判据，只回报**出错段名**（诊断用；不参与接受/拒绝决定）。 */
function firstRunFailedSections(parsed: Partial<OnboardingProfile>): OnboardingProfileSchemaSection[] {
  const failed: OnboardingProfileSchemaSection[] = [];
  if (!parseIndustry(parsed.industry)) failed.push('industry');
  if (!validQuestionnaire(parsed.questionnaire)) failed.push('questionnaire');
  if (!validPersona(parsed.persona)) failed.push('persona');
  if (!validWorkMatch(parsed.workMatch)) failed.push('workMatch');
  return failed;
}

/**
 * 画像加载的**诊断入口**（BUG-034）：与 `loadOnboardingProfile` 同一套读写规则、同一份存储键、
 * 同一套 schema 判据，只多了"为什么读不到"的分类与结构元数据。
 *
 * ⚠️ 只读：不写、不清、不迁移（迁移仍只在既有 schema 内，见 `loadOnboardingProfile` 的语义）。
 * ⚠️ 不引入第二套 store：真源仍是 `rongying-cube:onboarding:v3:<userId>`。
 * 传了 `diagnostics` 时顺手记一笔加载结果（见 `reportOnboardingProfileLoad`）；不传 = 纯读取。
 */
export function loadOnboardingProfileResult(
  userId: string,
  storage?: Pick<OnboardingStorage, 'getItem'>,
  diagnostics?: OnboardingProfileDiagnostics,
): OnboardingProfileLoadResult {
  const result = loadOnboardingProfileResultCore(userId, storage);
  if (diagnostics) reportOnboardingProfileLoad(result, userId, diagnostics);
  return result;
}

/** `loadOnboardingProfileResult` 的纯核心（分类 + 结构元数据，零副作用）。 */
function loadOnboardingProfileResultCore(
  userId: string,
  storage?: Pick<OnboardingStorage, 'getItem'>,
): OnboardingProfileLoadResult {
  const failed = (
    reason: Exclude<OnboardingProfileLoadReason, 'ok'>,
    keyKind: 'v3' | 'legacy' | null,
    recordVersion: number | null,
    sections: OnboardingProfileSchemaSection[],
  ): OnboardingProfileLoadResult => ({
    reason,
    profile: null,
    diagnostic: { keyKind, recordVersion, sections },
  });

  let source: Pick<OnboardingStorage, 'getItem'>;
  try {
    // ⚠️ 默认值是 `window.localStorage`：**访问它本身**也可能抛（node/测试环境里连 window
    //    都没有）—— 这属于"存储不可用"，要跟"没有记录"分开，所以放进 try 里。
    source = storage ?? window.localStorage;
  } catch {
    return failed('storage-error', null, null, []);
  }

  let current: string | null;
  let legacy: string | null = null;
  try {
    current = source.getItem(`${FIRST_RUN_STORAGE_PREFIX}${userId}`);
    // 与旧实现同一读序：v3 键在（哪怕空串）就不读老键。
    if (current === null) legacy = source.getItem(storageKey(userId));
  } catch {
    return failed('storage-error', null, null, []);
  }
  const keyKind: 'v3' | 'legacy' | null = current !== null ? 'v3' : legacy !== null ? 'legacy' : null;
  const raw = current ?? legacy;
  if (!raw) return failed('missing', keyKind, null, []);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return failed('parse-invalid', keyKind, null, []);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return failed('schema-invalid', keyKind, null, []);
  }

  const record = parsed as Partial<OnboardingProfile>;
  const recordVersion = typeof record.version === 'number' ? record.version : null;
  try {
    if (current !== null && record.version !== 3) return failed('schema-invalid', keyKind, recordVersion, ['version']);
    if (![1, 2, 3].includes(record.version ?? 0)) return failed('schema-invalid', keyKind, recordVersion, ['version']);
    if (record.userId !== userId) return failed('owner-mismatch', keyKind, recordVersion, []);
    if (!Array.isArray(record.useCases)) return failed('schema-invalid', keyKind, recordVersion, ['useCases']);
    const useCases = record.useCases.filter((value): value is OnboardingUseCaseId =>
      ONBOARDING_USE_CASE_IDS.includes(value as OnboardingUseCaseId),
    );
    const role = ONBOARDING_ROLE_IDS.includes(record.role as OnboardingRoleId)
      ? (record.role as OnboardingRoleId)
      : 'custom';
    const selectedAssistantIds = Array.isArray(record.selectedAssistantIds)
      ? record.selectedAssistantIds.filter((value): value is StarterId => DEFAULT_STARTERS.includes(value as StarterId))
      : [];
    const responseDetail: ResponseDetail = ['concise', 'balanced', 'detailed'].includes(record.responseDetail as string)
      ? (record.responseDetail as ResponseDetail)
      : 'balanced';
    /**
     * ⚠️ 老记录（v1/v2）没有首跑四件套 —— 这是**合法**的，照读（迁移只在既有 schema 里）。
     *    v3 缺段则整份拒收，并如实报出缺哪段：**绝不**因为新字段缺省把老用户变成首次注册。
     */
    const extra = record.version === 3 ? firstRunFields(record) : {};
    if (!extra) return failed('schema-invalid', keyKind, recordVersion, firstRunFailedSections(record));
    return {
      reason: 'ok',
      profile: {
        version: record.version === 3 ? 3 : 2,
        userId,
        nickname: typeof record.nickname === 'string' ? record.nickname : '',
        role,
        customRole: typeof record.customRole === 'string' ? record.customRole : '',
        useCases,
        customGoal: typeof record.customGoal === 'string' ? record.customGoal : '',
        selectedAssistantIds,
        responseDetail,
        filePermission: record.filePermission === 'task-folder' ? 'task-folder' : 'ask-every-time',
        completedAt: typeof record.completedAt === 'string' ? record.completedAt : '',
        ...extra,
      },
      diagnostic: { keyKind, recordVersion, sections: [] },
    };
  } catch {
    // 形状检查里出了预期外异常：与旧实现一样返回 null，但如实标为"结构不认识"。
    return failed('schema-invalid', keyKind, recordVersion, []);
  }
}

/**
 * 旧入口（兼容包装）：调用方拿到的仍是 `profile | null`，与 `loadOnboardingProfileResult(userId,
 * storage).profile` **恒等**。诊断能力走 `loadOnboardingProfileResult`，这里只是一层壳。
 */
export function loadOnboardingProfile(
  userId: string,
  storage?: Pick<OnboardingStorage, 'getItem'>,
): NormalizedOnboardingProfile | null {
  return loadOnboardingProfileResult(userId, storage).profile;
}

/**
 * 匿名账号指纹（FNV-1a，与本文件其它版本号同一算法）：同一个账号跨两次运行得到同一个值，
 * 便于对账"昨天/今天是不是同一账号"，但**不落明文 userId**。
 */
export function anonymousAccountFingerprint(userId: string): string {
  let hash = 2166136261;
  for (let index = 0; index < userId.length; index += 1) {
    hash ^= userId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `acc-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

/** 诊断事件的出口（默认 `window.clawwork.reportDebugEvent`；测试注入假出口）。 */
export type OnboardingProfileLoadReporter = (event: {
  domain: string;
  event: string;
  data?: Record<string, unknown>;
}) => void;

/**
 * 诊断上下文（可选注入）：**只有传了它才上报**，不传 = 纯函数、零副作用。
 * `report` 是出口注入点（默认走 `window.clawwork.reportDebugEvent`），供测试与其它宿主使用。
 */
export interface OnboardingProfileDiagnostics {
  /** 调用点标签（如 `'entry'` / `'local-entry'` / `'entry-complete'`），用来把记录归位。 */
  source?: string;
  /** 调用点已知的工作区 scope key（可选；不知道就不占键）。 */
  scopeKey?: string | null;
  /** 注入的出口；缺省用默认出口（桥不存在时静默跳过）。 */
  report?: OnboardingProfileLoadReporter | null;
}

/**
 * 取默认出口：老 preload / 测试桩 / node 环境里没有桥都返回 `null`（**绝不抛**）。
 * ⚠️ 事件最终落在主进程的 `renderer` 域 → `<userData>/logs/debug-<date>.ndjson`，与每次启动的
 *    `app.start {userData}`、`app.userData.portable` 同一份文件 —— "userData/workspace 是哪一份"
 *    用日志文件本身配对，不需要（也不应该）为诊断新增 IPC。
 */
function defaultOnboardingDiagnosticReporter(): OnboardingProfileLoadReporter | null {
  if (typeof window === 'undefined') return null;
  const bridge = (window as unknown as { clawwork?: { reportDebugEvent?: unknown } }).clawwork;
  const report = bridge?.reportDebugEvent;
  return typeof report === 'function' ? (report as OnboardingProfileLoadReporter).bind(bridge) : null;
}

/**
 * 记录一次画像加载的结果（BUG-034）：原因 / schema / 匿名身份，**不记录画像内容**。
 * 只报结构事实（原因、键形态、记录自报版本、失败段名），事件进主进程调试日志。
 * 返回是否真的报了出去（桥不可用/上报抛错时为 `false`，且绝不把入口带崩）。
 */
export function reportOnboardingProfileLoad(
  result: OnboardingProfileLoadResult,
  userId: string,
  diagnostics?: OnboardingProfileDiagnostics,
): boolean {
  const sink = diagnostics?.report ?? defaultOnboardingDiagnosticReporter();
  if (!sink) return false;
  try {
    sink({
      domain: 'renderer',
      event: 'onboarding.profile.load',
      data: {
        reason: result.reason,
        keyKind: result.diagnostic.keyKind,
        recordVersion: result.diagnostic.recordVersion,
        sections: result.diagnostic.sections,
        account: anonymousAccountFingerprint(userId),
        ...(diagnostics?.source ? { source: diagnostics.source } : {}),
        ...(diagnostics?.scopeKey ? { scopeKey: diagnostics.scopeKey } : {}),
      },
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * 记录一次画像保存的结果（BUG-034 的对账另一半）：**这一笔到底存下去了没有**。
 * 只有保存侧也留痕，跨两次运行才能区分"没存"与"读了另一份存储"。
 * `errorKind` 只收异常的 `name`（如 `QuotaExceededError`），不收消息/画像内容。
 */
export function reportOnboardingProfileSave(
  outcome: { ok: true; keyKind: 'v3' | 'legacy' } | { ok: false; errorKind: string },
  userId: string,
  diagnostics?: OnboardingProfileDiagnostics,
): boolean {
  const sink = diagnostics?.report ?? defaultOnboardingDiagnosticReporter();
  if (!sink) return false;
  try {
    sink({
      domain: 'renderer',
      event: 'onboarding.profile.save',
      data: {
        ok: outcome.ok,
        ...(outcome.ok ? { keyKind: outcome.keyKind } : { errorKind: outcome.errorKind }),
        account: anonymousAccountFingerprint(userId),
        ...(diagnostics?.source ? { source: diagnostics.source } : {}),
        ...(diagnostics?.scopeKey ? { scopeKey: diagnostics.scopeKey } : {}),
      },
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * 保存画像（**失败必须向上抛** —— App 的完成回调依赖这次抛出把编辑页留住，不许吞成"成功"）。
 *
 * 传了 `diagnostics` 时顺手记一笔保存结果（成功/失败各一条，见 `reportOnboardingProfileSave`）；
 * 不传就是原来的纯保存。上报本身**绝不影响**保存语义：先落盘、失败先重抛、成功才回执。
 */
export function saveOnboardingProfile(
  profile: OnboardingProfile,
  storage: OnboardingStorage = window.localStorage,
  diagnostics?: OnboardingProfileDiagnostics,
): void {
  const keyKind: 'v3' | 'legacy' = profile.version === 3 ? 'v3' : 'legacy';
  const key = profile.version === 3 ? `${FIRST_RUN_STORAGE_PREFIX}${profile.userId}` : storageKey(profile.userId);
  try {
    storage.setItem(key, JSON.stringify(profile));
    /**
     * v3 落盘后把同账号的 **v1 老键清掉**（2026-10-07 体检问题 12d）：`loadOnboardingProfile`
     * 只在 v3 缺失时才回读 v1，所以留着不影响读；但它是**上一位用户的画像**（趣味画像链
     * 之外的旧格式），留着只会让"这台盘上有几份关于我的档案"这种排查越查越糊涂。
     * `removeItem` 是可选的：老的单测假存储没实现它，缺了就当清理这一步不存在。
     */
    if (profile.version === 3) storage.removeItem?.(storageKey(profile.userId));
  } catch (failure) {
    if (diagnostics)
      reportOnboardingProfileSave(
        { ok: false, errorKind: failure instanceof Error ? failure.name : 'unknown' },
        profile.userId,
        diagnostics,
      );
    throw failure;
  }
  if (diagnostics) reportOnboardingProfileSave({ ok: true, keyKind }, profile.userId, diagnostics);
}

/* ────────────────────────── 首跑草稿（2026-10-07 体检问题 7） ────────────────────────── */

/**
 * 首跑向导的**保存点**（sessionStorage，按 `userId:scopeKey` 分键）。
 *
 * 为什么要有：首跑的三页输入全在内存里，中途关掉应用/刷新页面 = 全丢，用户得从头填。
 * 这里只存"填到哪了"，**不存档案**（档案仍由 `saveOnboardingProfile` 落 v3 键）；
 * 用 sessionStorage 是刻意的：一个应用会话内的中断（刷新/意外关闭页面）能接上，
 * 而下次开机重新首跑时不该拿上一次会话的残渣冒充用户意图。
 *
 * ⚠️ 只服务**首跑**：编辑模式有真档案，草稿只会和档案打架（不读不写）。
 */
export const ONBOARDING_DRAFT_STORAGE_PREFIX = 'rongying-cube:onboarding-draft:v1:';

export interface OnboardingDraftStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem?: (key: string) => void;
}

export interface OnboardingDraft {
  version: 1;
  page: 'profile' | 'portrait' | 'result';
  nickname: string;
  introduction: string;
  industry: OnboardingIndustry | null;
  role: OnboardingRoleId;
  customRole: string;
  useCases: OnboardingUseCaseId[];
  customGoal: string;
  answers: OnboardingQuestionAnswers;
  questionIndex: number;
  portraitDone: boolean;
  portraitTouched: boolean;
  /**
   * 画像页的形象层补充信息（可选；没填就不占键）。草稿里也带着它们，
   * 刷新/意外中断后性别与年龄不用重选。
   */
  gender?: PortraitGender | null;
  age?: number | null;
  selectedAssistantIds: StarterId[];
  /** 结果页的本地回执（首跑只会是 `basic`；AI 匹配通道未开放）。 */
  match: { source: 'basic'; profileVersion: string } | null;
}

/**
 * 草稿键的作用域 = 向导自己那份 React key（`App` 里就是 `userId:scopeKey`）。
 * 换账号、换工作区都会得到不同的草稿 —— 不把上一个场景的输入搬过来。
 */
export function onboardingDraftScope(userId: string, scopeKey?: string): string {
  return `${userId}:${scopeKey ?? 'account-local'}`;
}

function draftStorage(): OnboardingDraftStorage | null {
  return typeof window === 'undefined' ? null : window.sessionStorage;
}

/** 读回首跑草稿；坏了 / 没存过 / 存储不可用一律 `null`（向导从默认值起步）。 */
export function readOnboardingDraft(scope: string, storage?: OnboardingDraftStorage): OnboardingDraft | null {
  try {
    const source = storage ?? draftStorage();
    if (!source) return null;
    const raw = source.getItem(`${ONBOARDING_DRAFT_STORAGE_PREFIX}${scope}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<OnboardingDraft>;
    if (parsed.version !== 1) return null;
    const page: OnboardingDraft['page'] =
      parsed.page === 'portrait' || parsed.page === 'result' || parsed.page === 'profile' ? parsed.page : 'profile';
    const answers: OnboardingQuestionAnswers =
      Array.isArray(parsed.answers) &&
      parsed.answers.length === 4 &&
      parsed.answers.every((answer) => answer === 'yes' || answer === 'no' || answer === null)
        ? [...parsed.answers]
        : [null, null, null, null];
    const match =
      parsed.match && parsed.match.source === 'basic' && boundedText(parsed.match.profileVersion, 160)
        ? { source: 'basic' as const, profileVersion: parsed.match.profileVersion }
        : null;
    // 形象层补充信息：坏值只丢自己（`null` 与"没填过"在向导里是同一件事）。
    const gender = isPortraitGender(parsed.gender) ? parsed.gender : null;
    const age = parsePortraitAge(parsed.age);
    return {
      version: 1,
      page,
      nickname: typeof parsed.nickname === 'string' ? parsed.nickname : '',
      introduction: typeof parsed.introduction === 'string' ? parsed.introduction : '',
      industry: parseIndustry(parsed.industry),
      role: ONBOARDING_ROLE_IDS.includes(parsed.role as OnboardingRoleId)
        ? (parsed.role as OnboardingRoleId)
        : 'custom',
      customRole: typeof parsed.customRole === 'string' ? parsed.customRole : '',
      useCases: Array.isArray(parsed.useCases)
        ? parsed.useCases.filter((value): value is OnboardingUseCaseId =>
            ONBOARDING_USE_CASE_IDS.includes(value as OnboardingUseCaseId),
          )
        : [],
      customGoal: typeof parsed.customGoal === 'string' ? parsed.customGoal : '',
      answers,
      questionIndex:
        typeof parsed.questionIndex === 'number' &&
        Number.isInteger(parsed.questionIndex) &&
        parsed.questionIndex >= 0 &&
        parsed.questionIndex <= 3
          ? parsed.questionIndex
          : 0,
      portraitDone: parsed.portraitDone === true,
      portraitTouched: parsed.portraitTouched === true,
      ...(gender ? { gender } : {}),
      ...(age !== null ? { age } : {}),
      selectedAssistantIds: Array.isArray(parsed.selectedAssistantIds)
        ? parsed.selectedAssistantIds.filter((value): value is StarterId =>
            DEFAULT_STARTERS.includes(value as StarterId),
          )
        : [],
      match,
    };
  } catch {
    return null;
  }
}

/** 存下当前进度（写不进去就算了 —— 是体验增强，不许挡首跑）。 */
export function saveOnboardingDraft(scope: string, draft: OnboardingDraft, storage?: OnboardingDraftStorage): void {
  try {
    const target = storage ?? draftStorage();
    target?.setItem(`${ONBOARDING_DRAFT_STORAGE_PREFIX}${scope}`, JSON.stringify(draft));
  } catch {
    // 隐私模式 / 配额满：忽略。
  }
}

/** 档案真正落盘后把草稿清掉（再留着，下次进来会"复活"上一轮的输入）。 */
export function clearOnboardingDraft(scope: string, storage?: OnboardingDraftStorage): void {
  try {
    const target = storage ?? draftStorage();
    target?.removeItem?.(`${ONBOARDING_DRAFT_STORAGE_PREFIX}${scope}`);
  } catch {
    // 清不掉也不许挡流程。
  }
}

/**
 * 只读选择器（06 头像链）：某个账号的档案里固化的**六角色 code**，没有就 `null`。
 *
 * 为什么在这读、而不是等 props 下发：唯一真源仍然是 `rongying-cube:onboarding:v3:<userId>`
 * （App 加载 → props 下发那条路不变）。但聊天里的 `MessageAvatar` 拿不到 profile，
 * 而归它名下的只有这一个组件 —— 于是给它一个**纯读**的取数口。
 *
 * ⚠️ **必须带上账号**（2026-10-07 体检问题 5）：以前它扫 v3 前缀、返回**第一份**能解析的
 *    档案 —— 盘上登录过两个账号时，B 的头像会取到 A 的立绘。现在按 `userId` 精确读；
 *    不传 `userId` 才回落到扫描（旧兜底，只该出现在"压根没有账号上下文"的调用里）。
 * ⚠️ 只读：不写、不缓存、不引入第二套 store；档案写坏的风险为零。
 */
export function readStoredPortraitRole(
  userId?: string | null,
  storage?: OnboardingStorageReader,
): PortraitRoleCode | null {
  return readStoredPortraitIdentity(userId, storage)?.role ?? null;
}

/** 头像链要用的那三样：六角色 code（立绘降级）+ 四字码 + 可选性别（16 型形象）。 */
export interface StoredPortraitIdentity {
  role: PortraitRoleCode;
  /** 趣味四字码（可能含 `X`；不完整 = 查不到 16 型形象）。 */
  letters: string;
  gender: PortraitGender | null;
}

/**
 * 同一条只读通道的**完整版**（2026-10-08 16 型形象）：除了六角色 code，还把画像里
 * 固化的四字码与性别一并取出来（没填过 = `null`）——`MessageAvatar` 要按它挑 16 型头像。
 *
 * ⚠️ 规则与 `readStoredPortraitRole` 完全一致（同一份档案、同一个账号口径、只读不写）；
 *    `readStoredPortraitRole` 现在是它的一层薄壳，两条链不会各读各的。
 */
export function readStoredPortraitIdentity(
  userId?: string | null,
  storage?: OnboardingStorageReader,
): StoredPortraitIdentity | null {
  const fromProfile = (profile: NormalizedOnboardingProfile | null): StoredPortraitIdentity | null => {
    const portrait = profile?.portrait;
    if (!portrait?.role) return null;
    return { role: portrait.role, letters: portrait.letters, gender: portrait.gender ?? null };
  };
  try {
    const source = storage ?? (typeof window === 'undefined' ? null : window.localStorage);
    if (!source) return null;
    if (userId) return fromProfile(loadOnboardingProfile(userId, source));
    for (let index = 0; index < source.length; index += 1) {
      const key = source.key(index);
      if (!key || !key.startsWith(FIRST_RUN_STORAGE_PREFIX)) continue;
      const identity = fromProfile(loadOnboardingProfile(key.slice(FIRST_RUN_STORAGE_PREFIX.length), source));
      if (identity) return identity;
    }
  } catch {
    // 读不到（隐私模式 / 坏 JSON / 存储被清）就当没有画像：头像退回既有图标。
    return null;
  }
  return null;
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
