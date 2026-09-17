import { describe, expect, it } from 'vitest';
import { buildAppError, formatErrorForToast, formatErrorForUser } from '../src/services/error-classify.js';

/** 最简 translator：取不到 key 时用 defaultValue，再不行就回 key 本身。 */
const t = (key: string, opts?: Record<string, unknown>): string => (opts?.defaultValue as string) ?? key;

describe('formatErrorForUser —— 已知网关错误给中文，未知保留原文', () => {
  it('提问答案没给全时不再暴露内部字段名', () => {
    // 2026-09-17 实机：这句话被原样写进聊天记录，用户看到的就是 `doc_type`
    const err = buildAppError({
      source: 'upstream',
      stage: 'stream',
      rawMessage: "GatewayClientRequestError: question 'doc_type' requires an answer",
    });
    const text = formatErrorForUser(err, t);
    expect(text).toContain('还有必答的问题没有选择');
    expect(text).not.toContain('doc_type');
    expect(text).not.toContain('GatewayClientRequestError');
  });

  it('未知错误仍然透出网关原文 —— 原文比我们编的话准', () => {
    const err = buildAppError({ source: 'upstream', stage: 'stream', rawMessage: 'ERR_UPSTREAM_QUOTA_EXCEEDED' });
    expect(formatErrorForUser(err, t)).toBe('stream: ERR_UPSTREAM_QUOTA_EXCEEDED');
  });
});

describe('formatErrorForToast', () => {
  it('描述字段同样走翻译', () => {
    const err = buildAppError({
      source: 'upstream',
      stage: 'stream',
      rawMessage: "question 'doc_type' contains an empty answer",
    });
    const { description } = formatErrorForToast(err, t);
    // 这里没有 question 上下文，只能是通用中文（带 header 的具体提示在问题卡片里）
    expect(description).toBe('有问题的答案为空，请重新选择。');
    expect(description).not.toContain('doc_type');
  });
});
