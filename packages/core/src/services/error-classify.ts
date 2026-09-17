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
  details?: Record<string, unknown>;
}): AppError {
  return {
    source: opts.source,
    stage: opts.stage,
    code: opts.code,
    rawMessage: opts.rawMessage,
    details: opts.details,
    retryable: classifyRetryable(opts.code),
  };
}

export type TranslateFn = (key: string, opts?: Record<string, unknown>) => string;

/**
 * 展示前先过一层翻译：已知的网关错误给中文，未知的**保留原文**（原文比我们编的话准）。
 *
 * ⚠️ 2026-09-17 之前这一层没接上，`formatErrorForUser` 只是把原文拼到前缀后面，
 *    所以 `GatewayClientRequestError: question 'doc_type' requires an answer`
 *    被原样写进聊天记录 —— 用户既看不懂，还看到了内部字段名。翻译器一直写在那儿，
 *    却只有斜杠命令那条路在用。现在两条路都走同一个入口。
 */
function displayMessage(err: AppError): string | undefined {
  if (!err.rawMessage) return undefined;
  return translateGatewayError(err.rawMessage) ?? err.rawMessage;
}

export function formatErrorForUser(err: AppError, t: TranslateFn): string {
  const stageLabel = t(`errors.stage.${err.stage}`, { defaultValue: err.stage });
  const message = displayMessage(err);
  if (message) return `${stageLabel}: ${message}`;
  if (err.code) return `${stageLabel}: [${err.code}]`;
  return `${stageLabel}: ${t('errors.unknown')}`;
}

export function formatErrorForToast(err: AppError, t: TranslateFn): { title: string; description: string } {
  const stageKey = `errors.stage.${err.stage}`;
  const stageLabel = t(stageKey, { defaultValue: err.stage });
  const title = `${stageLabel} ${t('errors.failed')}`;
  const description = displayMessage(err) || err.code || t('errors.unknown');
  return { title, description };
}
