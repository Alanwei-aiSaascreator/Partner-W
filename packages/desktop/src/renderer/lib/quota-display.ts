export function deriveQuotaDisplay(total: number, used: number) {
  const safeTotal = Number.isFinite(total) ? Math.max(0, total) : 0;
  const safeUsed = Number.isFinite(used) ? Math.max(0, used) : 0;
  const remaining = Math.max(0, safeTotal - safeUsed);
  const remainingPercent = safeTotal > 0 ? Math.min(100, (remaining / safeTotal) * 100) : 0;
  return { remaining, remainingPercent };
}
