import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { UNSUPPORTED_CAPABILITY_COPY_KEY, UNSUPPORTED_MODEL_COPY_KEY } from '@clawwork/core';

/**
 * BUG-043 · 「当前暂不支持该模型/能力」的产品文案（9 语言）。
 *
 * 键的**单一真源**在 `@clawwork/core` 的两个常量里（能力边界的请求前置识别返回它们）——
 * 这条用例就是"常量 → 词表"的连线：键改错一个字，i18n 门禁与这条断言都会响。
 * ⚠️ 键必须出现在**被扫描的源码**里（core 的常量即引用点），否则 `check:i18n`
 *    的 unused-key 方向会判它是死键。
 */
const LOCALE_DIR = path.join(__dirname, '../src/renderer/i18n/locales');
const LANGUAGES = ['zh', 'zh-TW', 'en', 'ja', 'ko', 'de', 'es', 'fr', 'pt'] as const;

function readLocale(lang: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(LOCALE_DIR, `${lang}.json`), 'utf-8')) as Record<string, unknown>;
}

function readKey(lang: string, key: string): unknown {
  return key.split('.').reduce<unknown>((node, segment) => {
    if (!node || typeof node !== 'object') return undefined;
    return (node as Record<string, unknown>)[segment];
  }, readLocale(lang));
}

describe('「当前暂不支持」文案（9 语言键）', () => {
  it('9 个语言文件都有这两个键，且都是非空字符串', () => {
    for (const lang of LANGUAGES) {
      for (const key of [UNSUPPORTED_MODEL_COPY_KEY, UNSUPPORTED_CAPABILITY_COPY_KEY]) {
        const value = readKey(lang, key);
        expect(typeof value, `${lang}:${key}`).toBe('string');
        expect((value as string).trim().length, `${lang}:${key}`).toBeGreaterThan(0);
      }
    }
  });

  it('中文是规范句「当前暂不支持该模型/能力」，且不许出现占位符/默认值', () => {
    expect(readKey('zh', UNSUPPORTED_MODEL_COPY_KEY)).toContain('当前暂不支持该模型');
    expect(readKey('zh', UNSUPPORTED_CAPABILITY_COPY_KEY)).toContain('当前暂不支持该能力');
    for (const lang of LANGUAGES) {
      for (const key of [UNSUPPORTED_MODEL_COPY_KEY, UNSUPPORTED_CAPABILITY_COPY_KEY]) {
        const value = String(readKey(lang, key));
        expect(value, `${lang}:${key} 不许留插值/占位`).not.toMatch(/TODO|\{\{|\$\{/u);
      }
    }
  });

  it('两条文案的键名不同（模型 vs 能力，别并成一条）', () => {
    expect(UNSUPPORTED_MODEL_COPY_KEY).not.toBe(UNSUPPORTED_CAPABILITY_COPY_KEY);
  });
});
