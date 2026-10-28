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

/** `YYYY-MM-DD`（服务端 `growth_today()` 与签到 `ref_id` 就是这个形状）。 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Asia/Shanghai 的日期串（`YYYY-MM-DD`）。
 *
 * ⚠️ **必须与服务端的 `growth_today()` 用同一个时区**（迁移 46 里写死 `Asia/Shanghai`）。
 *    用本机时区的话，在非 +08:00 的机器上会差一天 ⇒ 连续签到整条错位。
 */
export function shanghaiDate(now: Date = new Date()): string {
  // en-CA 的短日期格式恰好就是 YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** 前一天。走 UTC 算术 —— 本地时间会踩夏令时，UTC 不会。 */
function previousDay(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

/**
 * 连续签到天数。**派生**出来的 —— 服务端没有这个字段。
 *
 * 签到流水的 `refId` 就是**签的那天**（服务端写 `growth_today()`），
 * 所以「连续几天」= 从今天往回数、连续存在的那些日期。
 *
 * ⭐ **今天还没签不算断**：起点取今天（签了）或昨天（还没签但昨天签了）。
 *    一天要**过完**才算断 —— 否则每天早上所有人都会看到 0。
 *
 * 🔴🔴 **`complete=false` 一律返回 0（=不显示）。**
 *    `growthHistory` 只取 50 条，悬赏流水会把窗口占满、把签到那几天挤出视野，
 *    这时数出来的"连续 3 天"真身可能是 7 天。**算错比不显示更糟** ——
 *    用户会以为自己的连续记录断了。宁可不说。
 */
export function computeCheckInStreak(entries: GrowthEntry[], opts: { today: string; complete: boolean }): number {
  if (!opts.complete) return 0;
  const days = new Set(entries.filter((e) => e.reason === 'check_in' && DATE_RE.test(e.refId)).map((e) => e.refId));
  if (days.size === 0) return 0;

  let cursor = opts.today;
  if (!days.has(cursor)) cursor = previousDay(cursor);

  let streak = 0;
  while (days.has(cursor)) {
    streak++;
    cursor = previousDay(cursor);
  }
  return streak;
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
