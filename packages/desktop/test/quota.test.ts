import { describe, expect, it } from 'vitest';
import type { CommercialAccountOverview } from '@clawwork/shared';
import {
  evaluateCommercialSendAccess,
  evaluateQuota,
  QUOTA_WARN_PERCENT,
  QUOTA_DEGRADE_PERCENT,
} from '../src/renderer/lib/quota';

function overviewWith(license: CommercialAccountOverview['license']): CommercialAccountOverview {
  return {
    account: { userId: 'u-1', phone: null, email: null, nickname: null, avatar: null },
    org: null,
    license,
    device: { fingerprint: 'fp', shortFingerprint: 'fp' },
    fetchedAt: '2026-09-15T00:00:00.000Z',
  };
}

describe('evaluateQuota', () => {
  it('blocks a licence without quota', () => {
    expect(evaluateQuota(0, 0).level).toBe('exhausted');
  });

  it('reports ok below the warning threshold', () => {
    expect(evaluateQuota(1000, 100).level).toBe('ok');
  });

  it('reports warn at the warning threshold', () => {
    expect(evaluateQuota(1000, 800).level).toBe('warn');
    expect(QUOTA_WARN_PERCENT).toBe(80);
  });

  it('reports degrade at the degrade threshold', () => {
    expect(evaluateQuota(1000, 950).level).toBe('degrade');
    expect(QUOTA_DEGRADE_PERCENT).toBe(95);
  });

  it('reports exhausted when the whole quota is used', () => {
    expect(evaluateQuota(1000, 1000).level).toBe('exhausted');
  });

  it('reports exhausted when usage overshoots the quota', () => {
    expect(evaluateQuota(1000, 1200).level).toBe('exhausted');
  });

  it('reports exhausted when the balance was never read', () => {
    expect(evaluateQuota(1000, null).level).toBe('unknown-exhausted');
  });

  it('reports exhausted when the balance reads as NaN', () => {
    expect(evaluateQuota(1000, Number.NaN).level).toBe('unknown-exhausted');
  });

  it('blocks when the balance reads as Infinity', () => {
    expect(evaluateQuota(1000, Number.POSITIVE_INFINITY).level).toBe('unknown-exhausted');
  });

  it('reports exhausted when the balance reads as negative Infinity', () => {
    expect(evaluateQuota(1000, Number.NEGATIVE_INFINITY).level).toBe('unknown-exhausted');
  });

  it('blocks an unreadable quota', () => {
    expect(evaluateQuota(Number.NaN, 0).level).toBe('unknown-exhausted');
  });

  it('computes the remaining percentage', () => {
    expect(evaluateQuota(1000, 250).remainingPercent).toBe(75);
  });
});

describe('evaluateCommercialSendAccess', () => {
  it('blocks while the current account snapshot is loading', () => {
    expect(evaluateCommercialSendAccess('loading', null)).toEqual({ allowed: false, reason: 'verifying' });
  });

  it('does not authorize from a cached snapshot when the current read failed', () => {
    const cached = overviewWith({
      activated: true,
      licenseKey: 'RY-OLD',
      sku: 'USB',
      status: 'active',
      expiresAt: null,
      tokenQuotaMicros: 1000,
      tokenUsedMicros: 10,
    });
    expect(evaluateCommercialSendAccess('offline', cached)).toEqual({ allowed: false, reason: 'unavailable' });
  });

  it('blocks an account without a licence', () => {
    expect(evaluateCommercialSendAccess('ready', overviewWith(null))).toEqual({
      allowed: false,
      reason: 'unlicensed',
    });
  });

  it('blocks an inactive or unactivated licence', () => {
    const inactive = overviewWith({
      activated: false,
      licenseKey: 'RY-1',
      sku: 'USB',
      status: 'active',
      expiresAt: null,
      tokenQuotaMicros: 1000,
      tokenUsedMicros: 10,
    });
    expect(evaluateCommercialSendAccess('ready', inactive)).toEqual({ allowed: false, reason: 'unlicensed' });
  });

  it('allows only a verified active licence with remaining quota', () => {
    const current = overviewWith({
      activated: true,
      licenseKey: 'RY-1',
      sku: 'USB',
      status: 'active',
      expiresAt: null,
      tokenQuotaMicros: 1000,
      tokenUsedMicros: 10,
    });
    expect(evaluateCommercialSendAccess('ready', current)).toMatchObject({
      allowed: true,
      verdict: { level: 'ok', remainingPercent: 99 },
    });
  });
});
