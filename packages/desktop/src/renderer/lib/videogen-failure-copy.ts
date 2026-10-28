import type { VideogenFailure } from '@clawwork/shared';

type Translate = (key: string, options?: Record<string, unknown>) => string;

export function videogenFailureMessage(failure: VideogenFailure, t: Translate): string {
  switch (failure.code) {
    case 'videogen-block-invalid':
      return t('videogen.blockInvalid');
    case 'videogen-prompt-missing':
      return t('videogen.promptMissing');
    case 'videogen-prompt-too-long':
      return t('videogen.promptTooLong', { maxChars: failure.maxChars });
    case 'videogen-duration-invalid':
      return t('videogen.durationInvalid', { min: failure.min, max: failure.max });
    case 'videogen-resolution-invalid':
      return t('videogen.resolutionInvalid', { allowed: failure.allowed.join(' / ') });
    case 'videogen-aspect-invalid':
      return t('videogen.aspectInvalid', { value: failure.value, allowed: failure.allowed.join(' / ') });
    case 'videogen-unsupported-field':
      return t('videogen.unsupportedField', { field: failure.field });
    case 'videogen-image-requires-seedance':
      return t('videogen.imageRequiresSeedance');
    case 'videogen-not-configured':
      return t('videogen.notConfigured');
    case 'videogen-create-failed':
      // httpStatus 0 = 网络层失败（连都连不上）；402 = 积分不足（**不是**服务故障，
      // 用户要做的是充值/换号，不是"稍后重试"）；其余按状态码如实说。
      if (failure.httpStatus === 0) return t('videogen.createFailedNetwork');
      if (failure.httpStatus === 402) return t('videogen.insufficientBalance');
      return t('videogen.createFailedStatus', { status: failure.httpStatus });
    case 'videogen-content-rejected':
      return t('videogen.contentRejected');
    case 'videogen-billing-pending':
      return t('videogen.billingPending');
    case 'videogen-task-failed':
      return t('videogen.taskFailed');
    case 'videogen-timeout':
      return t('videogen.timeout');
    case 'videogen-download-failed':
      return t('videogen.downloadFailed');
    case 'videogen-save-failed':
      return t('videogen.saveFailed');
  }
}

export function videogenFailureToastBody(failures: readonly VideogenFailure[], t: Translate): string {
  const [first, ...rest] = failures;
  if (!first) return '';
  const head = videogenFailureMessage(first, t);
  if (rest.length === 0) return head;
  return `${head}\n${t('videogen.moreFailures', { rest: rest.length })}`;
}
