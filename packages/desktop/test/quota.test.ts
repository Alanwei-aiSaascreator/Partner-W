import { describe, expect, it } from 'vitest';
import { evaluateQuota, QUOTA_WARN_PERCENT, QUOTA_DEGRADE_PERCENT } from '../src/renderer/lib/quota';

describe('evaluateQuota', () => {
  it('treats a licence without quota as unlimited', () => {
    expect(evaluateQuota(0, 0).level).toBe('unlimited');
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

  it('treats an unreadable quota as unlimited rather than blocking every send', () => {
    expect(evaluateQuota(Number.NaN, 0).level).toBe('unlimited');
  });

  it('computes the remaining percentage', () => {
    expect(evaluateQuota(1000, 250).remainingPercent).toBe(75);
  });
});
