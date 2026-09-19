import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RUN_PHASE_IDS } from '@clawwork/core';

/**
 * 网关给的那些 **id**，在**每个语言**里都得有文案。
 *
 * ## 为什么值得单独钉
 *
 * 这些 id 的**清单在别处**（`run_status` 的相位在 core 里；`errorKind` 在协议 schema 里），
 * 文案却在 9 个 locale 文件里 —— **两边分居**，中间没有东西连着。少一个语言的后果是：
 * 那个语言的用户看到的是**泛化兜底**、或者干脆是**英文原文**，而这种缺失
 * **在代码里看不出来**（`t()` 拿不到 key 时只是回退，不报错）。
 *
 * 两处都对着"用户正在难受"的时刻：
 * - **准备阶段**全发生在"还没有任何可见活动"的那段（用户抱怨的「卡住好久」）；
 * - **错误类别**是失败时唯一能给用户的那句话。
 *
 * ⚠️ 这个文件把**分居的两边**绑在一起：将来加相位/加类别忘了加文案，
 * 或者加了文案忘了加 id，这里都会红。
 */
const localeDir = join(__dirname, '../src/renderer/i18n/locales');

function localeJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(localeDir, file), 'utf8')) as Record<string, unknown>;
}

/** 取嵌套值（`errors.kind` 这种）。 */
function at(obj: unknown, path: string): Record<string, string> {
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (!cur || typeof cur !== 'object') return {};
    cur = (cur as Record<string, unknown>)[seg];
  }
  return (cur ?? {}) as Record<string, string>;
}

/**
 * 网关 `errorKind` 里**给了文案**的四个（协议闭集里还有 `unknown` ——
 * 那个**故意不给**：认不出就退回网关原文，宁可给英文也不要给一句错的中文）。
 */
const ERROR_KINDS_WITH_COPY = ['refusal', 'timeout', 'rate_limit', 'context_length'] as const;

describe('网关 id 的文案覆盖', () => {
  const locales = readdirSync(localeDir).filter((f) => f.endsWith('.json'));

  it('语言文件都在（少了这条，下面的遍历会变成空跑还照样绿）', () => {
    expect(locales.length, 'locale 目录下应有 9 个语言文件').toBe(9);
    expect(locales, '英文是基准，必须有').toContain('en.json');
  });

  it('两份 id 清单都非空（上游被清空时不该静默通过）', () => {
    expect(RUN_PHASE_IDS.length).toBe(7);
    expect(ERROR_KINDS_WITH_COPY.length).toBe(4);
  });

  it('⭐ 七个准备阶段在**每个**语言里都有文案，且**不是**泛化兜底那句', () => {
    for (const file of locales) {
      const runPhase = at(localeJson(file), 'chatInput.runPhase');
      const fallback = runPhase.unknown;

      for (const phase of RUN_PHASE_IDS) {
        const text = runPhase[phase];
        expect(text, `${file} 缺 chatInput.runPhase.${phase}`).toBeTypeOf('string');
        expect(text, `${file} 的 ${phase} 是空串`).toBeTruthy();
        expect(text, `${file} 的 ${phase} 直接抄了泛化兜底「${fallback}」⇒ 等于没加`).not.toBe(fallback);
      }
    }
  });

  it('七个准备阶段**互不相同**（两个阶段同一句话 = 用户照样看不出区别）', () => {
    for (const file of locales) {
      const runPhase = at(localeJson(file), 'chatInput.runPhase');
      const texts = RUN_PHASE_IDS.map((p) => runPhase[p]);
      expect(new Set(texts).size, `${file} 里有阶段共用同一句文案：${texts.join(' / ')}`).toBe(texts.length);
    }
  });

  it('⭐ 四个错误类别在**每个**语言里都有文案', () => {
    for (const file of locales) {
      const kind = at(localeJson(file), 'errors.kind');
      for (const k of ERROR_KINDS_WITH_COPY) {
        const text = kind[k];
        expect(text, `${file} 缺 errors.kind.${k}`).toBeTypeOf('string');
        expect(text, `${file} 的 errors.kind.${k} 是空串`).toBeTruthy();
      }
    }
  });

  it('四个错误类别**互不相同**，且**不给 `unknown` 写文案**', () => {
    for (const file of locales) {
      const kind = at(localeJson(file), 'errors.kind');
      const texts = ERROR_KINDS_WITH_COPY.map((k) => kind[k]);
      expect(new Set(texts).size, `${file} 里有类别共用同一句文案：${texts.join(' / ')}`).toBe(texts.length);
      // `unknown` 有文案 = 认不出也硬给一句，那就违背了"宁可给原文"
      expect(kind.unknown, `${file} 不该给 unknown 写文案（认不出要退回网关原文）`).toBeUndefined();
    }
  });
});
