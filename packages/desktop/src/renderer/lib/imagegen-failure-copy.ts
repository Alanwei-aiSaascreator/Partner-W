import type { ImagegenFailure } from '@clawwork/shared';
type Translate = (key: string) => string;
export function imagegenFailureMessage(failure: ImagegenFailure, t: Translate): string {
  switch (failure.code) {
    case 'imagegen-block-invalid':
      return t('imagegen.blockInvalid');
    case 'imagegen-unavailable':
      return t('imagegen.unavailable');
    case 'imagegen-request-unconfirmed':
      return t('imagegen.requestUnconfirmed');
    case 'imagegen-generation-failed':
      return t('imagegen.generationFailed');
    case 'imagegen-result-unconfirmed':
      return t('imagegen.resultUnconfirmed');
    case 'imagegen-image-invalid':
      return t('imagegen.imageInvalid');
    case 'imagegen-save-failed':
      return t('imagegen.saveFailed');
    case 'imagegen-workspace-changed':
      return t('imagegen.workspaceChanged');
  }
}
export function imagegenFailureToastBody(failures: readonly ImagegenFailure[], t: Translate): string {
  return [...new Set(failures.map((failure) => imagegenFailureMessage(failure, t)))].join('\n');
}
