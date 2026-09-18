import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  WAITING_LINES_PER_BAND,
  WAITING_LINE_PREFIX_FOR_TESTS,
  WAITING_ROTATE_MS,
  formatElapsed,
  waitingBand,
  waitingLineSuffix,
} from '../src/renderer/lib/waiting-copy';

/**
 * 等待期的趣味文案 —— 用户要的是「像那样有点人情味」，但**不许承诺完成时间**。
 *
 * 为什么钉这么细：这段文案会出现在**每一次**等待里，而且用户会盯着它看。
 * 三件事必须确定：**分档边界**（越久越自嘲）、**轮播节奏**（不闪、不重复）、
 * **确定性**（同样的秒数必须给同一句 —— 否则每次 re-render 都换一句，像坏了）。
 */
describe('waitingBand —— 越等越自嘲的分档', () => {
  it('刚发出是 fresh', () => {
    expect(waitingBand(0)).toBe('fresh');
    expect(waitingBand(29_999)).toBe('fresh');
  });

  it('⭐ 30 秒进 long（这时该开始"还在忙"而不是"稍等"）', () => {
    expect(waitingBand(30_000)).toBe('long');
    expect(waitingBand(89_999)).toBe('long');
  });

  it('⭐ 90 秒进 veryLong（这时该自嘲，别硬撑）', () => {
    expect(waitingBand(90_000)).toBe('veryLong');
    expect(waitingBand(10 * 60_000)).toBe('veryLong');
  });

  it('负数/NaN 当成 0，不能算出怪 key', () => {
    expect(waitingBand(-1)).toBe('fresh');
    expect(waitingLineSuffix(Number.NaN)).toBe('fresh0');
  });
});

describe('waitingLineSuffix —— 轮播', () => {
  it('⭐ 同一个秒数永远给同一句（否则每次 re-render 都换，看着像坏了）', () => {
    const a = waitingLineSuffix(42_000);
    for (let i = 0; i < 20; i++) expect(waitingLineSuffix(42_000)).toBe(a);
  });

  it('⭐ 每 6 秒换一句，并在一档内循环', () => {
    const seen = new Set<string>();
    for (let i = 0; i < WAITING_LINES_PER_BAND; i++) {
      seen.add(waitingLineSuffix(i * WAITING_ROTATE_MS));
    }
    expect(seen.size).toBe(WAITING_LINES_PER_BAND);
    // 转满一圈回到第一句
    expect(waitingLineSuffix(WAITING_LINES_PER_BAND * WAITING_ROTATE_MS)).toBe(waitingLineSuffix(0));
  });

  it('后缀是纯后缀（前缀必须留给调用方写在 t() 的模板串里，扫描器才看得见）', () => {
    for (const ms of [0, 5_000, 30_000, 60_000, 90_000, 200_000]) {
      expect(waitingLineSuffix(ms)).toMatch(/^(fresh|long|veryLong)\d$/);
    }
  });

  it('跨档时换成那一档的句子（不是接着上一档轮）', () => {
    expect(waitingLineSuffix(30_000)).toContain('long');
    expect(waitingLineSuffix(30_000)).not.toContain('fresh');
    expect(waitingLineSuffix(90_000)).toContain('veryLong');
  });
});

/**
 * ⭐ 把"函数产出的 key"和"locale 里真有这条 key"对上。
 *
 * 这条是**真被我漏过一次**才补的：函数当时产出 `chat.waiting.line.*`，
 * 而文案被我写在了 `chatInput.waiting.line.*` —— i18next 找不到 key 时**不报错**，
 * 界面上直接显示这串 key 本身。用户看到的就是 `chatInput.waiting.line.fresh0`。
 *
 * 所以断言必须落在**真实的 locale 文件**上，不能只对着函数自己的输出打转。
 */
describe('产出的 key 必须真的存在于 9 个 locale 里', () => {
  const localesDir = path.join(__dirname, '..', 'src', 'renderer', 'i18n', 'locales');
  const localeFiles = fs.readdirSync(localesDir).filter((f) => f.endsWith('.json'));

  /** 把 i18next 的点号路径取出来（`a.b.c` → json.a.b.c）。 */
  const lookup = (json: unknown, key: string): unknown =>
    key
      .split('.')
      .reduce<unknown>(
        (acc, part) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[part] : undefined),
        json,
      );

  // 三档 × 每档句数 × 轮播位置，全部要能在 locale 里查到
  const allElapsed = [0, 5_000, 30_000, 60_000, 90_000, 200_000];

  it('9 个语言文件都在', () => {
    expect(localeFiles.length).toBeGreaterThanOrEqual(9);
  });

  for (const file of localeFiles) {
    it(`${file}：每条轮播文案都在，且不是空串`, () => {
      const json: unknown = JSON.parse(fs.readFileSync(path.join(localesDir, file), 'utf-8'));
      for (const ms of allElapsed) {
        const key = `${WAITING_LINE_PREFIX_FOR_TESTS}${waitingLineSuffix(ms)}`;
        const value = lookup(json, key);
        expect(value, `${file} 缺 ${key}`).toBeTypeOf('string');
        expect(String(value).trim().length, `${file} 的 ${key} 是空的`).toBeGreaterThan(0);
      }
      // 主行三条也在
      for (const k of ['chatInput.waiting.working', 'chatInput.waiting.runningTool', 'chatInput.waiting.writing']) {
        expect(lookup(json, k), `${file} 缺 ${k}`).toBeTypeOf('string');
      }
    });
  }

  it('前缀本身也对得上（改前缀就得同时改 9 个 locale）', () => {
    for (const file of localeFiles) {
      const json: unknown = JSON.parse(fs.readFileSync(path.join(localesDir, file), 'utf-8'));
      expect(lookup(json, `${WAITING_LINE_PREFIX_FOR_TESTS}fresh0`), `${file} 的前缀对不上`).toBeTypeOf('string');
    }
  });
});

describe('formatElapsed —— 那个"一直在走的秒数"', () => {
  // 格式就是方案预览里给用户看过并认可的那种：`1.2s` / `12.4s` / `143.7s`，不换算成 mm:ss。
  it('一位小数 + s', () => {
    expect(formatElapsed(0)).toBe('0.0s');
    expect(formatElapsed(1_200)).toBe('1.2s');
    expect(formatElapsed(12_400)).toBe('12.4s');
    expect(formatElapsed(78_140)).toBe('78.1s');
    expect(formatElapsed(143_700)).toBe('143.7s');
  });

  it('负数/NaN 不当成有效读数', () => {
    expect(formatElapsed(Number.NaN)).toBe('0.0s');
    expect(formatElapsed(-500)).toBe('0.0s');
  });
});
