import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import { slidegenFailureToastBody, slidegenFailureToastTitle } from '@/lib/slidegen-copy';
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
        !violation.missingKinds?.length &&
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
        violation.missingKinds ?? [],
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
          slidegenFailureToastTitle(violation.slideFailures, t),
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
      // ⭐ 没登记到 ≠ 文件不存在（2026-10-04 真机）：真机上两份改稿都在盘上，界面却在说
      //    「工作区里没有这些文件」。这一档只说「没登记到成果列表」，不下「不存在」的结论，
      //    也不放宽任何守卫 —— 它只是把已经发生的事说准确。
      if (violation.missingKinds?.length) {
        const description = t('claimGuard.missingKindsBody', { names: violation.missingKinds.join(', ') });
        lines.push(`[artifact.claim-guard.missing-kinds] ${description}`);
        toast.error(t('claimGuard.missingKindsTitle'), { description });
      }
      useMessageStore.getState().addMessage(violation.taskId, 'system', lines.join('\n'), undefined, {
        sessionKey: violation.sessionKey,
      });
    });
  }, [t]);
}
