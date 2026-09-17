import type { CommercialAccountOverview } from '@clawwork/shared';

export const QUOTA_WARN_PERCENT = 80;
export const QUOTA_DEGRADE_PERCENT = 95;

export type QuotaLevel = 'ok' | 'warn' | 'degrade' | 'exhausted' | 'unknown-exhausted';

export interface QuotaVerdict {
  level: QuotaLevel;
  usedPercent: number;
  remainingPercent: number;
}

export function evaluateQuota(quotaMicros: number, usedMicros: number | null): QuotaVerdict {
  if (!Number.isFinite(quotaMicros)) {
    return { level: 'unknown-exhausted', usedPercent: 100, remainingPercent: 0 };
  }

  if (quotaMicros <= 0) {
    return { level: 'exhausted', usedPercent: 100, remainingPercent: 0 };
  }

  if (usedMicros === null || !Number.isFinite(usedMicros)) {
    return { level: 'unknown-exhausted', usedPercent: 100, remainingPercent: 0 };
  }

  const usedPercent = (usedMicros / quotaMicros) * 100;
  const remainingPercent = Math.max(0, 100 - usedPercent);

  if (usedMicros >= quotaMicros) return { level: 'exhausted', usedPercent, remainingPercent: 0 };
  if (usedPercent >= QUOTA_DEGRADE_PERCENT) return { level: 'degrade', usedPercent, remainingPercent };
  if (usedPercent >= QUOTA_WARN_PERCENT) return { level: 'warn', usedPercent, remainingPercent };
  return { level: 'ok', usedPercent, remainingPercent };
}

export type CommercialSnapshotStatus = 'idle' | 'loading' | 'ready' | 'offline';
export type CommercialBlockReason = 'verifying' | 'unavailable' | 'unlicensed' | 'exhausted';
export type CommercialSendAccess =
  | { allowed: true; verdict: QuotaVerdict; stale?: boolean }
  | { allowed: false; reason: CommercialBlockReason; verdict?: QuotaVerdict };

/**
 * 能不能发消息。
 *
 * ## 2026-09-17 改判：读不到时用**最近一次成功的快照**放行
 *
 * 原先 `status !== 'ready'` 一律拦。实机代价：一次 8 秒网络抖动把状态打成
 * `offline` ⇒ 发送被拦，而弹的对话框是「Token 额度已用尽，充值或兑换卡密后可继续使用」
 * —— **把"读不到"说成了"用尽"**，用户账号里明明还有额度。
 *
 * 改判依据（两条都是事实，不是偏好）：
 *   ① 计费边界在**服务端**：`services/relay/src/index.ts` 自己会 `evaluateQuota`，
 *      对真耗尽的请求回 `insufficient balance`。客户端闸门只是提前给个好听的说法。
 *   ② 同款先例就在仓库里：`auth-classify.ts` 为「8 秒抖动被固化成没登录」而立，
 *      原则是"把『暂时』误判成『确定』，代价大得多"。
 *
 * 放行会带 `stale: true`，好让上层知道这是旧数据。
 * ⚠️ **快照里就已经用尽/没有额度 ⇒ 照样拦**（真用尽不因为"这次没读到"就放过）。
 */
export function evaluateCommercialSendAccess(
  status: CommercialSnapshotStatus,
  overview: CommercialAccountOverview | null,
): CommercialSendAccess {
  const license = overview?.license;
  const usable = Boolean(overview?.account && license && license.activated && license.status === 'active');

  if (usable && license) {
    const verdict = evaluateQuota(license.tokenQuotaMicros, license.tokenUsedMicros);

    // 确定用尽：额度 ≤ 0，或额度 > 0 但已用满
    if (verdict.level === 'exhausted') return { allowed: false, reason: 'exhausted', verdict };

    // 说不清（额度或用量本身读成了空/NaN）—— 这是**数据不全**，不是"用尽"。
    // 用"暂时读不到"的话术，别把用户推到充值框前。
    if (verdict.level === 'unknown-exhausted') return { allowed: false, reason: 'unavailable', verdict };

    return status === 'ready' ? { allowed: true, verdict } : { allowed: true, verdict, stale: true };
  }

  // 没有任何可用快照。⚠️ 必须先分"读到了但没激活"与"压根没读到"：
  //    前者是**确定**的 unlicensed（该去激活/兑换），后者只能说暂时读不到。
  if (status === 'ready') return { allowed: false, reason: 'unlicensed' };
  // 还没读过任何东西 ⇒ 正在确认
  if (status === 'idle' || status === 'loading') return { allowed: false, reason: 'verifying' };
  return { allowed: false, reason: 'unavailable' };
}

/**
 * 拦截时**该说什么**。抽成纯函数，好让文案与原因一一对应地被测到 ——
 * 原来四种原因共用一句「额度已用尽，请充值」，正是这次实机 bug 的直接成因。
 *
 * `action` 决定确认按钮干什么：`recharge` 去账号页，`retry` 重新拉一次额度。
 */
export interface QuotaBlockCopy {
  titleKey: string;
  descKey: string;
  confirmKey: string;
  action: 'recharge' | 'retry';
}

const QUOTA_BLOCK_COPY: Record<CommercialBlockReason, QuotaBlockCopy> = {
  exhausted: {
    titleKey: 'usage.blockedTitle',
    descKey: 'usage.blockedDesc',
    confirmKey: 'account.recharge',
    action: 'recharge',
  },
  unlicensed: {
    titleKey: 'usage.unlicensedTitle',
    descKey: 'usage.unlicensedDesc',
    confirmKey: 'account.recharge',
    action: 'recharge',
  },
  verifying: {
    titleKey: 'usage.unknownTitle',
    descKey: 'usage.unknownDesc',
    confirmKey: 'common.retry',
    action: 'retry',
  },
  unavailable: {
    titleKey: 'usage.unknownTitle',
    descKey: 'usage.unknownDesc',
    confirmKey: 'common.retry',
    action: 'retry',
  },
};

export function quotaBlockCopy(reason: CommercialBlockReason): QuotaBlockCopy {
  return QUOTA_BLOCK_COPY[reason];
}
