/**
 * 点团队卡片上的「开始对话」时，**该不该真的进会话**。
 *
 * 为什么要有这一步：团队是**跟着盘走**的（花名册存在 `teams` / `team_agents` 两张表里），
 * 而助手是不是**装在这台机器上**是另一回事 —— 换一台机器插同一块盘，花名册在、助手不在。
 * 原来的 `handleStartChat` 只看"团队里有没有助手"，于是照旧 `startNewTask` + 跳进会话，
 * 用户到那一屏才看到"这个助手不在本机"（那一层已经会如实说了，但**已经跳过去了**）。
 *
 * ⇒ 判据收在这里：**要进的那一个**在不在本机。不在就**不跳**，当面说清楚。
 */

import { resolveRequestedAgent } from './requested-agent';

export type TeamChatEntryDecision =
  /** 可以进：`agentId` 是本机确实有的那个助手。 */
  | { kind: 'start'; agentId: string }
  /** 团队里**一个助手都没有**（花名册是空的）—— 既有的提示，行为不变。 */
  | { kind: 'no-agents' }
  /** 要进的那个助手**不在本机**：不跳，当面说清楚。 */
  | { kind: 'agent-missing' };

export interface TeamAgentRef {
  agentId: string;
  isManager?: boolean;
}

export function decideTeamChatEntry(input: {
  agents: readonly TeamAgentRef[];
  /** 那个网关的助手目录；`undefined` = **还没拉回来**（与"空的"是两回事）。 */
  catalog: { agents: readonly { id: string }[] } | undefined;
}): TeamChatEntryDecision {
  if (input.agents.length === 0) return { kind: 'no-agents' };
  // 主管优先，没有主管就第一个 —— **既有行为，别顺手改**（圆桌派活依赖主管这一层）。
  const agentId = input.agents.find((agent) => agent.isManager)?.agentId ?? input.agents[0].agentId;
  // ⚠️ 判据复用 `resolveRequestedAgent`：它把"目录还没拉回来"（`loading`）与
  //    "拉回来了但确实没有"（`missing`）分得很开。**不许把 loading 判成缺失** ——
  //    那是用一个新的误报换掉旧的静默，用户会去"装"一个其实已经装好的助手。
  if (resolveRequestedAgent(agentId, input.catalog) === 'missing') return { kind: 'agent-missing' };
  return { kind: 'start', agentId };
}
