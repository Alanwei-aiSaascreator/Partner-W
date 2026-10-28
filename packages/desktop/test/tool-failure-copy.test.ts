import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SUPPORTED_LANGUAGE_CODES } from '@clawwork/shared';
import { describe, expect, it } from 'vitest';

/**
 * BUG-026（2026-10-06 B 组）：失败展示的两条新文案 —— 9 语言词条与中文原话逐字钉住。
 *
 * `check:i18n` 管的是键位对等/未用键；这条钉的是**文案本身**
 * （产品要求逐字给出，改一个字就该有人解释为什么）。
 */
const LOCALES = join(__dirname, '..', 'src', 'renderer', 'i18n', 'locales');

type Json = Record<string, unknown>;

function locale(code: string): Json {
  return JSON.parse(readFileSync(join(LOCALES, `${code}.json`), 'utf-8')) as Json;
}

function value(code: string, path: string): unknown {
  return path.split('.').reduce<unknown>((node, key) => {
    if (node && typeof node === 'object') return (node as Json)[key];
    return undefined;
  }, locale(code));
}

const REQUIRED_COPY: Array<[string, string]> = [
  /*
    ⚠️ 2026-10-07（区1 体检 P2-4）：这两条原来是**空承诺** ——
    「继续使用已有资料」点了只降级重渲、不发起任何后续，紧接着那句
    「已基于现有资料继续处理」声称一件没发生的事（用户会等一个不会来的答复）。
    改成中性/过去式：跳过了就说跳过了，能做的是"继续提问"。
  */
  ['toolActivity.failure.degradedContinue', '这一步已跳过，可以继续提问。'],
  ['toolActivity.failure.cannotContinue', '这一步暂时无法完成。'],
  ['toolActivity.failure.retryAction', '重新尝试'],
  ['toolActivity.failure.continueWithMaterials', '跳过这个失败'],
  /*
    ⚠️ P2-4 追加（Lead 批准）：这条原来是「联网资料暂时不可用，**本轮将基于已有资料继续**」——
    一句将来时承诺。工具失败那一刻我们**不知道**这一轮会不会继续（模型可能就此收尾，也可能报错）；
    改成纯事实 + 可执行建议（"可重试"是建议，不是声称已经发生的事）。
  */
  ['toolActivity.failure.network', '联网资料暂时不可用，可重试'],
  // 第三态「未收到结果」（区1 体检 P1-1/P1-2）：没收到结果就是没收到，不写成失败、也不替它下结论。
  ['toolActivity.noResult', '这一步没有返回结果。'],
  ['toolActivity.unreported', '{{count}} 个步骤没有返回结果'],
  // 详情区的错误类别（区1 体检 P2-5）：给"清洗后原文"补一句人话，认不出的形态不编。
  ['toolActivity.failureClass.network', '错误类别：网络不可用'],
  ['toolActivity.failureClass.rateLimit', '错误类别：请求过于频繁'],
  ['toolActivity.failureClass.timeout', '错误类别：等待超时'],
  // 失败记录的跳转入口（区1 体检 P3-12）。
  ['chatInput.deliveryHistory.jumpToMessage', '回到这条消息'],
];

describe('BUG-026 失败文案（9 语言）', () => {
  it.each(REQUIRED_COPY)('zh 词条 %s 逐字一致', (path, expected) => {
    expect(value('zh', path)).toBe(expected);
  });

  it.each([...SUPPORTED_LANGUAGE_CODES])('%s 语两种失败文案都在且非空', (code) => {
    for (const [path] of REQUIRED_COPY) {
      const text = value(code, path);
      expect(typeof text, `${code} 缺 ${path}`).toBe('string');
      expect((text as string).trim().length, `${code} 的 ${path} 为空`).toBeGreaterThan(0);
    }
  });

  it.each([['toolActivity.repeatedFailure'], ['toolActivity.unreported']])(
    '%s 在 9 语言都在，且带 {{count}} 占位符',
    (path) => {
      for (const code of SUPPORTED_LANGUAGE_CODES) {
        const text = value(code, path) as string;
        expect(typeof text, `${code} 缺 ${path}`).toBe('string');
        expect(text, `${code} 缺 {{count}} 占位符`).toContain('{{count}}');
      }
    },
  );
});
