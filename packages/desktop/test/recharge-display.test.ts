import { describe, expect, it } from 'vitest';
import { customRechargeCreditsText, rechargeCreditsText } from '../src/renderer/lib/recharge-display';

/**
 * BUG-081 / C-A（2026-10-15）：充值展示的「支付金额 → 到账积分」换算与文案。
 *
 * 冻结口径：1 元 = 100 分 = 100 积分 ⇒ 1 分 = 1 积分。
 * 用户口径（2026-10-15，覆盖审计原案的“基础/赠送/合计”拆分）：界面只按比例展示，
 * 不显示赠送（本文件也不接受 bonus 入参——赠送不参与这里的任何计算）。
 */
describe('rechargeCreditsText —— 支付金额（分）→ 到账积分文案', () => {
  it('1 元 = 100 积分：¥100（10000 分）→ 10,000 积分', () => {
    expect(rechargeCreditsText(10000)).toBe('10,000');
  });

  it('小额整数直接显示（¥1.23 → 123 积分）', () => {
    expect(rechargeCreditsText(100)).toBe('100');
    expect(rechargeCreditsText(123)).toBe('123');
    expect(rechargeCreditsText(50000)).toBe('50,000');
  });

  it('非法金额返回 null（不产生 NaN / -0 文案）', () => {
    expect(rechargeCreditsText(null)).toBeNull();
    expect(rechargeCreditsText(Number.NaN)).toBeNull();
    expect(rechargeCreditsText(Number.POSITIVE_INFINITY)).toBeNull();
    expect(rechargeCreditsText(1.5)).toBeNull(); // 分必须是整数
    expect(rechargeCreditsText(-100)).toBeNull();
  });

  it('⚠️ 不与 formatCredits 混用：这里的入参是「分」，不是微积分', () => {
    // formatCredits 收微积分（1 积分 = 1e6 微积分）。把金额原值直接喂进去会
    // 得到 0.01 这类 1e6 倍错位的显示——所以充值侧用本函数，输出与入参同值（×1）。
    expect(rechargeCreditsText(123)).toBe('123'); // 而不是 formatCredits(123) = '<0.01'
  });
});

describe('customRechargeCreditsText —— 自定义金额输入 → 到账积分文案', () => {
  it('¥1.23 → 123 积分；¥1.5 → 150 积分（复用整数分解析器）', () => {
    expect(customRechargeCreditsText('1.23')).toBe('123');
    expect(customRechargeCreditsText('1.5')).toBe('150');
    expect(customRechargeCreditsText('500')).toBe('50,000');
  });

  it('与既有校验完全一致：非法/越界输入返回 null', () => {
    expect(customRechargeCreditsText('')).toBeNull();
    expect(customRechargeCreditsText('abc')).toBeNull();
    expect(customRechargeCreditsText('0.99')).toBeNull(); // 低于 ¥1 下限
    expect(customRechargeCreditsText('501')).toBeNull(); // 高于 ¥500 上限
    expect(customRechargeCreditsText('1.234')).toBeNull(); // 超过两位小数
  });
});
