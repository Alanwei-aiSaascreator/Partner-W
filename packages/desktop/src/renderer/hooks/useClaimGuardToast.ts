import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import { slidegenFailureToastBody } from '@/lib/slidegen-copy';
import { docgenFailureMessage } from '@/lib/docgen-failure-copy';
import { htmlgenFailureMessage } from '@/lib/htmlgen-failure-copy';
import { ARTIFACT_FAILURE_MARKER } from '@/lib/artifact-delivery-feedback';
import { useMessageStore } from '@/stores/messageStore';

export function useClaimGuardToast(): void {
  const { t } = useTranslation();
  const seen = useRef(new Set<string>());

  useEffect(() => {
    return window.clawwork.onClaimViolation((violation) => {
      if (
        !violation.missing.length &&
        !violation.slideFailures?.length &&
        !violation.docFailures?.length &&
        !violation.htmlFailures?.length
      )
        return;
      const key = JSON.stringify([violation.taskId, violation.sessionKey, violation.messageId]);
      if (seen.current.has(key)) return;
      seen.current.add(key);
      const lines = [ARTIFACT_FAILURE_MARKER];
      if (violation.slideFailures?.length) {
        lines.push(
          t('slidegen.failedTitle'),
          ...violation.slideFailures.map((failure) => slidegenFailureToastBody([failure], t)),
        );
      }
      if (violation.docFailures?.length) {
        lines.push(
          t('docgen.failedTitle'),
          ...violation.docFailures.map((failure) => `${docgenFailureMessage(failure, t)}\n${JSON.stringify(failure)}`),
        );
      }
      if (violation.htmlFailures?.length) {
        lines.push(
          t('htmlgen.failedTitle'),
          ...violation.htmlFailures.map(
            (failure) => `${htmlgenFailureMessage(failure, t)}\n${JSON.stringify(failure)}`,
          ),
        );
      }
      if (violation.missing.length) {
        const description = t('claimGuard.missingBody', { names: violation.missing.join(', ') });
        lines.push(`[artifact.claim-guard.missing] ${description}`);
        toast.error(t('claimGuard.missingTitle'), { description });
      }
      useMessageStore.getState().addMessage(violation.taskId, 'system', lines.join('\n'), undefined, {
        sessionKey: violation.sessionKey,
      });
    });
  }, [t]);
}
