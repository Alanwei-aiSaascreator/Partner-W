export const QUOTA_WARN_PERCENT = 80;
export const QUOTA_DEGRADE_PERCENT = 95;

export type QuotaLevel = 'unlimited' | 'ok' | 'warn' | 'degrade' | 'exhausted' | 'unknown-exhausted';

export interface QuotaVerdict {
  level: QuotaLevel;
  usedPercent: number;
  remainingPercent: number;
}

export function evaluateQuota(quotaCents: number, usedCents: number | null): QuotaVerdict {
  if (!Number.isFinite(quotaCents) || quotaCents <= 0) {
    return { level: 'unlimited', usedPercent: 0, remainingPercent: 100 };
  }

  if (usedCents === null || !Number.isFinite(usedCents)) {
    return { level: 'unknown-exhausted', usedPercent: 100, remainingPercent: 0 };
  }

  const usedPercent = (usedCents / quotaCents) * 100;
  const remainingPercent = Math.max(0, 100 - usedPercent);

  if (usedCents >= quotaCents) return { level: 'exhausted', usedPercent, remainingPercent: 0 };
  if (usedPercent >= QUOTA_DEGRADE_PERCENT) return { level: 'degrade', usedPercent, remainingPercent };
  if (usedPercent >= QUOTA_WARN_PERCENT) return { level: 'warn', usedPercent, remainingPercent };
  return { level: 'ok', usedPercent, remainingPercent };
}
