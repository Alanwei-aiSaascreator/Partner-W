import { describe, expect, it } from 'vitest';
import { deriveQuotaDisplay } from '../src/renderer/lib/quota-display';

describe('deriveQuotaDisplay', () => {
  it('returns remaining amount and width', () => {
    expect(deriveQuotaDisplay(50_000, 12_500)).toEqual({ remaining: 37_500, remainingPercent: 75 });
  });

  it('clamps overspend at zero', () => {
    expect(deriveQuotaDisplay(100, 120)).toEqual({ remaining: 0, remainingPercent: 0 });
  });

  it('normalizes invalid values', () => {
    expect(deriveQuotaDisplay(Number.NaN, -10)).toEqual({ remaining: 0, remainingPercent: 0 });
  });
});
