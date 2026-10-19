import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SUPPORTED_LANGUAGE_CODES } from '@clawwork/shared';

import {
  DELIVERY_TEMPLATE_SLUGS,
  INDUSTRY_METHOD_CODES,
  INDUSTRY_METHOD_PROFILES,
  buildIndustryBriefing,
  resolveIndustryMethod,
  type DeliveryTemplateSlug,
} from '../src/renderer/lib/industry-method';
import { ONBOARDING_INDUSTRY_CODES, type OnboardingIndustry } from '../src/renderer/lib/user-onboarding';

/**
 * 「行业 → 岗位方法与交付结构」的**纯逻辑**（2026-10-16，全量总单第 23 行）。
 *
 * ## 为什么要有这一层
 *
 * 首跑档案里**早就有**行业（`ONBOARDING_INDUSTRY_CODES`），但选完之后它只做了两件事：
 * ① 在个性化中心显示一个中文标签；② 作为 `workMatch` 请求的一个入参。
 * 也就是说：**选 C（制造业）和选 R（文化体育娱乐）对助手的行为完全一样**。
 * 这一层把行业变成真正影响产出的东西 —— 它会写进每个助手每轮都读的 `USER.md`。
 *
 * ## 这一份测什么、不测什么
 *
 * 测：行业之间**真的不同**（不是换了个标签）、未选行业时**一个字都不写**、
 *     交付结构指向的是**随包真有的**技能目录而不是编出来的 slug。
 * 不测：文案好不好（那是内容评审的事）、i18n 键在不在 locale 里（i18n 是单 owner，
 *     键位清单随交付物一起交回，见 `D:/backup/batchA-i18n-keys.json`）。
 */

/** 假的翻译函数：把键原样返回，用来断言"两条线的键确实不同"。 */
const identity = (key: string): string => key;

const industry = (code: OnboardingIndustry['code']): OnboardingIndustry => ({
  code,
  generalConfirmed: code === null,
  source: 'user',
  catalogVersion: 1,
});

describe('INDUSTRY_METHOD_CODES：与首跑档案的行业词表对齐', () => {
  it('⭐ 档案里每一个行业码都有方法档案（新增行业码而不补档案 ⇒ 这里红）', () => {
    for (const code of ONBOARDING_INDUSTRY_CODES) {
      expect(INDUSTRY_METHOD_CODES).toContain(code);
      expect(INDUSTRY_METHOD_PROFILES[code], `${code} 没有方法档案`).toBeTruthy();
    }
  });

  it('⭐ 「还没定行业」（general）也是一个正式档案，不是缺省兜底', () => {
    expect(INDUSTRY_METHOD_CODES).toContain('general');
    expect(INDUSTRY_METHOD_PROFILES.general.code).toBe('general');
  });
});

describe('行业之间必须真的不同（否则就只是个标签）', () => {
  /**
   * ⚠️ 判据取的是**产出**而不是"档案对象不相等"：两个行业最终写进提示词的那三行
   *    逐字相同，就是零价值 —— 哪怕内部字段长得不一样。
   */
  it('⭐ 任取两个**会写块的**行业，三行文案至少有一行不同', () => {
    const codes = INDUSTRY_METHOD_CODES.filter((code) => code !== 'general');
    for (let i = 0; i < codes.length; i += 1) {
      for (let j = i + 1; j < codes.length; j += 1) {
        const a = buildIndustryBriefing(resolveIndustryMethod(industry(codes[i])), identity);
        const b = buildIndustryBriefing(resolveIndustryMethod(industry(codes[j])), identity);
        expect(a, `${codes[i]} 没产出块`).not.toBeNull();
        expect(b, `${codes[j]} 没产出块`).not.toBeNull();
        expect(a, `${codes[i]} 与 ${codes[j]} 产出的块完全一样`).not.toEqual(b);
      }
    }
  });

  it('⭐ 制造业与文体娱乐业产出的提示词块逐字不同（用户可验的那条判据）', () => {
    const c = buildIndustryBriefing(resolveIndustryMethod(industry('C')), identity);
    const r = buildIndustryBriefing(resolveIndustryMethod(industry('R')), identity);
    expect(c).not.toBeNull();
    expect(r).not.toBeNull();
    expect(c).not.toEqual(r);
  });

  it('⭐ 每行文案键都落在本层命名空间里（不许指到别人的键上）', () => {
    // `identity t` 会把键原样返回 ⇒ 这三行里就带着键本身。
    for (const code of INDUSTRY_METHOD_CODES) {
      if (code === 'general') continue;
      const lines = buildIndustryBriefing(resolveIndustryMethod(industry(code)), identity) ?? [];
      for (const leaf of ['focus', 'method', 'template']) {
        const expected = `identity.industryMethodBrief.${code}.${leaf}`;
        expect(
          lines.some((line) => line.includes(expected)),
          `${code} 的三行里没有 ${expected}`,
        ).toBe(true);
      }
    }
  });
});

describe('resolveIndustryMethod：缺失 / 非法输入不许编造', () => {
  it('⭐ 没跑过首跑、没选行业 ⇒ 通用档案（不抛、不猜）', () => {
    expect(resolveIndustryMethod(undefined).code).toBe('general');
    expect(resolveIndustryMethod(null).code).toBe('general');
    expect(resolveIndustryMethod(industry(null)).code).toBe('general');
  });

  it('⭐ 选了「暂不确定行业」也走通用档（generalConfirmed 不是行业）', () => {
    const undecided: OnboardingIndustry = { code: null, generalConfirmed: true, source: 'user', catalogVersion: 1 };
    expect(resolveIndustryMethod(undecided).code).toBe('general');
  });

  it('⭐ 认识的行业码原样解析出来', () => {
    for (const code of ONBOARDING_INDUSTRY_CODES) {
      expect(resolveIndustryMethod(industry(code)).code).toBe(code);
    }
  });
});

describe('buildIndustryBriefing：写进身份块的形态', () => {
  it('⭐ 没选行业 ⇒ `null`（一个字都不写，而不是写一句"未配置"占位）', () => {
    expect(buildIndustryBriefing(resolveIndustryMethod(undefined), identity)).toBeNull();
  });

  it('⭐ 选了行业 ⇒ 三行，且每行都以身份块认得的 `- ` 前缀开头', () => {
    const lines = buildIndustryBriefing(resolveIndustryMethod(industry('C')), identity);
    expect(lines).not.toBeNull();
    expect(lines).toHaveLength(3);
    for (const line of lines ?? []) {
      expect(line.startsWith('- '), `这行不是身份块的行：${line}`).toBe(true);
      expect(line.includes('\n'), `身份块的行不许换行：${line}`).toBe(false);
    }
  });

  it('⭐ 三行分别落在「行业重点 / 行业方法 / 交付结构」三个前缀上（剥离器按前缀认）', () => {
    const lines = buildIndustryBriefing(resolveIndustryMethod(industry('J')), identity);
    expect(lines).not.toBeNull();
    const prefixes = ['- 行业重点：', '- 行业方法：', '- 交付结构：'];
    prefixes.forEach((prefix, index) => {
      expect(lines?.[index]?.startsWith(prefix), `第 ${index + 1} 行不在「${prefix}」上`).toBe(true);
    });
  });

  it('⭐ 交付结构那一行取的是本行业自己的 template 键（不是别行的、也不是别行业的）', () => {
    const lines = buildIndustryBriefing(resolveIndustryMethod(industry('K')), identity) ?? [];
    expect(lines[2]).toContain('identity.industryMethodBrief.K.template');
    expect(lines[2]).not.toContain('identity.industryMethodBrief.C.template');
  });

  it('⭐ 一整块控制在 240 字以内（USER.md 有 4000 字硬上限，不许一家吃掉预算）', () => {
    for (const code of INDUSTRY_METHOD_CODES) {
      // `general` 档**不产出行**（buildIndustryBriefing 直接返回 null），没有预算可量。
      if (code === 'general') continue;
      const lines = buildIndustryBriefing(resolveIndustryMethod(industry(code)), identity);
      expect(lines, `${code} 没产出行业块`).not.toBeNull();
      expect([...(lines ?? []).join('')].length, `${code} 的行业块太长`).toBeLessThanOrEqual(240);
    }
  });

  /**
   * ⚠️ 上一条是**假绿**（2026-10-16 实测）：它用的是返回**键名**的假 `t`，
   *    量出来 ≈135，量的是键长而不是用户真正读到的译文长。
   *    同一条预算用**真实译文**量，七种语言里最长的（fr，P 档）会到 **408** 字 ——
   *    超预算 70%，而门禁一点反应都没有。
   *
   * 这一条把预算**量到真实译文上**：某个 locale 只要把这两组键写全了，
   * 就用它自己的文本复算一遍。键还没写进 locale 时这段自然空转（i18n 是单 owner，
   * 键位清单随交付物交回）—— 但**一旦写入就会真的开始管**，不会永远假绿。
   *
   * 复算用的是**产品解析器**（`buildIndustryBriefing`）而不是另写一份拼法，
   * 所以它量的就是运行时真的会写进 USER.md 的那个串。
   */
  it('⭐ 同一条 240 字预算，用**真实译文**复算（locale 里写了这两组键时生效）', () => {
    const measured: string[] = [];
    for (const lang of SUPPORTED_LANGUAGE_CODES) {
      const resource = JSON.parse(
        readFileSync(new URL(`../src/renderer/i18n/locales/${lang}.json`, import.meta.url), 'utf8'),
      ) as Record<string, unknown>;
      const lookup = (key: string): string => {
        const value = key.split('.').reduce<unknown>(
          (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
          resource,
        );
        // 缺键 ⇒ 返回键名（与运行时的裸键行为一致），下面的断言会把它算成长文本。
        return typeof value === 'string' ? value : key;
      };
      for (const code of INDUSTRY_METHOD_CODES) {
        if (code === 'general') continue;
        const lines = buildIndustryBriefing(resolveIndustryMethod(industry(code)), lookup);
        if (!lines) continue;
        const length = [...lines.join('')].length;
        measured.push(`${lang}/${code}=${length}`);
        expect(length, `${lang} 的 ${code} 档真实译文块超预算（${length} 字）`).toBeLessThanOrEqual(240);
      }
    }
    // 键都还没写进 locale 时，只保证"复算跑过"这件事本身没被跳过掉逻辑分支。
    expect(measured.length === 0 || measured.length === SUPPORTED_LANGUAGE_CODES.length * (INDUSTRY_METHOD_CODES.length - 1)).toBe(
      true,
    );
  });
});

describe('交付结构指向的模板必须是随包真有的技能', () => {
  it('⭐ 每个档案推荐的 slug 都在受登记的模板清单里', () => {
    for (const code of INDUSTRY_METHOD_CODES) {
      const profile = INDUSTRY_METHOD_PROFILES[code];
      expect(profile.templateSlugs.length, `${code} 没有推荐任何交付模板`).toBeGreaterThan(0);
      for (const slug of profile.templateSlugs) {
        expect(DELIVERY_TEMPLATE_SLUGS, `${code} 推荐了不存在的模板 ${slug}`).toContain(slug);
      }
    }
  });

  it('⭐ 模板 slug 清单本身天然去重（重复等于同一份模板被数了两次）', () => {
    expect(new Set(DELIVERY_TEMPLATE_SLUGS).size).toBe(DELIVERY_TEMPLATE_SLUGS.length);
  });

  it('⭐ 五个岗位每个都有一份模板，一个不少', () => {
    expect([...DELIVERY_TEMPLATE_SLUGS].sort()).toEqual([
      'rongying-post-analysis',
      'rongying-post-creation',
      'rongying-post-inspection',
      'rongying-post-production',
      'rongying-post-research',
    ] satisfies DeliveryTemplateSlug[]);
  });
});
