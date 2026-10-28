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

/**
 * `retryable` —— 它此前是个**死字段**：`classifyRetryable()` 算了它，全仓没有任何地方读；
 * 而在这条路上（chat 错误帧）它还**恒为 `'unknown'`**，因为判断只认 `code`，
 * 而 chat 帧里**根本没有** `code`（协议 schema 里只有 `errorKind`）。
 *
 * ⇒ 接上两件事：①用 `errorKind` 判类别；②（见 `retry-turn` / UI）让界面真的读它。
 *
 * 拍板口径（2026-09-19）：`rate_limit` / `timeout` 可重试；`refusal` / `context_length` 不可。
 */
describe('retryable —— 用结构化 kind 判，不再恒为 unknown', () => {
  const retryableOf = (opts: { code?: string; kind?: string }): string =>
    buildAppError({ source: 'upstream', stage: 'stream', rawMessage: 'x', ...opts }).retryable;

  it('⭐ chat 那条路上没有 code，只有 kind —— 它必须能判出"可以重试"', () => {
    // 这条就是队列第 10 项说的"永远是 unknown"：只给 kind，老实现返回 unknown。
    for (const kind of ['rate_limit', 'timeout']) {
      expect(retryableOf({ kind }), `kind=${kind} 应当可以重试`).toBe('yes');
    }
  });

  it('⭐ 结构性不可能靠重试解决的（模型拒答 / 上下文超长）判**不可**重试', () => {
    // 这两类重发同一句话只会再失败一次 —— 给按钮等于劝用户白花一次钱
    for (const kind of ['refusal', 'context_length']) {
      expect(retryableOf({ kind }), `kind=${kind} 不该给重试入口`).toBe('no');
    }
  });

  it('认不出的 kind / 没有 kind ⇒ unknown（既不劝重试，也不装作知道）', () => {
    for (const kind of ['unknown', undefined]) {
      expect(retryableOf(kind ? { kind } : {})).toBe('unknown');
    }
  });

  it('code 与 kind 都给时**以 code 为准**（它更具体）', () => {
    // 网关说"请求太频繁"，但我们认得这个码、且它躺在不可重试表里 ⇒ 听码的
    expect(retryableOf({ code: 'QUOTA_EXHAUSTED', kind: 'rate_limit' })).toBe('no');
    expect(retryableOf({ code: 'RATE_LIMIT', kind: 'refusal' })).toBe('yes');
  });

  it('code 认不出时**不许早退成 unknown** —— 还有 kind 可用', () => {
    expect(retryableOf({ code: 'SOME_PROVIDER_SPECIFIC_CODE', kind: 'rate_limit' })).toBe('yes');
    expect(retryableOf({ code: 'SOME_PROVIDER_SPECIFIC_CODE' })).toBe('unknown');
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

/**
 * BUG-077（2026-10-14 真实用户 1.0.6 现场，截图「推流: LLM request failed: provider rejected
 * the request schema or tool payload.」）：这句运行时英文包装话此前**没有任何识别器**，
 * 于是整句原文上屏。
 *
 * 修法（审计要求的窄匹配）：对**确切措辞**做识别 → 返回 i18n key → 走统一 `t()`；
 * 九语言真实文案由 desktop 的 `gateway-copy-coverage.test.ts` 钉住。
 *
 * 这里同时钉三条**不许回退**的性质：
 *  ① 既有明确类别（限流/超时/拒绝/上下文）的文案照旧先行 —— 泛化包装文案不许盖过它们；
 *  ② 未知错误照旧透出原文（这条新映射不许把 unknown 一起吞掉）；
 *  ③ `rawMessage`/`code`/`kind` 与诊断关联证据不删（展示层只读不改）。
 */
describe('BUG-077：已知英文包装句 → 九语言产品文案（优先级与原文保留）', () => {
  const RAW = 'LLM request failed: provider rejected the request schema or tool payload.';
  const KEY = 'errors.wrapper.providerRequestRejected';

  /** 把 wrapper/kind 两类 key 换成可辨认标记 —— 断言的仍是"选中了哪条 key"。 */
  const tMark2 = (key: string, opts?: Record<string, unknown>): string =>
    key.startsWith('errors.wrapper.') || key.startsWith('errors.kind.')
      ? `«${key}»`
      : ((opts?.defaultValue as string) ?? key);

  it('⭐ 无 kind 的原句 ⇒ 选到产品化 key，英文原文不再上屏', () => {
    const err = buildAppError({ source: 'upstream', stage: 'stream', rawMessage: RAW });
    const text = formatErrorForUser(err, tMark2);
    expect(text).toContain(KEY);
    expect(text, '英文原文不许再摆给用户').not.toContain('provider rejected');
  });

  it('⭐ 带「推流: 」前缀的形态同样产品化', () => {
    const err = buildAppError({ source: 'upstream', stage: 'stream', rawMessage: `推流: ${RAW}` });
    const text = formatErrorForUser(err, tMark2);
    expect(text).toContain(KEY);
    expect(text).not.toContain('provider rejected');
  });

  it('⭐ 既有明确类别优先级不回退（限流/超时/拒绝/上下文照旧先行）', () => {
    for (const kind of ['rate_limit', 'timeout', 'refusal', 'context_length'] as const) {
      const err = buildAppError({ source: 'upstream', stage: 'stream', rawMessage: RAW, kind });
      const text = formatErrorForUser(err, tMark2);
      expect(text, `kind=${kind} 应当继续选类别文案`).toContain(`errors.kind.${kind}`);
      expect(text, `kind=${kind} 不该被泛化包装文案盖掉`).not.toContain(KEY);
    }
  });

  it('⭐ kind=unknown 不挡包装句映射（真实帧多半就是 unknown），且字段不被展示层删改', () => {
    const err = buildAppError({
      source: 'upstream',
      stage: 'stream',
      rawMessage: RAW,
      kind: 'unknown',
      code: 'UPSTREAM_REJECTED',
    });
    // `unknown` 不在类别表里（认不出就退回原文）—— 但包装句比它具体，必须接上
    expect(formatErrorForUser(err, tMark2)).toContain(KEY);
    // 诊断与安全关联证据保留：展示层只读不改
    expect(err.rawMessage).toBe(RAW);
    expect(err.kind).toBe('unknown');
    expect(err.code).toBe('UPSTREAM_REJECTED');
  });

  it('某语言漏了这条 key ⇒ 退回原文（不许把 key 本身摆给用户）', () => {
    const missingKeyT = (key: string): string => key; // i18next 取不到 key 时的行为
    const err = buildAppError({ source: 'upstream', stage: 'stream', rawMessage: RAW });
    const text = formatErrorForUser(err, missingKeyT);
    expect(text).not.toContain('errors.wrapper.');
    expect(text).toContain('provider rejected');
  });

  it('未知错误仍然透出原文（不因这条新映射把 unknown 一起吞掉）', () => {
    const err = buildAppError({
      source: 'upstream',
      stage: 'stream',
      rawMessage: 'SomeBrandNewProviderError: whatever',
    });
    expect(formatErrorForUser(err, tMark2)).toBe('stream: SomeBrandNewProviderError: whatever');
  });

  it('toast 描述同样走这条路（它共用 displayMessage）', () => {
    const err = buildAppError({ source: 'upstream', stage: 'stream', rawMessage: RAW });
    const { description } = formatErrorForToast(err, tMark2);
    expect(description).toContain(KEY);
    expect(description).not.toContain('provider rejected');
  });
});
