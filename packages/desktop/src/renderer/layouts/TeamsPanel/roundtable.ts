import type { MeetingStage, TeamMeetingRecord } from '@clawwork/shared';
import { turnPhase, type MeetingPhase } from '@/features/team-meeting/status';

/**
 * 「我的 AI 团队」圆桌的**纯推导**（2026-10-06，V1 收口 · 任务 08；2026-10-16 T30 重做归属）。
 *
 * 冻结契约：主罗盘（main）+ 五岗位（调研员/分析师/创作师/制作师/质检师）。
 *
 * ⚠️ 岗位 id 与词表**跟个性化中心共用一套**：`IdentityCenter` 的 `TEAM_POSITION_IDS` 与
 *    9 语言的 `identity.teamPosition.{researcher,analyst,creator,producer,inspector}.name`
 *    （2026-10-06 对齐，别再另起一套自己的 id/文案键）。
 *
 * ## 2026-10-16（T30）：归属只认真实信号，归不出来就**一个岗位徽章都不画**
 *
 * 旧版把会议阶段直接映射成岗位（proposal→调研员+分析师 / review→质检师 / summary→创作师+制作师），
 * **一眼都没看 `turn.agentId`** —— 无论这一轮到底是谁在跑，圆桌都会点亮同样那几个岗位，
 * 那就是**编造归属**（"这一轮属于谁"必须来自真实字段）。
 *
 * 而真实信号里**根本不存在**「这一轮属于哪个岗位」这层信息：
 *   · `MeetingTurn` 只有 `id / stage / taskId / agentId / agentName / sessionKey / status / runId / messageIds`；
 *   · 团队花名册的 `TeamAgent.position` 是**另一套词表**（moderator / expert / challenger / scribe），
 *     与五岗位不是一回事（`@clawwork/shared` types.ts:160 的注释写明"别合并"）；
 *   · userProfile 里也不存岗位归属；真源里没有任何 `roleRun` / 岗位 task 行。
 *
 * ⇒ `positions` **只装真的归到岗位的那些**（`attributeTurnToPosition` 认出来的），当前恒为空。
 *    调用方据此**整行不渲染岗位徽章** —— 不是画 5 个"未归因"灰徽章：那是把"我们没有这条数据"
 *    变成每次开会都挂着的常驻噪声，用户看到的是"坏了"。**宁可不画，也不编造归属。**
 *
 * 真实的东西照旧如实展示：`participants` 直接来自 `record.turns` 的
 * 真实 `agentId` / `agentName` / `stage` 与真实 `status` 推出来的相位 —— 那才是
 * "这一轮属于谁"的真人真事。
 */

/**
 * ⚠️ 岗位 id 与词表**跟个性化中心共用一套**（见文件头）。这份清单与
 *    `IdentityCenter` 的 `TEAM_POSITION_IDS`、以及 9 语言 `identity.teamPosition.*` 的键集
 *    由 `test/team-position-vocabulary-drift.test.ts` 逐元素钉着，加/删/改名必须一起动。
 */
export const ROUNDTABLE_POSITIONS = ['researcher', 'analyst', 'creator', 'producer', 'inspector'] as const;
export type RoundtablePosition = (typeof ROUNDTABLE_POSITIONS)[number];

/** **真的**归到某个岗位的一轮（`phase` 由该轮真实 `status` 推出来）。 */
export interface RoundtablePositionSignal {
  position: RoundtablePosition;
  phase: MeetingPhase;
}

/** 真实参与的一轮：agentId/agentName/stage 全部直接抄自 `record.turns`，没有换算。 */
export interface RoundtableParticipant {
  agentId: string;
  name: string;
  stage: MeetingStage;
  phase: MeetingPhase;
}

/** 有真实轮次、却归不到任何岗位的一条**归因缺口**（打日志用，不上屏当状态）。 */
export interface RoundtableAttributionGap {
  turnId: string;
  agentId: string;
  stage: MeetingStage;
  reason: string;
}

export interface RoundtableSignal {
  /** 状态取自哪条会议记录（按 `updatedAt` 最新；同一时刻优先仍在进行中的那条）。 */
  record: TeamMeetingRecord | null;
  /**
   * **只装真实归因出来的岗位**。真源没有岗位载体 ⇒ 当前**恒为空数组** ⇒ 调用方一个徽章都不画。
   * 将来真源补上载体时这里自然会有值，调用方不用改。
   */
  positions: RoundtablePositionSignal[];
  /** 真实参与成员（来自真实 `turn.agentId`）—— 圆桌上真正该显示的那份归属。 */
  participants: RoundtableParticipant[];
  /** 归因缺口（每一轮一条）：五岗位没有真实载体，调用方据此打归因日志。 */
  unattributed: RoundtableAttributionGap[];
}

type MeetingTurn = TeamMeetingRecord['turns'][number];

/**
 * 一个真实 `turn` → 它属于哪个岗位。
 *
 * **恒返回 `null`**：真源里没有这个载体（见文件头）。留成显式函数是为了把
 * "这里就是归不了"写成代码而不是注释 —— 将来真源补上真实载体（例如给 `MeetingTurn`
 * 加一个真实 `position` 字段）时，只改这一处；在那之前，任何 stage→岗位的对应都是编的。
 */
export function attributeTurnToPosition(turn: MeetingTurn): RoundtablePosition | null {
  void turn;
  return null;
}

export function deriveRoundtableSignal(
  records: readonly TeamMeetingRecord[],
  options: { gatewayId?: string } = {},
): RoundtableSignal {
  /**
   * ⚠️ 2026-10-07（质检 P3-2）：拿不到 `gatewayId` 时**按无信号处理** ——
   *    老写法 `!options.gatewayId || …` 在缺网关时**恒真**，会把任意一台网关上的
   *    会议记录当成"本团队"的状态（不同盘/不同网关的记录被混着展示，正是"不伪造"
   *    契约要挡的那种假信号）。
   */
  const gatewayId = options.gatewayId?.trim();
  const candidates = gatewayId ? records.filter((record) => record.gatewayId === gatewayId) : [];
  const sorted = [...candidates].sort(
    (a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt),
  );
  const record = sorted[0] ?? null;
  if (!record) return { record: null, positions: [], participants: [], unattributed: [] };

  // ⚠️ 归属**只**从真实 `turn.agentId` 那条路来（`attributeTurnToPosition`）。真源没有载体
  //    ⇒ 每一轮都归不出来 ⇒ `positions` 保持为空。绝不按 `stage` 兜底补一个岗位。
  const positions: RoundtablePositionSignal[] = [];
  for (const turn of record.turns) {
    const position = attributeTurnToPosition(turn);
    if (position) positions.push({ position, phase: turnPhase(turn.status) });
  }

  const participants: RoundtableParticipant[] = record.turns.map((turn) => ({
    agentId: turn.agentId,
    name: turn.agentName,
    stage: turn.stage,
    phase: turnPhase(turn.status),
  }));

  const unattributed: RoundtableAttributionGap[] = record.turns.map((turn) => ({
    turnId: turn.id,
    agentId: turn.agentId,
    stage: turn.stage,
    reason: 'MeetingTurn has no position carrier (only agentId/agentName/stage/status)',
  }));

  return { record, positions, participants, unattributed };
}
