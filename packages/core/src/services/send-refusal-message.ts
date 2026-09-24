import { UnknownAgentError } from '../stores/task-store.js';
import type { TranslateFn } from './error-classify.js';

/**
 * 发送因为「待发任务点名的助手」被拒时，界面上该说哪句话。
 *
 * 为什么单独一层：**这两句话很容易被压成一句**，而它们说的根本不是一件事 ——
 * - 「这个助手不在本机」：有确定的下一步（**换一个助手**），重试一万次也一样；
 * - 「助手无响应」：是**临时**的，下一步是重试。
 *
 * 压成同一句会让用户对着一个永远不会好的操作反复重试。
 *
 * ⚠️ 2026-09-24 独立复核抓到：桌面那条路分类了、**PWA 那条路没有**
 * （`chat-composer.ts` 的 `resolveTask` 原来把异常吞成 `null`，`send` 一律报"无响应"）。
 * 所以规则收到 core 这份**唯一实现**里，三条调用方（`useChatSend` / `useTaskMaterials` /
 * `chat-composer`）都走它 —— 同一件事不再有第二处决定。
 *
 * ⚠️ 只在这两种之间选：`commitPendingTask` 的拒绝目前只有 `UnknownAgentError` 一种，
 *    其它异常照旧走「无响应」那句（维持既有行为，不是新判断）。
 */
export function describeSendRefusal(error: unknown, t: TranslateFn): string {
  return t(error instanceof UnknownAgentError ? 'errors.agentMissing' : 'errors.agentNotResponding');
}
