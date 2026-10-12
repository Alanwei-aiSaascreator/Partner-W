import { describe, expect, it } from 'vitest';
import type { VideogenFailure } from '@clawwork/shared';
import { videogenFailureMessage, videogenFailureToastBody } from '../src/renderer/lib/videogen-failure-copy.js';

/**
 * 视频失败文案映射（2026-10-12 视频接入）。
 *
 * 与 htmlgen/docgen 的 copy 测试同款：`t` 打桩回显 key（+ 参数），逐码断言**映射形状**
 * （哪个码 → 哪个 key、参数有没有带对）。真句子的正确性由 i18n 门禁 + 九语言值把关。
 *
 * ⚠️ 两类**方向不能错**的映射在这里单独钉：
 *  · 内容安全拦截 → 说"换描述"，**不是**"稍后重试"；
 *  · 402 → 说"积分不足"，**不是**"服务不可用"。
 */

const t = (key: string, options?: Record<string, unknown>): string =>
  options ? `${key}|${JSON.stringify(options)}` : key;

const CASES: Array<[VideogenFailure, string]> = [
  [{ code: 'videogen-block-invalid' }, 'videogen.blockInvalid'],
  [{ code: 'videogen-prompt-missing' }, 'videogen.promptMissing'],
  [{ code: 'videogen-prompt-too-long', maxChars: 7000 }, 'videogen.promptTooLong|{"maxChars":7000}'],
  [{ code: 'videogen-duration-invalid', min: 4, max: 15 }, 'videogen.durationInvalid|{"min":4,"max":15}'],
  [
    { code: 'videogen-resolution-invalid', allowed: ['768P', '2K'] },
    'videogen.resolutionInvalid|{"allowed":"768P / 2K"}',
  ],
  [
    { code: 'videogen-aspect-invalid', allowed: ['16:9', '9:16'], value: '16:10' },
    'videogen.aspectInvalid|{"value":"16:10","allowed":"16:9 / 9:16"}',
  ],
  [{ code: 'videogen-unsupported-field', field: 'imageUrl' }, 'videogen.unsupportedField|{"field":"imageUrl"}'],
  [{ code: 'videogen-not-configured' }, 'videogen.notConfigured'],
  [{ code: 'videogen-create-failed', httpStatus: 0 }, 'videogen.createFailedNetwork'],
  [{ code: 'videogen-create-failed', httpStatus: 402 }, 'videogen.insufficientBalance'],
  [{ code: 'videogen-create-failed', httpStatus: 503 }, 'videogen.createFailedStatus|{"status":503}'],
  [{ code: 'videogen-content-rejected' }, 'videogen.contentRejected'],
  [{ code: 'videogen-task-failed', upstreamCode: 70001 }, 'videogen.taskFailed'],
  [{ code: 'videogen-timeout', waitedMs: 60_000 }, 'videogen.timeout'],
  [{ code: 'videogen-download-failed' }, 'videogen.downloadFailed'],
  [{ code: 'videogen-save-failed' }, 'videogen.saveFailed'],
];

describe('videogenFailureMessage（逐码映射）', () => {
  it.each(CASES)('%j → %s', (failure, expected) => {
    expect(videogenFailureMessage(failure, t)).toBe(expected);
  });
});

describe('videogenFailureToastBody（聚合）', () => {
  it('单条 ⇒ 原文；多条 ⇒ 首条 + 计数行', () => {
    expect(videogenFailureToastBody([{ code: 'videogen-timeout', waitedMs: 1 }], t)).toBe('videogen.timeout');
    const body = videogenFailureToastBody(
      [{ code: 'videogen-timeout', waitedMs: 1 }, { code: 'videogen-download-failed' }],
      t,
    );
    expect(body).toBe('videogen.timeout\nvideogen.moreFailures|{"rest":1}');
  });

  it('空集 ⇒ 空串（不发无内容的 toast）', () => {
    expect(videogenFailureToastBody([], t)).toBe('');
  });
});
