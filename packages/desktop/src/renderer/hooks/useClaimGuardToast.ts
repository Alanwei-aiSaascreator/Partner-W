import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import { slidegenFailureToastBody } from '@/lib/slidegen-copy';
import { docgenFailureMessage } from '@/lib/docgen-failure-copy';
import { htmlgenFailureMessage } from '@/lib/htmlgen-failure-copy';
import { ARTIFACT_FAILURE_MARKER } from '@/lib/artifact-delivery-feedback';
import { ARTIFACT_QUALITY_MARKER, parseArtifactQualityNote } from '@/lib/artifact-quality-feedback';
import { useMessageStore } from '@/stores/messageStore';
import { useArtifactDeliveryStore } from '@/stores/artifactDeliveryStore';

export function useClaimGuardToast(): void {
  const { t } = useTranslation();
  const seen = useRef(new Set<string>());

  useEffect(
    () =>
      window.clawwork.onArtifactDeliverySettled?.((result) => {
        useArtifactDeliveryStore.getState().record(result);
        if (result.status === 'canceled' || !result.slideWarnings?.length) return;
        const store = useMessageStore.getState();
        const existing = store.messagesByTask[result.taskId] ?? [];
        if (
          existing.some(
            (message) =>
              message.taskId === result.taskId &&
              message.sessionKey === result.sessionKey &&
              parseArtifactQualityNote(message)?.sourceMessageId === result.messageId,
          )
        )
          return;
        const content = `${ARTIFACT_QUALITY_MARKER}\n${JSON.stringify({
          sourceMessageId: result.messageId,
          warnings: result.slideWarnings,
        })}`;
        if (!parseArtifactQualityNote({ role: 'system', content })) return;
        store.addMessage(result.taskId, 'system', content, undefined, { sessionKey: result.sessionKey });
      }),
    [],
  );

  useEffect(() => {
    return window.clawwork.onClaimViolation((violation) => {
      if (
        !violation.missing.length &&
        !violation.slideFailures?.length &&
        !violation.docFailures?.length &&
        !violation.htmlFailures?.length &&
        !violation.mediaFailures?.length
      )
        return;
      const key = JSON.stringify([
        violation.taskId,
        violation.sessionKey,
        violation.messageId,
        violation.missing,
        violation.slideFailures ?? [],
        violation.docFailures ?? [],
        violation.htmlFailures ?? [],
        violation.mediaFailures ?? [],
      ]);
      if (seen.current.has(key)) return;
      seen.current.add(key);
      const lines = [ARTIFACT_FAILURE_MARKER];
      if (violation.mediaFailures?.length) {
        const description = t('claimGuard.mediaUnavailableBody', {
          names: violation.mediaFailures.map((failure) => failure.fileName).join(', '),
        });
        lines.push(
          t('claimGuard.mediaUnavailableTitle'),
          description,
          ...violation.mediaFailures.map((failure) => JSON.stringify(failure)),
        );
        toast.error(t('claimGuard.mediaUnavailableTitle'), { description });
      }
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
