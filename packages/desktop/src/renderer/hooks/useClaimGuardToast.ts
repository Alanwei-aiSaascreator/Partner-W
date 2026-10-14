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
        !violation.invalidArtifacts?.length &&
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
        violation.invalidArtifacts ?? [],
        violation.slideFailures ?? [],
        violation.docFailures ?? [],
        violation.htmlFailures ?? [],
        violation.mediaFailures ?? [],
      ]);
      if (seen.current.has(key)) return;
      seen.current.add(key);
      /*
        ⚠️ 图12（2026-10-06）：这条系统便签在聊天里是**原样上屏**的（ChatMessage 的
        `[artifact-delivery-failed]` alert 框整段渲染），而它同时又是下一轮的模型诊断
        上下文（`artifactFailureContext`）。所以它**只能装产品化中文**：原来的
        `JSON.stringify(failure)` 与 `[diagnostic.code @offset] detail` 会把内部码、
        英文解析器原文直接摆给付费用户看 —— 验收当场点名。原始失败对象改走 console：
        用户面看不见，排查时拿得到（数据本身没动，仍在事件/仓库里）。
      */
      console.debug('[claim-guard] raw failure payload', {
        taskId: violation.taskId,
        sessionKey: violation.sessionKey,
        messageId: violation.messageId,
        missing: violation.missing,
        missingKinds: violation.missingKinds,
        invalidArtifacts: violation.invalidArtifacts,
        slideFailures: violation.slideFailures,
        docFailures: violation.docFailures,
        htmlFailures: violation.htmlFailures,
        mediaFailures: violation.mediaFailures,
      });
      const lines = [ARTIFACT_FAILURE_MARKER];
      /*
        ⭐ BUG-026 残余（2026-10-14 M1）：`toast.error` 原来在这些分支里**立刻**执行，而便签
        的内容去重在其后（本函数末尾）—— 于是"便签只有一条"并不保证"只弹一次"：同一失败
        跨轮次（每轮 messageId 不同）会弹一串同样的红 toast。
        修法：先把文案与通知意愿**收集**起来，等"稳定失败身份"（便签内容 + task/session）
        的去重判断落定后再统一发 —— 通知与便签走同一个判断，去重范围不扩大、判定链不缓存。
      */
      const notifications: Array<{ title: string; description: string }> = [];
      if (violation.mediaFailures?.length) {
        const description = t('claimGuard.mediaUnavailableBody', {
          names: violation.mediaFailures.map((failure) => failure.fileName).join(', '),
        });
        lines.push(t('claimGuard.mediaUnavailableTitle'), description);
        notifications.push({ title: t('claimGuard.mediaUnavailableTitle'), description });
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
          ...violation.docFailures.map((failure) => docgenFailureMessage(failure, t)),
        );
      }
      if (violation.htmlFailures?.length) {
        lines.push(
          t('htmlgen.failedTitle'),
          ...violation.htmlFailures.map((failure) => htmlgenFailureMessage(failure, t)),
        );
      }
      if (violation.missing.length) {
        const description = t('claimGuard.missingBody', { names: violation.missing.join(', ') });
        lines.push(`[artifact.claim-guard.missing] ${description}`);
        notifications.push({ title: t('claimGuard.missingTitle'), description });
      }
      // ⭐ BUG-042-c（2026-10-08 亲验的 C1 静默丢弃）：回复说做好了、文件在盘上、
      //    字节却不是那份格式（JSON 改名成 .docx 之类）⇒ 从前一声不吭。这里如实说：
      //    它是什么问题（不是有效文档）与下一步（让助手重新生成）。
      if (violation.invalidArtifacts?.length) {
        const description = t('claimGuard.invalidArtifactBody', { names: violation.invalidArtifacts.join(', ') });
        lines.push(`[artifact.claim-guard.invalid-artifact] ${description}`);
        notifications.push({ title: t('claimGuard.invalidArtifactTitle'), description });
      }
      // ⭐ 没登记到 ≠ 文件不存在（2026-10-04 真机）：真机上两份改稿都在盘上，界面却在说
      //    「工作区里没有这些文件」。这一档只说「没登记到成果列表」，不下「不存在」的结论，
      //    也不放宽任何守卫 —— 它只是把已经发生的事说准确。
      if (violation.missingKinds?.length) {
        const description = t('claimGuard.missingKindsBody', { names: violation.missingKinds.join(', ') });
        lines.push(`[artifact.claim-guard.missing-kinds] ${description}`);
        notifications.push({ title: t('claimGuard.missingKindsTitle'), description });
      }
      /*
        BUG-026（2026-10-06）：同一失败在后续轮次被重复判定时（每轮 messageId 不同，`seen`
        拦不住），这里原来会往聊天里追加**内容完全相同**的系统便签 —— 用户看到的是
        "一失败一气泡"的连环红框。内容一致时只留第一条：事实没丢（第一条还在聊天里、
        `artifactFailureContext` 照旧拿得到它），原始载荷已在上面的 console.debug。
        ⭐ 残余修复（2026-10-14）：**通知也并入这同一个判断** —— 被去重的重复失败不再弹 toast。
        范围至少含 task/session：只有同一个 task **且同一个 session** 里已经存在同内容便签
        才压；新 task / 新会话 / 新失败原因照常通知（判定不缓存"曾经失败"）。
      */
      const note = lines.join('\n');
      const existingNotes = useMessageStore.getState().messagesByTask[violation.taskId] ?? [];
      if (
        existingNotes.some(
          (message) =>
            message.role === 'system' && message.sessionKey === violation.sessionKey && message.content === note,
        )
      ) {
        console.debug(
          '[claim-guard] identical failure note already shown; duplicate bubble and notification suppressed',
          {
            taskId: violation.taskId,
            sessionKey: violation.sessionKey,
            messageId: violation.messageId,
          },
        );
        return;
      }
      for (const notification of notifications)
        toast.error(notification.title, { description: notification.description });
      useMessageStore.getState().addMessage(violation.taskId, 'system', note, undefined, {
        sessionKey: violation.sessionKey,
      });
    });
  }, [t]);
}
