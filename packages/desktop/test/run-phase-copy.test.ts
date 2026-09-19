import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RUN_PHASE_IDS } from '@clawwork/core';

/**
 * 网关的七个准备阶段，**每个语言都得有说法**。
 *
 * ## 为什么值得单独钉
 *
 * `RUN_PHASE_IDS` 在 core 里（网关会发哪些阶段），文案在 9 个 locale 文件里 ——
 * **两边分居**，中间没有东西连着。少一个语言的后果是：那个语言的用户看到的
 * 就是我们最不想要的那句泛化「正在准备…」，而这种缺失**在代码里看不出来**
 * （`t()` 拿不到 key 时只是回退，不报错）。
 *
 * 这七个阶段全都发生在"还没有任何可见活动"的那段（见 core 里 `RUN_STARTUP_PHASES`
 * 的 docblock）—— 正是用户抱怨「卡住好久突然跳出来」的那段死时间，
 * 泛化文案在这里的损失最大。
 *
 * ⚠️ 这个文件**同时**把两件事绑在一起：core 的阶段清单，和 9 个 locale 文件。
 * 将来加相位忘了加文案，或者加文案忘了加相位，这里都会红。
 */
const localeDir = join(__dirname, '../src/renderer/i18n/locales');

function runPhaseOf(file: string): Record<string, string> {
  const json = JSON.parse(readFileSync(join(localeDir, file), 'utf8')) as {
    chatInput?: { runPhase?: Record<string, string> };
  };
  return json.chatInput?.runPhase ?? {};
}

describe('run_status 阶段的文案覆盖', () => {
  const locales = readdirSync(localeDir).filter((f) => f.endsWith('.json'));

  it('语言文件都在（少了这条，下面的遍历会变成空跑还照样绿）', () => {
    expect(locales.length, 'locale 目录下应有 9 个语言文件').toBe(9);
    expect(locales, '英文是基准，必须有').toContain('en.json');
  });

  it('阶段清单非空（core 那边被清空时不该静默通过）', () => {
    expect(RUN_PHASE_IDS.length).toBe(7);
  });

  it('⭐ 七个阶段在**每个**语言里都有文案，且**不是**泛化兜底那句', () => {
    for (const file of locales) {
      const runPhase = runPhaseOf(file);
      const fallback = runPhase.unknown;

      for (const phase of RUN_PHASE_IDS) {
        const text = runPhase[phase];
        expect(text, `${file} 缺 chatInput.runPhase.${phase}`).toBeTypeOf('string');
        expect(text, `${file} 的 ${phase} 是空串`).toBeTruthy();
        expect(text, `${file} 的 ${phase} 直接抄了泛化兜底「${fallback}」⇒ 等于没加`).not.toBe(fallback);
      }
    }
  });

  it('七个阶段**互不相同**（两个阶段同一句话 = 用户照样看不出区别）', () => {
    for (const file of locales) {
      const runPhase = runPhaseOf(file);
      const texts = RUN_PHASE_IDS.map((p) => runPhase[p]);
      expect(new Set(texts).size, `${file} 里有阶段共用同一句文案：${texts.join(' / ')}`).toBe(texts.length);
    }
  });
});
