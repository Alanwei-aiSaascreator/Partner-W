/**
 * 「行业 → 岗位方法与交付结构」的**纯逻辑**（2026-10-16，全量总单第 23 行）。
 *
 * ## 为什么要有这一层
 *
 * 首跑档案里**早就有**行业（`ONBOARDING_INDUSTRY_CODES`，`lib/user-onboarding.ts`），
 * 但选完之后它只做了两件事：① 在个性化中心显示一个中文标签；② 当作 `workMatch`
 * 请求的一个入参。**选 C（制造业）和选 R（文体娱乐）对助手的行为完全一样** ——
 * 用户花力气填的那个选择，没有真的进到产出的提示词里。
 *
 * 这一层把行业变成**真的会影响产出**的东西：它被写进每个助手**每轮都读**的
 * `USER.md` 身份块（`lib/identity-persona.ts` 的 `buildIdentityBlock`），
 * 并且点名一个**随包真有的**交付模板技能。
 *
 * ## 为什么文案是 i18n 键而不是直接写中文
 *
 * 界面上的 9 种语言都要能显示这段。所以这一层只产出**键**，由调用方（个性化中心）
 * 用 `t()` 渲染；纯函数不 import i18n ⇒ 它能被单测直接跑，不用起 React。
 * 键位清单见交付物 `D:/backup/batchA-i18n-keys.json`（i18n 是单 owner，本层不写 locale）。
 *
 * ## 为什么块里固定三行、不许换行
 *
 * 这段要并进 `USER.md` 的身份块，而身份块是**按前缀剥离**再重写的
 *（`stripIdentityBlock`）：多行自由文本会让"用户自己写的内容"和"我们写的内容"
 * 分不开，重复保存就会越堆越多 —— 那是会把用户记忆写坏的那条路。
 * 三行、固定前缀、每行不含换行，剥离器就能精确地只吞自己那几行。
 */

import { ONBOARDING_INDUSTRY_CODES, type OnboardingIndustry, type OnboardingIndustryCode } from './user-onboarding';

/**
 * 五岗位的**交付模板技能 slug**（随包发在 `packages/desktop/our-skills/`）。
 *
 * ⚠️ 这些是**真的存在的目录**，不是占位符：`test/industry-method.test.ts` 会把它们
 *    与 `test/expert-catalog.test.ts` / `test/our-skills-packaging-gate.test.ts`
 *    一起钉在磁盘上。改这里 = 要同时真的放一份 SKILL.md 进去。
 */
export const DELIVERY_TEMPLATE_SLUGS = [
  'partner-w-post-research',
  'partner-w-post-analysis',
  'partner-w-post-creation',
  'partner-w-post-production',
  'partner-w-post-inspection',
] as const;

export type DeliveryTemplateSlug = (typeof DELIVERY_TEMPLATE_SLUGS)[number];

/** 行业码 + 通用档。顺序 = 界面上的顺序（通用在最后，与首跑那页一致）。 */
export const INDUSTRY_METHOD_CODES = [...ONBOARDING_INDUSTRY_CODES, 'general'] as const;
export type IndustryMethodCode = (typeof INDUSTRY_METHOD_CODES)[number];

export interface IndustryMethodProfile {
  code: IndustryMethodCode;
  /**
   * 机器可读的推荐模板清单（顺序 = 推荐强度）。
   *
   * 这是**给代码用的清单**（例如以后要做"按行业预装模板"时按它取）；
   * 给人看的那句话由 `buildIndustryBriefing` 用 i18n 渲染出来。
   */
  templateSlugs: readonly [DeliveryTemplateSlug, ...DeliveryTemplateSlug[]];
}

/**
 * 8 档行业方法档案。
 *
 * ⚠️ **每一档都必须与别的档不同**（`test/industry-method.test.ts` 逐对比较）：
 *    如果两档只是换了个标签、文案一模一样，那这个功能对用户就是零价值。
 *
 * ⚠️ 这里刻意**只存 slug、不存文案键**：那三个键由 `buildIndustryBriefing` 里的
 *    模板字面量现场拼（见那边的说明）—— 键名只此一处，改不出第二种拼法。
 */
export const INDUSTRY_METHOD_PROFILES: Record<IndustryMethodCode, IndustryMethodProfile> = {
  C: { code: 'C', templateSlugs: ['partner-w-post-production', 'partner-w-post-inspection'] },
  H: { code: 'H', templateSlugs: ['partner-w-post-production', 'partner-w-post-creation'] },
  J: { code: 'J', templateSlugs: ['partner-w-post-analysis', 'partner-w-post-inspection'] },
  K: { code: 'K', templateSlugs: ['partner-w-post-analysis', 'partner-w-post-research'] },
  L: { code: 'L', templateSlugs: ['partner-w-post-research', 'partner-w-post-analysis'] },
  P: { code: 'P', templateSlugs: ['partner-w-post-creation', 'partner-w-post-inspection'] },
  R: { code: 'R', templateSlugs: ['partner-w-post-creation', 'partner-w-post-production'] },
  general: { code: 'general', templateSlugs: ['partner-w-post-analysis', 'partner-w-post-research'] },
};

function isKnownCode(value: unknown): value is OnboardingIndustryCode {
  return typeof value === 'string' && (ONBOARDING_INDUSTRY_CODES as readonly string[]).includes(value);
}

/**
 * 档案 → 方法档。**缺失 / 非法一律落到 `general`，绝不猜一个具体行业**
 *（猜错行业会让助手拿错方法论，比"没有行业信息"更坏）。
 */
export function resolveIndustryMethod(industry: OnboardingIndustry | null | undefined): IndustryMethodProfile {
  const code = industry?.code;
  return INDUSTRY_METHOD_PROFILES[isKnownCode(code) ? code : 'general'];
}

/** 身份块认得的三个前缀。`lib/identity-persona.ts` 的剥离器按它们认自己那几行。 */
export const INDUSTRY_BRIEFING_PREFIXES = ['- 行业重点：', '- 行业方法：', '- 交付结构：'] as const;

/** 三行的**显示标签键**（界面用，见 `buildIndustryBriefingDisplay`）。 */
export const INDUSTRY_BRIEF_LABEL_KEYS = [
  'identity.industryBriefLabel.focus',
  'identity.industryBriefLabel.method',
  'identity.industryBriefLabel.template',
] as const;

/** 三行的叶子名（顺序 = focus / method / template，与上面两组一一对应）。 */
const INDUSTRY_BRIEF_LEAVES = ['focus', 'method', 'template'] as const;

/**
 * 方法档 → 写进身份块的三行；`general` 档返回 `null`。
 *
 * ⚠️ 通用档**不写**：用户没选行业时，"通用做法"这句话对**每个**助手都是噪音
 *    （还占 `USER.md` 的 4000 字预算）。宁可不写，也不写一句正确但没用的话。
 *
 * ## ⚠️ 三个键为什么在这里**现场拼**、而且参数必须叫 `t`
 *
 * 文案键是 `identity.industryMethodBrief.<行业码>.<focus|method|template>`。
 * `scripts/check-i18n.mjs` 的「词表 → 代码」方向只认两种写法：**完整键字面量**，
 * 或者 `` t(`前缀.${变量}`) `` 这种模板字面量。
 * 于是：① 键名只有这一处（profile 里不另存一份，改不出第二种拼法）；
 * ② 形参就叫 `t`（与 `useTranslation` 一致）—— 换成 `translate(...)` 就**不再匹配**
 *   那个模板模式，locale 里这几个键会被判成"没人用"，`check:i18n` 会红。
 *
 * ## ⚠️ 为什么是 `industryMethodBrief` 而不是 `industryMethod`（2026-10-16）
 *
 * 个性化中心把 `identity.industryMethod` **当字符串标签**渲染（`t('identity.industryMethod')`）。
 * i18next 的资源是嵌套对象，同一路径**不可能既当字符串叶又当分支** —— 若三行用
 * `identity.industryMethod.<码>.<叶>`，定稿 9 语言时无论怎么写都会有一边上屏成机器话：
 * 写成对象时标签变成 `"key … returned an object instead of string."`（实测 i18next 23），
 * 写成字符串时三行变成原始键名。所以三行的键根改到 `industryMethodBrief`，与标签键
 * **不同路径**。守卫：`test/i18n-key-shape-collision.test.ts`。
 *
 * @param profile `resolveIndustryMethod` 的结果
 * @param t i18n 的 `t`（只要求 `key → string`，便于单测传假货）
 */
export function buildIndustryBriefing(
  profile: IndustryMethodProfile,
  t: (key: string) => string,
): [string, string, string] | null {
  if (profile.code === 'general') return null;
  return INDUSTRY_BRIEF_LEAVES.map((leaf, index) => {
    const label = t(INDUSTRY_BRIEF_LABEL_KEYS[index]);
    const value = t(`identity.industryMethodBrief.${profile.code}.${leaf}`);
    /**
     * ⚠️ **去重前缀**：本仓 9 语言的 `template` 译文**历史上就自带**一个交付标签
     *（zh `交付结构：…`、en `Delivery: …`、fr `Livrable : …` …）。若不摘掉就直接拼
     * 前缀，会得到「前缀＋前缀」的双份（zh：`- 交付结构：交付结构：…`）。
     * `focus` / `method` 的译文不带标签 ⇒ 这里是 no-op。
     */
    const text = value.startsWith(label) ? value.slice(label.length) : value;
    return `${INDUSTRY_BRIEFING_PREFIXES[index]}${text}`;
  }) as [string, string, string];
}

/**
 * 界面用的三行：**本地化标签 + 正文**（正文里已摘掉标签，避免"标签＋标签"）。
 *
 * ## 为什么界面标签要单独本地化，而块里那三行仍用固定的中文前缀
 *
 * `USER.md` 的身份块**整体是中文**（`## 我的身份` / `- 客群：/介绍：/标签：` 都是硬编码
 * 中文，见 `identity-persona.ts`）—— 它是一段**提示词**，不是界面。那三行的前缀是
 * `stripIdentityBlock` 的**剥离判据**：若改成随语言变，换一次语言再保存就会有一份
 * 旧语言的行摘不掉 ⇒ 越堆越多 ⇒ 撑爆 4000 字上限。所以块里保持固定中文前缀。
 *
 * 于是这一层专门给**界面**出本地化标签：正文与写进块里的**逐字相同**（同一次
 * `buildIndustryBriefing` 的算法），只有标签按当前语言走 —— 这就修掉了"英文界面上屏
 * 中文前缀 + 英文译文"。
 */
export function buildIndustryBriefingDisplay(
  profile: IndustryMethodProfile,
  t: (key: string) => string,
): Array<{ label: string; text: string }> | null {
  if (profile.code === 'general') return null;
  return INDUSTRY_BRIEF_LEAVES.map((leaf, index) => {
    const label = t(INDUSTRY_BRIEF_LABEL_KEYS[index]);
    const value = t(`identity.industryMethodBrief.${profile.code}.${leaf}`);
    return { label, text: value.startsWith(label) ? value.slice(label.length) : value };
  });
}
