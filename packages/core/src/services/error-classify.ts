import type { AppError, ErrorSource, ErrorStage, Retryable } from '@clawwork/shared';
import { RETRYABLE_ERROR_CODES, NON_RETRYABLE_ERROR_CODES } from '@clawwork/shared';
import { translateGatewayError, translateGatewayErrorKey } from './gateway-error-message.js';

/**
 * 网关的**结构化**错误类别 → 能不能重试（拍板口径 2026-09-19）。
 *
 * ⚠️ 这张表是必需的，不是锦上添花：chat 错误帧里**没有 `code`**（协议 schema 只有
 *    `errorKind`），所以在那条路上"按 code 判"永远判不出东西 —— 这正是 `retryable`
 *    长期恒为 `'unknown'` 的原因。
 *
 * `refusal` / `context_length` 判**不可**：重发同一句话只会再失败一次，
 * 给了按钮等于劝用户白花一次钱。`unknown` 故意不在表里 —— 认不出就别替用户下结论。
 */
const KIND_RETRYABLE: Record<string, Retryable> = {
  rate_limit: 'yes',
  timeout: 'yes',
  refusal: 'no',
  context_length: 'no',
};

/**
 * `code` 优先（它更具体），认不出再落到 `kind`。
 *
 * ⚠️ 认不出的 `code` **不能**早退成 `'unknown'` —— 那会把 `kind` 里现成的信息丢掉
 *    （网关换一个码的写法就会让判断失效，而 `kind` 是协议里的闭集，稳定得多）。
 */
function classifyRetryable(code?: string, kind?: string): Retryable {
  if (code) {
    if (RETRYABLE_ERROR_CODES.has(code)) return 'yes';
    if (NON_RETRYABLE_ERROR_CODES.has(code)) return 'no';
  }
  const byKind = kind ? KIND_RETRYABLE[kind] : undefined;
  return byKind ?? 'unknown';
}

export function buildAppError(opts: {
  source: ErrorSource;
  stage: ErrorStage;
  rawMessage: string;
  code?: string;
  /** 网关给的结构化类别（chat 错误帧的 `errorKind`）；`unknown` 与缺省同义。 */
  kind?: string;
  details?: Record<string, unknown>;
}): AppError {
  return {
    source: opts.source,
    stage: opts.stage,
    code: opts.code,
    kind: opts.kind,
    rawMessage: opts.rawMessage,
    details: opts.details,
    retryable: classifyRetryable(opts.code, opts.kind),
  };
}

export type TranslateFn = (key: string, opts?: Record<string, unknown>) => string;

/**
 * 网关的**结构化**错误类别 → 文案 key。
 *
 * 为什么要有这一层：`translateGatewayError` 是**按 message 字符串**匹配的，
 * 那个文件自己就写着「契约并不稳定，网关改一个字就失效」，还写着
 * 「正解是与网关约定错误码…届时本表应改写成『错误码 → 文案』」。
 * ⇒ **那个"正解"其实已经存在了**：chat 错误帧带 `errorKind`（协议里的闭集枚举，
 * 有 validator），我们此前整块忽略。
 *
 * ⚠️ 只列**语义确定**的四个；`unknown` 故意不在表里 —— 认不出就退回原文，
 *    宁可给英文也不要给一句错的中文（与 `gateway-error-message.ts` 同一条纪律）。
 */
const ERROR_KIND_KEYS: Record<string, string> = {
  refusal: 'errors.kind.refusal',
  timeout: 'errors.kind.timeout',
  rate_limit: 'errors.kind.rate_limit',
  context_length: 'errors.kind.context_length',
};

/**
 * 展示前先过一层翻译：已知的网关错误给中文，未知的**保留原文**（原文比我们编的话准）。
 *
 * 顺序是刻意的：**能认出的原文**（更具体）> **结构化类别**（一定正确但较泛）
 * > **已知英文包装句**（按 key 走九语言产品文案，BUG-077）> **原文**。
 * ⚠️ 包装句排在类别**之后**：限流/超时/拒绝/上下文这类明确类别照旧先行，
 *    泛化包装文案不许盖过它们。
 * ⚠️ 最后那一步不能少：类别/包装句有条目但**这个语言没这条 key** 时（i18next 会把 key
 *    原样返回），绝不能把 `errors.kind.rate_limit` 这种东西摆到用户脸上 —— 退回原文。
 *
 * ⚠️ 2026-09-17 之前这一层没接上，`formatErrorForUser` 只是把原文拼到前缀后面，
 *    所以 `GatewayClientRequestError: question 'doc_type' requires an answer`
 *    被原样写进聊天记录 —— 用户既看不懂，还看到了内部字段名。翻译器一直写在那儿，
 *    却只有斜杠命令那条路在用。现在两条路都走同一个入口。
 */
function displayMessage(err: AppError, t: TranslateFn): string | undefined {
  if (err.rawMessage) {
    const byText = translateGatewayError(err.rawMessage);
    if (byText) return byText;
  }

  const key = err.kind ? ERROR_KIND_KEYS[err.kind] : undefined;
  if (key) {
    const byKind = t(key);
    // 取不到翻译时 i18next 原样返回 key —— 那种情况下用它还不如给原文
    if (byKind && byKind !== key) return byKind;
  }

  // ⭐ BUG-077（2026-10-14 真实用户 1.0.6）：运行时把"上游判请求不合法"统一成一句英文
  //    包装话（`LLM request failed: provider rejected the request schema or tool payload.`），
  //    此前它没有任何识别器 ⇒ 整句原文上屏。这里对**确切措辞**做窄匹配 → 返回 i18n key
  //    → 走统一 `t()` 拿九语言产品文案（文案不在代码里硬塞）。
  const wrapperKey = err.rawMessage ? translateGatewayErrorKey(err.rawMessage) : null;
  if (wrapperKey) {
    const byWrapper = t(wrapperKey);
    // 纪律同 kind：这个语言没这条 key 时退回原文，不许把 key 本身摆给用户
    if (byWrapper && byWrapper !== wrapperKey) return byWrapper;
  }

  return err.rawMessage || undefined;
}

export function formatErrorForUser(err: AppError, t: TranslateFn): string {
  const stageLabel = t(`errors.stage.${err.stage}`, { defaultValue: err.stage });
  const message = displayMessage(err, t);
  if (message) return `${stageLabel}: ${message}`;
  if (err.code) return `${stageLabel}: [${err.code}]`;
  return `${stageLabel}: ${t('errors.unknown')}`;
}

export function formatErrorForToast(err: AppError, t: TranslateFn): { title: string; description: string } {
  const stageKey = `errors.stage.${err.stage}`;
  const stageLabel = t(stageKey, { defaultValue: err.stage });
  const title = `${stageLabel} ${t('errors.failed')}`;
  const description = displayMessage(err, t) || err.code || t('errors.unknown');
  return { title, description };
}
