import type { TeamMeetingRecord } from '@clawwork/shared';

/**
 * 团队开会的真实状态 → **展示相位**（2026-10-06，V1 收口 · 任务 08/10/11 共用）。
 *
 * ⚠️ 这是**纯展示映射**，不改任何记录/控制逻辑（`controller.ts` / `records` 一律不动）：
 * 圆桌（`layouts/TeamsPanel/roundtable.ts`）和聊天页的「团队协作」条都从这里取同一份判据，
 * 两处各写一遍迟早只改一处。
 *
 * 相位含义：
 * - `idle` 待命：还没轮到你 / 排队中 / 被用户主动停止
 * - `working` 工作中：网关真的在跑这一轮（dispatching/running/syncing）
 * - `done` 已完成：这一轮的回复**已被保存**（turn.status = completed）
 * - `attention` 需要处理：失败 / 被中断（绝不粉饰成"进行中"）
 */
export type MeetingPhase = 'idle' | 'working' | 'done' | 'attention';

type MeetingTurnStatus = TeamMeetingRecord['turns'][number]['status'];

const WORKING_TURN_STATUSES: ReadonlySet<MeetingTurnStatus> = new Set(['dispatching', 'running', 'syncing']);
const ATTENTION_TURN_STATUSES: ReadonlySet<MeetingTurnStatus> = new Set(['failed', 'interrupted']);

export function turnPhase(status: MeetingTurnStatus): MeetingPhase {
  if (WORKING_TURN_STATUSES.has(status)) return 'working';
  if (ATTENTION_TURN_STATUSES.has(status)) return 'attention';
  if (status === 'completed') return 'done';
  // pending / stopped ⇒ 都还没产出：待命（停止是用户主动的，不算"需要处理"）。
  return 'idle';
}

/**
 * 一组 turn 的**汇总相位**：空组 ⇒ `null`（这个人在这次会议里根本没上场，不编状态）。
 * 优先级：工作中 > 需要处理 > 已完成 —— 只要有一个人还在跑/出了问题，就不说"已完成"。
 */
export function turnsPhase(turns: ReadonlyArray<TeamMeetingRecord['turns'][number]>): MeetingPhase | null {
  if (turns.length === 0) return null;
  const phases = turns.map((turn) => turnPhase(turn.status));
  if (phases.includes('working')) return 'working';
  if (phases.includes('attention')) return 'attention';
  if (phases.every((phase) => phase === 'done')) return 'done';
  return 'idle';
}

/** 一条会议记录的整体相位（条上那颗状态灯用）。 */
export function recordPhase(record: TeamMeetingRecord): MeetingPhase {
  const turns = turnsPhase(record.turns);
  if (turns === 'working') return 'working';
  if (record.status === 'failed' || record.status === 'interrupted') return 'attention';
  if (turns === 'attention') return 'attention';
  if (record.status === 'completed' || turns === 'done') return 'done';
  return 'idle';
}
