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
/**
 * 这条规则**可能**返回的 key，映射成常量表 —— 让"有哪些 key"只有**一处**定义。
 *
 * ⚠️ 为什么不是直接写字面量（2026-09-24，两位复核者都点到）：`check:i18n` 的提取正则看不见
 *    表达式里的 key，所以齐备性得靠一条测试补；而那条测试如果**手抄**一份 key 清单，
 *    就成了仓库栽过的"清单不更新"形状 —— 加第三种错误时两处都发现不了。
 *    现在测试直接遍历这张表，加一项就自动被盖住。
 */
export const SEND_REFUSAL_COPY = {
  /** 点名要的助手不在**已加载**的目录里（`UnknownAgentError`）。 */
  agentMissing: 'errors.agentMissing',
  /** 其余一切（临时性），下一步是重试。 */
  notResponding: 'errors.agentNotResponding',
} as const;

export type SendRefusalCopyKey = (typeof SEND_REFUSAL_COPY)[keyof typeof SEND_REFUSAL_COPY];

export function describeSendRefusal(error: unknown, t: TranslateFn): string {
  // 显式标成 `SendRefusalCopyKey`：**表里没有的** key 走这个变量就编不过
  //（表里已有的字面量抄一遍仍能编过 —— 这个标注挡的是"新加一条分支却忘了进表"，复核 B 指出别把它说大）。
  const key: SendRefusalCopyKey =
    error instanceof UnknownAgentError ? SEND_REFUSAL_COPY.agentMissing : SEND_REFUSAL_COPY.notResponding;
  return t(key);
}
