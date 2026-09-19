import { describe, expect, it } from 'vitest';
import { buildAppError, formatErrorForToast, formatErrorForUser } from '../src/services/error-classify.js';

/** 最简 translator：取不到 key 时用 defaultValue，再不行就回 key 本身。 */
const t = (key: string, opts?: Record<string, unknown>): string => (opts?.defaultValue as string) ?? key;

/**
 * 把 `errors.kind.*` 换成可辨认的标记 —— 这里断言的是**选中了哪条 key**；
 * 真实文案由 desktop 那份「每个语言都得有这几条 key」的用例保证
 *（core 不该去读 desktop 的 locale）。
 */
const tMark = (key: string, opts?: Record<string, unknown>): string =>
  key.startsWith('errors.kind.') ? `«${key}»` : ((opts?.defaultValue as string) ?? key);

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

  it('⭐ 网关给了结构化 `errorKind` 时，按类别选文案（而不是把厂商英文原文摆给用户）', () => {
    // 实测（随包运行时 2026.9.3）：chat 错误帧带 `errorKind`，取值是协议里的闭集
    // `ChatEventErrorKindSchema` = refusal / timeout / rate_limit / context_length / unknown。
    // 我们此前**整块忽略它**，只能靠 message 措辞猜 —— 而各厂商措辞五花八门。
    for (const kind of ['rate_limit', 'timeout', 'context_length', 'refusal'] as const) {
      const err = buildAppError({
        source: 'upstream',
        stage: 'stream',
        rawMessage: 'RateLimitExceededError: upstream said no (provider-specific wording)',
        kind,
      });
      const text = formatErrorForUser(err, tMark);
      expect(text, `kind=${kind} 应当选到类别文案`).toContain(`errors.kind.${kind}`);
      expect(text, `kind=${kind} 不该把厂商英文原文摆给用户`).not.toContain('provider-specific wording');
    }
  });

  it('`unknown` / 没有 kind 时仍然透出原文（不许瞎猜）', () => {
    for (const kind of ['unknown', undefined]) {
      const err = buildAppError({
        source: 'upstream',
        stage: 'stream',
        rawMessage: 'SomeBrandNewProviderError: whatever',
        ...(kind ? { kind } : {}),
      });
      expect(formatErrorForUser(err, tMark)).toBe('stream: SomeBrandNewProviderError: whatever');
    }
  });

  it('具体的中文优先于类别中文（能认出的原文更准）', () => {
    const err = buildAppError({
      source: 'upstream',
      stage: 'stream',
      rawMessage: 'thinkingLevel "minimal" is not supported for clawrouter/deepseek-r1 (use off)',
      kind: 'rate_limit',
    });
    // 这条原文我们认得，给的比"请求过于频繁"具体得多 ⇒ 不许被类别盖掉
    expect(formatErrorForUser(err, tMark)).toContain('不支持');
  });

  it('⚠️ 某个语言漏了这条 key 时**不许把 key 本身摆给用户**（宁可退回原文）', () => {
    const missingKeyT = (key: string): string => key; // i18next 取不到 key 时的行为
    const err = buildAppError({
      source: 'upstream',
      stage: 'stream',
      rawMessage: 'RateLimitExceededError: upstream said no',
      kind: 'rate_limit',
    });
    const text = formatErrorForUser(err, missingKeyT);
    expect(text).not.toContain('errors.kind.');
    expect(text).toContain('upstream said no');
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

  it('类别文案也走 toast 那条路', () => {
    const err = buildAppError({
      source: 'upstream',
      stage: 'stream',
      rawMessage: 'RateLimitExceededError: upstream said no',
      kind: 'rate_limit',
    });
    expect(formatErrorForToast(err, tMark).description).toContain('errors.kind.rate_limit');
  });
});
