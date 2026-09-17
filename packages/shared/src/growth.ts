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
