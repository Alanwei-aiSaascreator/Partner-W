import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { Message } from '@clawwork/shared';
import { toast } from '@/lib/toast';
import { slidegenFailureToastBody, slidegenFailureToastTitle } from '@/lib/slidegen-copy';
import { docgenFailureMessage } from '@/lib/docgen-failure-copy';
import { htmlgenFailureMessage } from '@/lib/htmlgen-failure-copy';
import { ARTIFACT_FAILURE_MARKER } from '@/lib/artifact-delivery-feedback';
import { ARTIFACT_QUALITY_MARKER, parseArtifactQualityNote } from '@/lib/artifact-quality-feedback';
import { useMessageStore } from '@/stores/messageStore';
import { useArtifactDeliveryStore } from '@/stores/artifactDeliveryStore';

/** 失败去重周期的作用域键：同一 task 且同一 session 才算同一个周期。 */
function failureEpisodeKey(taskId: string, sessionKey: string): string {
  return `${taskId}\n${sessionKey}`;
}

/**
 * 这条系统便签是否属于**已关闭的失败周期**（成功边界之前）—— 边界的三层可恢复证据：
 *
 * ① **持久化最小成功标记**：同会话里、位于该便签**之后**的任意一条 `deliverySucceeded === true`
 *    消息（main 在 `succeeded` 结算时就地写库，随消息水合回来）。这是**不设窗口**的那一份：
 *    不再受 hook 内存上限、也不再受交付活动表 256 条上限影响。
 * ② **成功消息 id**：现场结算（`onArtifactDeliverySettled`）与挂载时从
 *    `getArtifactDeliveryActivitySnapshot().completedActivities` 恢复的 `succeeded` 终态。
 *    覆盖"消息刚重灌、标记还没水合"以及"升级前发生、库里没有标记"的成功。
 * ③ **结算时刻的便签快照**：只为**无法按消息锚定**的成功兜底（成功引用的消息不在本地
 *    消息流里）—— 与 r6 行为逐字相同。
 *
 * ⚠️ 只回答"便签在不在成功之前"：不猜成功、不删历史便签、不缓存失败判定；找不到任何证据
 *    ⇒ 回退旧行为（便签算当前周期 ⇒ 全量去重），不把"查不到"解释成"没成功"。
 * ⚠️ 三层都按 task/session 隔离（`episodeKey` 含 session；① 比对同会话消息）。
 */
function isClosedEpisodeNote(input: {
  note: Message;
  noteIndex: number;
  messages: readonly Message[];
  sessionKey: string;
  episodeKey: string;
  successMessageIds: ReadonlyMap<string, ReadonlySet<string>>;
  closedEpisodeNotes: ReadonlyMap<string, ReadonlySet<string>>;
}): boolean {
  const { note, noteIndex, messages, sessionKey, episodeKey, successMessageIds, closedEpisodeNotes } = input;
  // ① 持久化最小成功标记。
  for (let index = noteIndex + 1; index < messages.length; index += 1) {
    const candidate = messages[index]!;
    if (candidate.sessionKey === sessionKey && candidate.deliverySucceeded === true) return true;
  }
  // ② 成功消息 id（现场 + 快照恢复）。
  for (const messageId of successMessageIds.get(episodeKey) ?? []) {
    const anchorIndex = messages.findIndex((message) => message.id === messageId && message.sessionKey === sessionKey);
    if (anchorIndex > noteIndex) return true;
  }
  // ③ 结算时刻快照（无法锚定的成功）。
  return closedEpisodeNotes.get(episodeKey)?.has(note.id) ?? false;
}

export function useClaimGuardToast(): void {
  const { t } = useTranslation();
  const seen = useRef(new Set<string>());
  /*
    ⭐ r6 F4（BUG-026 成功边界，2026-10-14）：**可信交付成功**结束上一段失败去重周期。

    反例（终审真实 hook/store 探针）：同 task/session「失败 → 修好并成功交付 → 再改又失败」
    只弹一次失败通知（预期两次）—— 因为去重扫描的是**整个历史**的同文便签，
    成功事件只进 `artifactDeliveryStore`，不结束任何周期。

    修法：成功（`status === 'succeeded'`）时，把该 task/session **此刻已存在**的系统便签
    记为"上一段周期已上过屏"；去重只对**不在该集合里**（= 当前周期新增）的便签生效。
    · 历史便签不删：模型上下文（`artifactFailureContext`）照旧拿得到；
    · 不加永久失败缓存：判定仍由主进程每轮重新做出，这里只划分"当前周期"；
    · 非成功 settled（failed / needs-review / canceled）**不**结束周期：needs-review 是
      "未确认"，不是可信成功；把它当边界会让未解决的同一失败在中段重新刷屏。

    ⭐ r7-1（2026-10-15，**跨重开残余**）：上面那份便签快照只是 hook 内存 ref —— 应用重开后
    便签会按原 id/session 水合回来（`message-store.ts` 持久化 → `session-sync.ts` bulkLoad →
    新 root 重挂本 hook），边界却没了，于是成功前的历史便签又被当成当前失败周期，
    同因新失败被吞（独立复审反例：期待 2 次通知、实际 1 次）。
    修法（本文件）：边界改成**可从既有持久化证据重建**，按 `isClosedEpisodeNote` 的三层证据
    （持久化最小成功标记 → 成功消息 id + 交付活动快照恢复 → 结算时刻便签快照兜底）判定；
    身份幂等：同一 `(task,session,messageId)` 的重复/迟到 `succeeded` 回执不再重拍当前便签
    （复审观察序列「失败A→成功S→失败B→重复S→失败C」期待 2 次、旧实现 3 次）。
    三层证据各自的窗口/缺口见 `isClosedEpisodeNote` 与本文件两处 ref 的注释；
    全部找不到 ⇒ 回退旧行为（全量去重），只降能力、不误报成功。
  */
  /** ③ 结算时刻的便签快照 —— 只服务"无法按消息锚定的成功"（见 `isClosedEpisodeNote`）。 */
  const closedEpisodeNotes = useRef(new Map<string, Set<string>>());
  /**
   * ② 可信成功绑定的消息 id（现场结算 + 挂载时从交付活动快照恢复）。
   * ⚠️ **刻意不设上限**：旧实现的 128 条淘汰与交接的 256 条交付活动窗口是同一根因
   *   （边界被丢、历史便签还在）—— 换另一份有上限的缓存不能闭合它。这里的条目是
   *   "一个成功 = 一个 id"，量级远小于消息本身；真正的持久真相在消息行的
   *   `deliverySucceeded`（①，随消息水合）与交付活动表。
   */
  const successMessageIds = useRef(new Map<string, Set<string>>());

  /**
   * ⭐ r7-1 恢复（挂载一次）：重开后成功边界不能只靠内存态。
   * `artifact_delivery_activities` 里 `status === 'succeeded'` 的终态（用户/组织/许可绑定过的
   * 真实结算，经 `artifact:get-delivery-activity-snapshot` 读出）在这里折进 ② 号证据。
   * 限制如实保留：该表只留最近 256 条、没走到 phase 的操作可能没有活动 —— "查不到"≠"未成功"，
   * 那些成功靠 ① 号持久化标记兜（这也是为什么标记必须落库而不是再开一份内存缓存）。
   */
  useEffect(() => {
    let cancelled = false;
    const load = window.clawwork?.getArtifactDeliveryActivitySnapshot;
    if (typeof load !== 'function') return;
    void load()
      .then((snapshot) => {
        if (cancelled || !snapshot) return;
        const map = successMessageIds.current;
        for (const activity of snapshot.completedActivities ?? []) {
          if (activity.status !== 'succeeded') continue;
          if (!activity.taskId || !activity.sessionKey || !activity.messageId) continue;
          const key = failureEpisodeKey(activity.taskId, activity.sessionKey);
          const ids = map.get(key) ?? new Set<string>();
          ids.add(activity.messageId);
          map.set(key, ids);
        }
      })
      .catch((error: unknown) => {
        console.debug('[claim-guard] delivery success recovery unavailable', error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(
    () =>
      window.clawwork.onArtifactDeliverySettled?.((result) => {
        useArtifactDeliveryStore.getState().record(result);
        if (result.status === 'succeeded') {
          const key = failureEpisodeKey(result.taskId, result.sessionKey);
          const ids = successMessageIds.current.get(key) ?? new Set<string>();
          /*
            ⭐ r7-1 身份幂等：同一 `(task,session,messageId)` 的成功**只处理一次**。
            重复/迟到回执（如 `data-handlers` 媒体补发的成功重放）不得再拍一次当前便签 ——
            否则刚开启的新失败周期会被旧成功重新"闭合"，下一轮同失败又弹一次。
            已恢复（②）或已水合带标记（①）的成功同样按"已知"处理（跨重开的重放）。
          */
          const alreadyKnown =
            ids.has(result.messageId) ||
            (useMessageStore.getState().messagesByTask[result.taskId] ?? []).some(
              (message) => message.id === result.messageId && message.deliverySucceeded === true,
            );
          if (!alreadyKnown) {
            ids.add(result.messageId);
            successMessageIds.current.set(key, ids);
            const baseline = new Set(
              (useMessageStore.getState().messagesByTask[result.taskId] ?? [])
                .filter((message) => message.role === 'system' && message.sessionKey === result.sessionKey)
                .map((message) => message.id),
            );
            const map = closedEpisodeNotes.current;
            map.delete(key);
            map.set(key, baseline);
            if (map.size > 128) map.delete(map.keys().next().value!);
          }
          /*
            ⭐ r7-1 ① 号证据就地置位（幂等）：把"这条消息交付成功过"写进**消息对象本身** ——
            它随消息一起水合/重灌（`bulkLoad`），重开后边界照样判得出；库行那份
            （`messages.delivery_succeeded`，main 在结算出口写）管真正的进程重启。
            重复回执只是把同一个 true 再写一遍；标不中消息（还没落进消息流）由 ② 号证据兜。
          */
          useMessageStore.getState().markDeliverySucceeded(result.taskId, result.messageId);
        }
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
        ⭐ r6 F4（同日）：去重只对**当前失败周期**的便签生效 —— 可信交付成功（`succeeded`）
        之前的同文便签属于上一段周期，不替新失败压通知/便签（见 `closedEpisodeNotes`）。
      */
      const note = lines.join('\n');
      const existingNotes = useMessageStore.getState().messagesByTask[violation.taskId] ?? [];
      const episodeKey = failureEpisodeKey(violation.taskId, violation.sessionKey);
      if (
        existingNotes.some(
          (message, index) =>
            message.role === 'system' &&
            message.sessionKey === violation.sessionKey &&
            message.content === note &&
            // 成功边界之前的老便签 = 上一段周期：不再压当前周期的通知。
            // ⭐ r7-1：边界按**可恢复证据**判定（见 `isClosedEpisodeNote`）——
            //    重开/重灌后照样判得出，不再只认本进程见过的便签 id 集合。
            !isClosedEpisodeNote({
              note: message,
              noteIndex: index,
              messages: existingNotes,
              sessionKey: violation.sessionKey,
              episodeKey,
              successMessageIds: successMessageIds.current,
              closedEpisodeNotes: closedEpisodeNotes.current,
            }),
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
