/**
 * 成长值 / 悬赏的 raw → DTO 归一化。
 *
 * 与 `community-service` / `agent-template-service` 同一套路：数据库回来的是
 * snake_case 的裸行，可能缺字段、可能是垃圾（RPC 换了返回形状、旧服务端…），
 * 所以**逐字段收敛**，绝不 `as` 一把梭。数字收敛成有限数、布尔只有 true 才算真、
 * 未知状态压成终态 `cancelled`（宁可显示成"已取消"，也不给界面一个不存在的状态）。
 */
import {
  BOUNTY_STATUSES,
  type Bounty,
  type BountyStatus,
  type DailyTask,
  type GrowthEntry,
  type GrowthSummary,
} from '@clawwork/shared';

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

const num = (value: unknown, fallback = 0): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const str = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);
const bool = (value: unknown): boolean => value === true;
const nullableStr = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

function status(value: unknown): BountyStatus {
  return BOUNTY_STATUSES.includes(value as BountyStatus) ? (value as BountyStatus) : 'cancelled';
}

export function normalizeGrowthSummary(raw: unknown): GrowthSummary {
  const row = record(raw);
  return {
    balance: num(row.balance),
    totalEarned: num(row.total_earned),
    level: Math.max(1, num(row.level, 1)),
    toNextLevel: num(row.to_next_level, 200),
    checkedInToday: bool(row.checked_in_today),
    badges: Array.isArray(row.badges) ? row.badges.filter((b): b is string => typeof b === 'string') : [],
  };
}

export function normalizeGrowthHistory(raw: unknown): GrowthEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => record(item))
    .filter((row) => typeof row.id === 'string')
    .map((row) => ({
      id: String(row.id),
      amount: num(row.amount),
      reason: str(row.reason),
      refId: str(row.ref_id),
      note: str(row.note),
      createdAt: str(row.created_at),
    }));
}

/**
 * 每日任务（迁移 065 的 `daily_task_list()`）。
 *
 * ⭐ 没有 `task` 键的行**丢掉** —— 任务是按键去词表和派发动作的，
 *    留一行没键的只会给界面一个点不动的空气按钮。
 *
 * ⭐⭐ `done` / `claimed` 用**严格 true**：这两个布尔是"能不能领"的唯一依据，
 *    宽松判真会让**没做过的事显示成能领**，点下去后端回 `task_not_done`，
 *    用户看到的是"点了没反应"。漏判只是让人多点一次，方向安全得多。
 */
export function normalizeDailyTasks(raw: unknown): DailyTask[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => record(item))
    .filter((row) => typeof row.task === 'string' && row.task !== '')
    .map((row) => ({
      task: String(row.task),
      reward: num(row.reward),
      done: bool(row.done),
      claimed: bool(row.claimed),
    }));
}

export function normalizeBounties(raw: unknown): Bounty[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => record(item))
    .filter((row) => typeof row.id === 'string')
    .map((row) => ({
      id: String(row.id),
      title: str(row.title),
      description: str(row.description),
      reward: num(row.reward),
      status: status(row.status),
      authorId: str(row.author_id),
      authorName: str(row.author_name),
      claimantId: nullableStr(row.claimant_id),
      claimantName: nullableStr(row.claimant_name),
      submittedNote: str(row.submitted_note),
      createdAt: str(row.created_at),
      acceptedAt: nullableStr(row.accepted_at),
      isMine: bool(row.is_mine),
      isClaimedByMe: bool(row.is_claimed_by_me),
      canClaim: bool(row.can_claim),
      canRelease: bool(row.can_release),
      canSubmit: bool(row.can_submit),
      canAccept: bool(row.can_accept),
      canReject: bool(row.can_reject),
      canCancel: bool(row.can_cancel),
    }));
}
