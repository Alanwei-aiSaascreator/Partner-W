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
  | { allowed: true; verdict: QuotaVerdict }
  | { allowed: false; reason: CommercialBlockReason; verdict?: QuotaVerdict };

export function evaluateCommercialSendAccess(
  status: CommercialSnapshotStatus,
  overview: CommercialAccountOverview | null,
): CommercialSendAccess {
  if (status === 'idle' || status === 'loading') return { allowed: false, reason: 'verifying' };
  if (status !== 'ready') return { allowed: false, reason: 'unavailable' };

  const license = overview?.license;
  if (!overview?.account || !license || !license.activated || license.status !== 'active') {
    return { allowed: false, reason: 'unlicensed' };
  }

  const verdict = evaluateQuota(license.tokenQuotaMicros, license.tokenUsedMicros);
  if (verdict.level === 'exhausted' || verdict.level === 'unknown-exhausted') {
    return { allowed: false, reason: 'exhausted', verdict };
  }
  return { allowed: true, verdict };
}
