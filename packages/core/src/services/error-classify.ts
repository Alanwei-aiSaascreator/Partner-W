import type { AppError, ErrorSource, ErrorStage, Retryable } from '@clawwork/shared';
import { RETRYABLE_ERROR_CODES, NON_RETRYABLE_ERROR_CODES } from '@clawwork/shared';
import { translateGatewayError } from './gateway-error-message.js';

function classifyRetryable(code?: string): Retryable {
  if (!code) return 'unknown';
  if (RETRYABLE_ERROR_CODES.has(code)) return 'yes';
  if (NON_RETRYABLE_ERROR_CODES.has(code)) return 'no';
  return 'unknown';
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
    retryable: classifyRetryable(opts.code),
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
 * 顺序是刻意的：**能认出的原文**（更具体）> **结构化类别**（一定正确但较泛）> **原文**。
 * ⚠️ 最后那一步不能少：类别有条目但**这个语言没这条 key** 时（i18next 会把 key 原样返回），
 *    绝不能把 `errors.kind.rate_limit` 这种东西摆到用户脸上 —— 退回原文。
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
