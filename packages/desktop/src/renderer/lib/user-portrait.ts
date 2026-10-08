/**
 * 3a 身份画像（4 题 → 五维雷达 → 六角色）——**纯本地规则**，零模型调用。
 *
 * 规则来源：`D:\backup\portrait-rulepack-v1-20261005.md`（"技术默认包 v1"）。
 * 批准文本的两条红线（照抄，不许违反）：
 *   ① 四题只用于**已批准的趣味角色规则**，不得称为专业测评 / MBTI 测量；
 *   ② 没有数据时显示待配置，**不生成虚构分数**（全跳过 ⇒ `role = null`，不画雷达、不出角色卡）。
 *   ③ 性别/年龄只是**形象层**的可选补充（挑 16 型形象素材用），不进五维分数、不影响角色判定；
 *      旧档案没有这两键照读（不许因为新键把老记录整份作废）。
 *
 * `ruleVersion` 钉住规则版本：日后换权重 / 换命名 / 换角色，旧记录仍按 `portrait-v1` 解释，
 * 不会被新规则"重算"污染（施工图 §8 风险 3）。
 *
 * ⚠️ 本模块**零 React、零 i18n**：可直接单测，也被 `lib/user-onboarding.ts` 的校验器引用。
 */

export const PORTRAIT_RULE_VERSION = 'portrait-v1';

/** 五维（顺序 = 雷达图从正上方起顺时针的轴顺序）。 */
export const PORTRAIT_AXES = ['外向力', '探索力', '理性力', '条理力', '共情力'] as const;
export type PortraitAxis = (typeof PORTRAIT_AXES)[number];
export type PortraitAxes = Record<PortraitAxis, number>;

/** 六角色（顺序 = 平手裁定顺序，见 rulepack §3 表序）。 */
export const PORTRAIT_ROLE_CODES = ['zhenshan', 'hewei', 'hengchuan', 'zhiwei', 'baina', 'yangsheng'] as const;
export type PortraitRoleCode = (typeof PORTRAIT_ROLE_CODES)[number];

/** 四题答案：'yes' 是 / 'no' 否 / null 跳过（跳过 = 不加不减）。 */
export type PortraitAnswer = 'yes' | 'no' | null;
export type PortraitAnswers = readonly [PortraitAnswer, PortraitAnswer, PortraitAnswer, PortraitAnswer];

/**
 * 形象层的**性别**（16 型形象素材按男/女各一套）。
 *
 * ⚠️ 它只是"挑哪张形象素材"的可选补充信息，**不是测评维度、不进五维分数、不影响角色判定**；
 *    没有它照样出画像，只是形象退回旧六角色立绘。
 */
export const PORTRAIT_GENDERS = ['male', 'female'] as const;
export type PortraitGender = (typeof PORTRAIT_GENDERS)[number];

/** 年龄（可选）只接受这个区间里的整数；空 / 越界 / 非整数 = "没填"。 */
export const PORTRAIT_AGE_MIN = 1;
export const PORTRAIT_AGE_MAX = 120;

export function isPortraitGender(value: unknown): value is PortraitGender {
  return (PORTRAIT_GENDERS as readonly unknown[]).includes(value);
}

/**
 * 解析年龄输入：**只放行 1–120 的整数**，其余（空、小数、越界、字符串）一律 `null`。
 * 不截断、不取整、不编造 —— 拿不准就当用户没填（红线：没有数据不生成虚构值）。
 */
export function parsePortraitAge(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  return value >= PORTRAIT_AGE_MIN && value <= PORTRAIT_AGE_MAX ? value : null;
}

/** 形象层补充信息（可空；`null`/缺省 = 不加键）。 */
export interface PortraitDetails {
  gender?: PortraitGender | null;
  age?: number | null;
}

type PortraitDetailKeys = { gender?: PortraitGender; age?: number };

/** 只把**真的填了**的补充信息变成键：拿不准的一律不加键。 */
function portraitDetailKeys(details: PortraitDetails): PortraitDetailKeys {
  const keys: PortraitDetailKeys = {};
  if (isPortraitGender(details.gender)) keys.gender = details.gender;
  const age = parsePortraitAge(details.age ?? null);
  if (age !== null) keys.age = age;
  return keys;
}

/** 落进 `OnboardingProfile.portrait` 的固化记录。 */
export interface OnboardingPortrait {
  axes: PortraitAxes;
  /** 趣味四字码（Q1 E/I、Q2 S/N、Q3 T/F、Q4 J/P）；跳过的那一位是 `X`。 */
  letters: string;
  role: PortraitRoleCode;
  ruleVersion: string;
  /** true = 已固化进档案；false 预留给「仅预览、未固化」的场景。 */
  locked: boolean;
  /**
   * 形象层补充信息（可选）。**旧档案没有这两键就是合法的** —— 校验器只认形状，
   * 缺了照读（形象退回六角色立绘），不许因为新键把老档案整份作废。
   */
  gender?: PortraitGender;
  age?: number;
}

/** 打分器的输出（全跳过时 `role` 为 null，不生成虚构角色）。 */
export interface PortraitDerivation {
  axes: PortraitAxes;
  letters: string;
  role: PortraitRoleCode | null;
}

/** 维度名 → i18n 键后缀（`onboarding.portrait.dimensions.<suffix>`）。 */
export const PORTRAIT_AXIS_I18N: Record<PortraitAxis, string> = {
  外向力: 'extraversion',
  探索力: 'exploration',
  理性力: 'rationality',
  条理力: 'orderliness',
  共情力: 'empathy',
};

const BASE_SCORE = 50;

/**
 * rulepack §2 表：每题对五维的 ± 分（"是"加、"否"减、跳过 0）。
 * 索引 = 题号：0 popular / 1 sport / 2 math / 3 tidy。
 */
const QUESTION_EFFECTS: readonly Readonly<Partial<Record<PortraitAxis, number>>>[] = [
  { 外向力: 20, 共情力: 10 },
  { 外向力: 10, 探索力: 20 },
  { 理性力: 20, 条理力: 10 },
  { 理性力: 10, 条理力: 20 },
];

/** rulepack §2 尾注：Q2 与 Q4 同号 +5 / 异号 −5（两者都作答时才生效）。 */
const EMPATHY_PAIR_BONUS = 5;

/**
 * 六角色权重向量（rulepack §3 的"权重倾向"归一化成每行和为 1 的确定性数值）。
 * 倾向逐行对照：枕山 共情2/条理2/外向1；禾味 共情2/探索2/外向1；衡川 理性3/条理2；
 * 知微 理性2/共情2/条理1；百纳 条理2/外向2/理性1；扬声 外向3/探索2。
 */
const ROLE_WEIGHTS: Record<PortraitRoleCode, PortraitAxes> = {
  zhenshan: { 外向力: 0.2, 探索力: 0, 理性力: 0, 条理力: 0.4, 共情力: 0.4 },
  hewei: { 外向力: 0.2, 探索力: 0.4, 理性力: 0, 条理力: 0, 共情力: 0.4 },
  hengchuan: { 外向力: 0, 探索力: 0, 理性力: 0.6, 条理力: 0.4, 共情力: 0 },
  zhiwei: { 外向力: 0, 探索力: 0, 理性力: 0.4, 条理力: 0.2, 共情力: 0.4 },
  baina: { 外向力: 0.4, 探索力: 0, 理性力: 0.2, 条理力: 0.4, 共情力: 0 },
  yangsheng: { 外向力: 0.6, 探索力: 0.4, 理性力: 0, 条理力: 0, 共情力: 0 },
};

/** 四字码：Q1 是=E 否=I；Q2 是=S 否=N；Q3 是=T 否=F；Q4 是=J 否=P；跳过 = X。 */
const LETTER_PAIRS: readonly (readonly [string, string])[] = [
  ['E', 'I'],
  ['S', 'N'],
  ['T', 'F'],
  ['J', 'P'],
];
const UNKNOWN_LETTER = 'X';

/** 浮点比较余量：点积只差一丝时按平手处理，保证「平手按表序」稳定可复现。 */
const TIE_EPSILON = 1e-9;

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return BASE_SCORE;
  return Math.min(100, Math.max(0, Math.round(value)));
}

function dot(weights: PortraitAxes, scores: PortraitAxes): number {
  let total = 0;
  for (const axis of PORTRAIT_AXES) total += weights[axis] * scores[axis];
  return total;
}

/**
 * 4 题答案 → 五维分数（0–100 整数）+ 趣味四字码 + 六角色。
 *
 * 全跳过（4 题都是 null）⇒ `role = null`（红线：没有数据就不生成虚构分数 / 角色）；
 * 部分作答照常出分——每个维度都从基线 50 起算，跳过的那题就是不加不减。
 */
export function derivePortrait(answers: readonly PortraitAnswer[]): PortraitDerivation {
  const axes: PortraitAxes = {
    外向力: BASE_SCORE,
    探索力: BASE_SCORE,
    理性力: BASE_SCORE,
    条理力: BASE_SCORE,
    共情力: BASE_SCORE,
  };
  let answered = 0;
  for (let index = 0; index < QUESTION_EFFECTS.length; index += 1) {
    const answer = answers[index] ?? null;
    if (answer === null) continue;
    answered += 1;
    const sign = answer === 'yes' ? 1 : -1;
    const effect = QUESTION_EFFECTS[index];
    for (const axis of PORTRAIT_AXES) {
      const delta = effect[axis];
      if (delta) axes[axis] += sign * delta;
    }
  }

  const sport = answers[1] ?? null;
  const tidy = answers[3] ?? null;
  if (sport !== null && tidy !== null) {
    axes['共情力'] += sport === tidy ? EMPATHY_PAIR_BONUS : -EMPATHY_PAIR_BONUS;
  }

  const scores: PortraitAxes = {
    外向力: clampScore(axes['外向力']),
    探索力: clampScore(axes['探索力']),
    理性力: clampScore(axes['理性力']),
    条理力: clampScore(axes['条理力']),
    共情力: clampScore(axes['共情力']),
  };

  const letters = LETTER_PAIRS.map(([yesLetter, noLetter], index) => {
    const answer = answers[index] ?? null;
    if (answer === 'yes') return yesLetter;
    if (answer === 'no') return noLetter;
    return UNKNOWN_LETTER;
  }).join('');

  if (answered === 0) return { axes: scores, letters, role: null };

  let bestIndex = 0;
  let bestScore = dot(ROLE_WEIGHTS[PORTRAIT_ROLE_CODES[0]], scores);
  for (let index = 1; index < PORTRAIT_ROLE_CODES.length; index += 1) {
    const value = dot(ROLE_WEIGHTS[PORTRAIT_ROLE_CODES[index]], scores);
    // 严格大于 + 余量 ⇒ 平手时保留表序更靠前的角色（确定性，见 rulepack §3）。
    if (value > bestScore + TIE_EPSILON) {
      bestIndex = index;
      bestScore = value;
    }
  }
  return { axes: scores, letters, role: PORTRAIT_ROLE_CODES[bestIndex] };
}

/** 把派生结果包装成可落盘的固化记录（`locked` 由调用方决定）。 */
export function toOnboardingPortrait(
  derivation: PortraitDerivation,
  locked: boolean,
  details: PortraitDetails = {},
): OnboardingPortrait | null {
  if (!derivation.role) return null;
  return {
    axes: { ...derivation.axes },
    letters: derivation.letters,
    role: derivation.role,
    ruleVersion: PORTRAIT_RULE_VERSION,
    locked,
    ...portraitDetailKeys(details),
  };
}

/**
 * 把补充信息（性别/年龄）并入一份**已固化**的画像 —— 编辑模式下只改了性别/年龄、
 * 四题一个没动时用它（画像主体按原样保留，不用新规则重算旧记录）。
 *
 * ⚠️ 只覆盖、**不删除**：没填（`null`/缺省）时保留原值。按钮组没有"清除"语义，
 *    而一个来路不明的空状态不该把用户档案里的选择抹掉。
 */
export function withPortraitDetails(portrait: OnboardingPortrait, details: PortraitDetails): OnboardingPortrait {
  return { ...portrait, ...portraitDetailKeys(details) };
}

/**
 * 四题**全部作答**（四位都是确定的 E/I、S/N、T/F、J/P）才谈得上 16 型展示。
 * 任一位是 `X`（跳过）⇒ 不做类型名/一句话查询 —— 宁可只说"资料不足"，不虚构一个类型。
 * （字母表两两互斥且封闭 ⇒ 任何完整组合都恰好是 16 型之一，不会查不到。）
 */
export function isCompletePortraitCode(letters: string): boolean {
  return /^[EISTNFPJ]{4}$/.test(letters);
}

/** 界面上未作答的字母位一律显示 `?`（例 `IN?J`）；存储里仍是 `X`。 */
export function displayPortraitLetters(letters: string): string {
  return letters.replace(/X/g, '?');
}
