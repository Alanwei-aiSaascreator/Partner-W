import type { MeetingStage, TeamMeetingRecord } from '@clawwork/shared';
import { turnsPhase, type MeetingPhase } from '@/features/team-meeting/status';

/**
 * 「我的 AI 团队」圆桌的**纯推导**（2026-10-06，V1 收口 · 任务 08）。
 *
 * 冻结契约：主罗盘（main）+ 五岗位（调研员/分析师/创作师/制作师/质检师）。
 * 状态**只来自真实信号** —— 团队开会（`features/team-meeting`）的 `TeamMeetingRecord.turns`
 * 的真实 `status`：没有任何真实信号时显示「未启用 / 待命」，**不做假进度**。
 *
 * 会议阶段 → 岗位的对应是**职责对应**（架构规格 §1/§3 的角色名册）：
 *   - proposal（理解问题、摆事实与假设、出方案）→ 调研员 + 分析师
 *   - review（审核改进，换厂商复核）→ 质检师
 *   - summary（汇总、出件交付）→ 创作师 + 制作师
 * 一次会议没有跑到的岗位显示「待命」——那是如实呈现，不是失败。
 */
/**
 * ⚠️ 岗位 id 与词表**跟个性化中心共用一套**：`IdentityCenter` 的 `TEAM_POSITION_IDS` 与
 *    9 语言的 `identity.teamPosition.{researcher,analyst,creator,producer,inspector}.name`
 *    （2026-10-06 对齐，别再另起一套自己的 id/文案键）。
 */
export const ROUNDTABLE_POSITIONS = ['researcher', 'analyst', 'creator', 'producer', 'inspector'] as const;
export type RoundtablePosition = (typeof ROUNDTABLE_POSITIONS)[number];

export type RoundtableStatus = MeetingPhase | 'disabled';

const STAGE_POSITIONS: Record<MeetingStage, readonly RoundtablePosition[]> = {
  proposal: ['researcher', 'analyst'],
  review: ['inspector'],
  summary: ['creator', 'producer'],
};

type MeetingTurn = TeamMeetingRecord['turns'][number];

/**
 * 一组真实 turn → 一档状态；这一阶段在记录里根本没跑过（无 turn）⇒ `null`（不编）。
 * ⚠️ 判据在 `features/team-meeting/status.ts`（与聊天页「团队协作」条共用同一份映射）。
 */
export function deriveStageStatus(turns: readonly MeetingTurn[]): RoundtableStatus | null {
  return turnsPhase(turns);
}

export interface RoundtableSignal {
  /** 状态取自哪条会议记录（按 `updatedAt` 最新；同一时刻优先仍在进行中的那条）。 */
  record: TeamMeetingRecord | null;
  statuses: Record<RoundtablePosition, RoundtableStatus>;
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
  if (!record) {
    return {
      record: null,
      statuses: {
        researcher: 'disabled',
        analyst: 'disabled',
        creator: 'disabled',
        producer: 'disabled',
        inspector: 'disabled',
      },
    };
  }
  const statuses: Record<RoundtablePosition, RoundtableStatus> = {
    researcher: 'idle',
    analyst: 'idle',
    creator: 'idle',
    producer: 'idle',
    inspector: 'idle',
  };
  for (const [stage, positions] of Object.entries(STAGE_POSITIONS) as Array<
    [MeetingStage, readonly RoundtablePosition[]]
  >) {
    const status = deriveStageStatus(record.turns.filter((turn) => turn.stage === stage));
    if (!status) continue;
    for (const position of positions) statuses[position] = status;
  }
  return { record, statuses };
}
