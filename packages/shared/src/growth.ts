/**
 * P3：成长值 + 悬赏的共享类型。
 *
 * ⚠️ 成长值（growth）是**纯激励**：不可兑换、不可提现、与计费额度没有任何通路。
 *    与 billing 那套「积分」是两回事，别在类型层把它们混起来。
 */

export const BOUNTY_STATUSES = ['open', 'claimed', 'submitted', 'accepted', 'cancelled'] as const;
export type BountyStatus = (typeof BOUNTY_STATUSES)[number];

export type GrowthReason = 'check_in' | 'bounty_escrow' | 'bounty_reward' | 'bounty_refund';

export interface GrowthSummary {
  balance: number;
  totalEarned: number;
  level: number;
  toNextLevel: number;
  checkedInToday: boolean;
  badges: string[];
}

/**
 * 每日任务（迁移 065）。
 *
 * ⚠️ `task` 是**服务端目录里的键**（`daily_task_catalog()` 的 `task` 列），
 *    客户端**不硬编码清单** —— 服务端加一个任务，界面照样显示得出来
 *    （文案走 `growth.task_<键>`，没有就退回键名，与徽章 / 明细原因同一套兜底）。
 *
 * ⚠️ `done` 与 `claimed` **必须分得开**，三者对应三种界面状态：
 *    `done=false` ⇒ 还没做（灰的）；`done=true && claimed=false` ⇒ 可以领（高亮）；
 *    `claimed=true` ⇒ 今天领过了（打勾）。合成一个布尔会让用户看到"完成了但点不动"。
 */
export interface DailyTask {
  task: string;
  reward: number;
  done: boolean;
  claimed: boolean;
}

export interface GrowthEntry {
  id: string;
  amount: number;
  reason: string;
  refId: string;
  note: string;
  createdAt: string;
}

export interface Bounty {
  id: string;
  title: string;
  description: string;
  reward: number;
  status: BountyStatus;
  authorId: string;
  authorName: string;
  claimantId: string | null;
  claimantName: string | null;
  submittedNote: string;
  createdAt: string;
  acceptedAt: string | null;
  isMine: boolean;
  isClaimedByMe: boolean;
  canClaim: boolean;
  canRelease: boolean;
  canSubmit: boolean;
  canAccept: boolean;
  canReject: boolean;
  canCancel: boolean;
}
