import type { Message, MessageAttachment } from '@clawwork/shared';

/**
 * 「重试」要重发的东西（B10）。
 *
 * ## 为什么是"往回找"而不是"取最后一条"
 *
 * 错误是以一条 **system 消息**落在时间线上的（`store.addMessage(taskId,'system',…)`），
 * 所以"最后一条消息"永远是那句错误本身。要重发的必然是它**之前**的那条用户消息。
 *
 * ## 为什么附件必须跟着回去
 *
 * 只发正文、把附件丢掉，会得到一段**看起来一样、其实问的不是同一件事**的回答 ——
 * 而用户看不出来。所以附件一律原样带回；带不回来的情形（见下）**宁可不给重试入口**。
 *
 * ⚠️ 这里只负责**选**，不负责发（发由调用方走 `composer.send`，那才是唯一入口）。
 */
export interface RetryTarget {
  content: string;
  attachments?: MessageAttachment[];
}

/**
 * 找出 `errorMessageId` 之前**最近的一条用户消息**；找不到就返回 `null`。
 *
 * 返回 `null` 的三种情形（都是"宁可不给按钮"）：
 *   - 这条错误不在列表里（消息被删了、换任务了）；
 *   - 前面压根没有用户消息（错误发生在用户说话之前）；
 *   - 那条用户消息**正文是空的**（纯附件消息）—— `send` 的正文是必填，
 *     替用户编一句空话发出去，比不给他按钮更糟。
 */
export function findRetryTarget(messages: Message[], errorMessageId: string): RetryTarget | null {
  const errorIndex = messages.findIndex((m) => m.id === errorMessageId);
  if (errorIndex < 0) return null;

  // ⚠️ 从错误消息**往前**走，第一条用户消息就是它 —— 不许反过来找（那会挑中用户
  //    后来自己打的新一句，等于替他做决定）。
  for (let i = errorIndex - 1; i >= 0; i -= 1) {
    const candidate = messages[i];
    if (candidate.role !== 'user') continue;
    if (!candidate.content.trim()) return null;
    return {
      content: candidate.content,
      ...(candidate.attachments?.length ? { attachments: candidate.attachments } : {}),
    };
  }

  return null;
}
