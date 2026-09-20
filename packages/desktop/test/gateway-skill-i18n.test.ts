import { describe, expect, it } from 'vitest';
import de from '../src/renderer/i18n/locales/de.json';
import en from '../src/renderer/i18n/locales/en.json';
import es from '../src/renderer/i18n/locales/es.json';
import fr from '../src/renderer/i18n/locales/fr.json';
import ja from '../src/renderer/i18n/locales/ja.json';
import ko from '../src/renderer/i18n/locales/ko.json';
import pt from '../src/renderer/i18n/locales/pt.json';
import zhTW from '../src/renderer/i18n/locales/zh-TW.json';
import zh from '../src/renderer/i18n/locales/zh.json';
import { COVERED_GATEWAY_SKILLS, GATEWAY_SKILL_DESCRIPTIONS } from '../src/renderer/lib/gateway-skill-label.js';

/**
 * 词表侧的守卫：**"键在"不等于"翻了"**。
 *
 * `check:i18n` 只保证 9 个语言包的**键集一致**，它不会发现
 * 「zh 的某个描述其实是英文原文」——那正好是这一页要消灭的东西。
 * 所以这里直接读词表文件：非英文语言**不许与英文原文一模一样**；
 * 中文（zh / zh-TW）必须**真的有汉字**；日/韩必须**真的有非 ASCII**；
 * 德/法/西/葡只整块要求（单个词条合法地可以是纯 ASCII，见下面那段）。
 */
const LOCALES: Record<string, Record<string, unknown>> = {
  de: de as Record<string, unknown>,
  en: en as Record<string, unknown>,
  es: es as Record<string, unknown>,
  fr: fr as Record<string, unknown>,
  ja: ja as Record<string, unknown>,
  ko: ko as Record<string, unknown>,
  pt: pt as Record<string, unknown>,
  'zh-TW': zhTW as Record<string, unknown>,
  zh: zh as Record<string, unknown>,
};

/** `python-debugpy` → `pythonDebugpy`（测试自己算，不跟实现共用一份）。 */
function camel(name: string): string {
  return name.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
}

function read(locale: Record<string, unknown>, key: string): string | undefined {
  const raw = key.split('.').reduce<unknown>((acc, part) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[part];
    return undefined;
  }, locale);
  return typeof raw === 'string' ? raw : undefined;
}

/** ⚠️ 不用正则写"非 ASCII"：`[^\x00-\x7F]` 那种写法在源码里会带进**真的控制字符**。 */
function isPureAscii(value: string): boolean {
  for (const ch of value) {
    if ((ch.codePointAt(0) ?? 0) > 0x7f) return false;
  }
  return true;
}

/** 只归一化空白（与实现同口径：YAML 折叠不该算改过）。 */
function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

const NON_EN = Object.keys(LOCALES).filter((code) => code !== 'en');

describe('gatewaySkill 词表 —— 键在每个语言包里都在', () => {
  it.each(Object.keys(LOCALES))('%s：18 组的 name/description 都是非空字符串', (code) => {
    const locale = LOCALES[code];
    for (const name of COVERED_GATEWAY_SKILLS) {
      for (const leaf of ['name', 'description'] as const) {
        const value = read(locale, `gatewaySkill.${camel(name)}.${leaf}`);
        expect(value, `${code} 缺 gatewaySkill.${camel(name)}.${leaf}`).toBeTypeOf('string');
        expect(value?.trim(), `${code} 的 gatewaySkill.${camel(name)}.${leaf} 是空的`).not.toBe('');
      }
    }
  });
});

describe('gatewaySkill 词表 —— 非英文语言**没有原样留英文**', () => {
  /**
   * ⚠️ 判据是「**与英文原文不同**」，不是「必须含非 ASCII」。
   *
   * 我第一版写的是后者，结果**假红**（2026-09-20 实测）：de 有 21/36、es 12/36、
   * pt 11/36、fr 7/36 条**本来就合法地是纯 ASCII** ——
   * `Tela`（pt 的画布）、`Clima`（pt 的天气）、`Criar diagramas`、
   * `Browser-Automatisierung`、`Adicionar provedor de modelos` ——
   * 这些是**正确**的译文，却在"必须含非 ASCII"下判红。
   * 用"不等于英文"当判据，8 个语种都成立，而且正好是这一页要消灭的东西。
   */
  it.each(NON_EN)('%s：36 条都不等于英文原文（没原样留英文）', (code) => {
    const locale = LOCALES[code];
    const sameAsEnglish: string[] = [];
    for (const name of COVERED_GATEWAY_SKILLS) {
      const c = camel(name);
      if (normalize(read(locale, `gatewaySkill.${c}.name`) ?? '') === normalize(name)) sameAsEnglish.push(`${c}.name`);
      if (
        normalize(read(locale, `gatewaySkill.${c}.description`) ?? '') === normalize(GATEWAY_SKILL_DESCRIPTIONS[name])
      )
        sameAsEnglish.push(`${c}.description`);
    }
    expect(sameAsEnglish, `${code} 里这些跟英文原文一模一样（=没翻）`).toEqual([]);
  });

  it.each(['zh', 'zh-TW'])('%s：36 条都含汉字', (code) => {
    const locale = LOCALES[code];
    const missingHan: string[] = [];
    for (const name of COVERED_GATEWAY_SKILLS) {
      for (const leaf of ['name', 'description'] as const) {
        const value = read(locale, `gatewaySkill.${camel(name)}.${leaf}`) ?? '';
        if (!/\p{Script=Han}/u.test(value)) missingHan.push(`${camel(name)}.${leaf}`);
      }
    }
    expect(missingHan, `${code} 里这些没有汉字`).toEqual([]);
  });

  // 日文（假名/汉字）与韩文（谚文）的书写系统**本身**就是非 ASCII ⇒ 逐条要求成立。
  it.each(['ja', 'ko'])('%s：36 条都含非 ASCII（这两个书写系统本身就非 ASCII）', (code) => {
    const locale = LOCALES[code];
    const stillEnglish: string[] = [];
    for (const name of COVERED_GATEWAY_SKILLS) {
      for (const leaf of ['name', 'description'] as const) {
        const value = read(locale, `gatewaySkill.${camel(name)}.${leaf}`) ?? '';
        if (isPureAscii(value)) stillEnglish.push(`${camel(name)}.${leaf}`);
      }
    }
    expect(stillEnglish, `${code} 里这些还是纯 ASCII（=没翻）`).toEqual([]);
  });

  /**
   * de / fr / es / pt 只能**整块**要求：单个词条合法地可以是纯 ASCII（见上）。
   * 这条挡的是"整块照抄英文、顺手改两个词"那种假翻译 —— 判据粗，但方向对。
   */
  it.each(['de', 'fr', 'es', 'pt'])('%s：整块至少有一条含非 ASCII（不是整块照抄英文）', (code) => {
    const locale = LOCALES[code];
    let accented = 0;
    for (const name of COVERED_GATEWAY_SKILLS) {
      for (const leaf of ['name', 'description'] as const) {
        if (!isPureAscii(read(locale, `gatewaySkill.${camel(name)}.${leaf}`) ?? '')) accented++;
      }
    }
    expect(accented, `${code} 整块 36 条一条非 ASCII 都没有`).toBeGreaterThan(0);
  });
});

describe('gatewaySkill 词表 —— 英文那一份**一个字都不改**', () => {
  it('⭐ en 的名字就是网关的标识符本身（英文界面与今天完全一样）', () => {
    for (const name of COVERED_GATEWAY_SKILLS) {
      expect(read(LOCALES.en, `gatewaySkill.${camel(name)}.name`), name).toBe(name);
    }
  });

  it('⭐ en 的描述就是**我们抄下来的那份原文**（不许在英文里改写）', () => {
    for (const name of COVERED_GATEWAY_SKILLS) {
      expect(read(LOCALES.en, `gatewaySkill.${camel(name)}.description`), name).toBe(GATEWAY_SKILL_DESCRIPTIONS[name]);
    }
  });
});
