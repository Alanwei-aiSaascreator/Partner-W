/**
 * 运行中追加对话（2026-10-17 用户需求：「模型任务执行中，可以追加对话，不打断模型」）。
 *
 * OpenClaw 一轮一单飞（DOCX-205）—— 在飞的时候不能往同一条会话里插话。产品化的做法
 * 不是去撬运行锁，而是**排队**：这一轮跑着的时候用户再发的一条先存起来（明确告知"排队中"），
 * 等这一轮回到 idle 再自动发出去。语义上和 WorkBuddy 的"排队发送"一致。
 *
 * 规则（纯函数，单测钉死）：
 *   · 排队项**绑定任务**：切到别的任务不会把 A 的话发进 B；
 *   · 同一任务内 FIFO；
 *   · 同任务同文本不重复排（连按 Enter 不会刷出一串一模一样的请求）；
 *   · 空白不入队。
 */
export interface QueuedSend {
  id: string;
  taskId: string;
  text: string;
}

export function enqueueSend(queue: readonly QueuedSend[], entry: QueuedSend): QueuedSend[] {
  if (!entry.text.trim()) return queue as QueuedSend[];
  if (queue.some((item) => item.taskId === entry.taskId && item.text.trim() === entry.text.trim())) {
    return queue as QueuedSend[];
  }
  return [...queue, entry];
}

export function shiftSendForTask(
  queue: readonly QueuedSend[],
  taskId: string,
): { next: QueuedSend | null; rest: QueuedSend[] } {
  const index = queue.findIndex((item) => item.taskId === taskId);
  if (index < 0) return { next: null, rest: queue as QueuedSend[] };
  return { next: queue[index], rest: queue.filter((_, i) => i !== index) };
}

export function pendingSendCount(queue: readonly QueuedSend[], taskId: string): number {
  return queue.filter((item) => item.taskId === taskId).length;
}

export function removeQueuedSend(queue: readonly QueuedSend[], id: string): QueuedSend[] {
  return queue.filter((item) => item.id !== id);
}
