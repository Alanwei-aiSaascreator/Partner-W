import { describe, it, expect } from 'vitest';
import { CUSTOM_RECHARGE_MAX_CENTS, CUSTOM_RECHARGE_MIN_CENTS, parseRechargeYuanToCents } from '../src/constants';

describe('parseRechargeYuanToCents', () => {
  it('turns whole yuan into cents', () => {
    expect(parseRechargeYuanToCents('1')).toBe(100);
    expect(parseRechargeYuanToCents('10')).toBe(1000);
    expect(parseRechargeYuanToCents('500')).toBe(50000);
  });

  it('turns jiao and fen into cents', () => {
    expect(parseRechargeYuanToCents('1.5')).toBe(150);
    expect(parseRechargeYuanToCents('1.05')).toBe(105);
    // 0.01 元 = 1 分，能解析，但低于 ¥1 的下限
    expect(parseRechargeYuanToCents('0.01')).toBeNull();
  });

  it('is exact where float multiplication is not', () => {
    // Number('1.15') * 100 is 114.99999999999999 — rounding hides it, but the
    // parser should not be relying on that.
    expect(parseRechargeYuanToCents('1.15')).toBe(115);
    expect(parseRechargeYuanToCents('8.29')).toBe(829);
    expect(parseRechargeYuanToCents('123.45')).toBe(12345);
  });

  it('accepts the bounds exactly', () => {
    expect(parseRechargeYuanToCents(String(CUSTOM_RECHARGE_MIN_CENTS / 100))).toBe(CUSTOM_RECHARGE_MIN_CENTS);
    expect(parseRechargeYuanToCents(String(CUSTOM_RECHARGE_MAX_CENTS / 100))).toBe(CUSTOM_RECHARGE_MAX_CENTS);
  });

  it('rejects amounts outside the bounds', () => {
    expect(parseRechargeYuanToCents('0.99')).toBeNull();
    expect(parseRechargeYuanToCents('500.01')).toBeNull();
    expect(parseRechargeYuanToCents('1000')).toBeNull();
    expect(parseRechargeYuanToCents('0')).toBeNull();
  });

  it('rejects things that are not amounts', () => {
    expect(parseRechargeYuanToCents('')).toBeNull();
    expect(parseRechargeYuanToCents('   ')).toBeNull();
    expect(parseRechargeYuanToCents('abc')).toBeNull();
    expect(parseRechargeYuanToCents('1.234')).toBeNull(); // 3 decimals
    expect(parseRechargeYuanToCents('-10')).toBeNull();
    expect(parseRechargeYuanToCents('1e2')).toBeNull();
    expect(parseRechargeYuanToCents('.5')).toBeNull();
    expect(parseRechargeYuanToCents('1.')).toBeNull();
    expect(parseRechargeYuanToCents('5 0')).toBeNull();
  });

  it('ignores surrounding whitespace', () => {
    expect(parseRechargeYuanToCents('  20  ')).toBe(2000);
  });
});
