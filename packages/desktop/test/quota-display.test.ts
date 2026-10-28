import { describe, expect, it } from 'vitest';
import { deriveQuotaDisplay, readHeldView } from '../src/renderer/lib/quota-display';

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

/**
 * 预占（held）三态判据 —— 账户页 / Dashboard / 顶栏钱包**共用**这一份
 * （r14 返工：原先只有账户页有判据，同一块屏上顶栏照样给数字）。
 */
describe('readHeldView', () => {
  it('读到确定读数（含 0）⇒ 可见，且原样透传', () => {
    expect(readHeldView({ tokenHeldMicros: 50_000_000, heldComplete: true })).toEqual({
      micros: 50_000_000,
      unknown: false,
    });
    expect(readHeldView({ tokenHeldMicros: 0, heldComplete: true })).toEqual({ micros: 0, unknown: false });
  });

  it('后端明说口径不可判定 ⇒ 未知（哪怕带了数值）', () => {
    expect(readHeldView({ tokenHeldMicros: 50_000_000, heldComplete: false }).unknown).toBe(true);
    expect(readHeldView({ heldComplete: false }).unknown).toBe(true);
  });

  it('读数缺省（老后端 / relay 不可达）⇒ 同样是未知，绝不折成"没有预占"', () => {
    expect(readHeldView({}).unknown).toBe(true);
    expect(readHeldView(null).unknown).toBe(false); // 没有卡可谈预占（调用方另有分支）
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, '50']) {
      expect(readHeldView({ tokenHeldMicros: bad as unknown as number, heldComplete: true }).unknown).toBe(true);
    }
  });
});
