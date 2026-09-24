import { UnknownAgentError } from '@clawwork/core';

/**
 * 发送因为「待发任务的助手」被拒时，界面上该说哪句话。
 *
 * 抽成纯函数（`lib/agent-switch.ts` 是同一个理由）：**两句话很容易被压成一句**，
 * 而它们说的根本不是一件事 ——
 * - 「这个助手不在本机」：有确定的下一步（**换一个助手**），重试一万次也一样；
 * - 「助手无响应」：是**临时**的，下一步是重试。
 *
 * 压成同一句会让用户对着一个永远不会好的操作反复重试。
 *
 * ⚠️ 只在这两种之间选：`commitPendingTask` 的拒绝目前只有 `UnknownAgentError` 一种，
 *    其它异常照旧走「无响应」那句（不是新判断，是维持既有行为）。
 */
export function sendRefusalCopyKey(error: unknown): 'errors.agentMissing' | 'errors.agentNotResponding' {
  return error instanceof UnknownAgentError ? 'errors.agentMissing' : 'errors.agentNotResponding';
}
