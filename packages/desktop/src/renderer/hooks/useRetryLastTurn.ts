import { useCallback } from 'react';
import { findRetryTarget } from '@clawwork/core';
import type { Message } from '@clawwork/shared';
import { composer } from '@/platform';
import { useMessageStore } from '@/stores/messageStore';

/**
 * 错误消息上的「重试」入口（B10）。
 *
 * `AppError.retryable` 此前是个**死字段**（算了没人读，而且在这条路上恒为 `'unknown'`）。
 * 接上它需要三样东西：判得准（core 的 `errorKind` 映射）、有地方登记
 * （`retryableErrorBySession`）、以及**有人真的读它** —— 就是这个 hook。
 *
 * 拆成 hook 而不是写在 `MainArea` 里：那边一千多行，"重试发了什么"这件事
 * 塞进去就再也没法单测了。这里只做两件事，都可以单独钉住。
 */

/**
 * 这个任务当前**可以重试**的那条错误消息 id（没有就是 `null`）。
 *
 * ⚠️ 按任务找、不按会话找：一个任务可能有好几条会话（多 agent / 对比），
 *    而时间线只有一条 —— 界面要的是"时间线上哪条错误该配按钮"。
 *    `retryableErrorBySession` 是**每会话只留最近一条**，所以这里最多命中一条。
 */
export function useRetryableErrorMessageId(taskId: string | null | undefined): string | null {
  return useMessageStore((s) => {
    if (!taskId) return null;
    for (const entry of Object.values(s.retryableErrorBySession)) {
      if (entry.taskId === taskId) return entry.messageId;
    }
    return null;
  });
}

/**
 * 返回一个"重试这条错误"的回调。
 *
 * 发的是**这条错误之前最近的那条用户消息**（正文连同附件原样回去），走的是与
 * 正常发送**同一个**入口 `composer.send` —— 计费口径因此天然一致（重试不是免费的）。
 *
 * ⚠️ 找到目标才发：找不到（消息被删、前面压根没有用户消息、那条是纯附件消息）
 *    就**什么都不做**。悄悄发一条空消息出去，用户会在账单上看见它。
 */
export function useRetryLastTurn(task: { id: string } | undefined, messages: Message[]): (messageId: string) => void {
  return useCallback(
    (messageId: string) => {
      if (!task) return;
      const target = findRetryTarget(messages, messageId);
      if (!target) return;
      composer
        .send(task.id, {
          content: target.content,
          ...(target.attachments?.length ? { messageAttachments: target.attachments } : {}),
        })
        // `send` 内部已经把可预期的失败变成错误消息 + toast 了；能 reject 出来的是
        // 真意外，别让它变成一个没人看见的 unhandled rejection。
        .catch((err: unknown) => {
          console.error('[retry_last_turn_failed]', err);
        });
    },
    [task, messages],
  );
}
