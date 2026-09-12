import { describe, it, expect } from 'vitest';
import { formatCredits } from '../src/renderer/lib/utils';

/**
 * 额度显示。单位是**微积分**（1e-6 积分 = 1e-6 分）。
 *
 * 1 元 = 100 积分 = 100 分 = 1e8 微积分。
 *
 * ⚠️ 注意与 `formatCents` 的区别：那个是**真实货币**（充值赠送金额），
 *    显示 ¥。两个单位混了是 1e6 倍量级的错误，而且不会报错 ——
 *    所以它们是两个函数，不要合并。
 */
describe('formatCredits', () => {
  it('恰好 0 显示 0（不是 <0.01）', () => {
    expect(formatCredits(0)).toBe('0.00');
  });

  it('有值但小到两位数显示不出来时给 <0.01，而不是 0', () => {
    // 这是本次报障的起点：一次普通对话往往只有 1~2 积分，
    // 若小额被显示成 0，用户会以为「没扣费」。
    expect(formatCredits(1)).toBe('<0.01');
    expect(formatCredits(500)).toBe('<0.01');
    expect(formatCredits(9_999)).toBe('<0.01');
  });

  it('正好 0.01 积分就不再是 <0.01', () => {
    expect(formatCredits(10_000)).toBe('0.01');
  });

  it('常规额度按两位小数显示', () => {
    expect(formatCredits(1_000_000)).toBe('1.00');
    expect(formatCredits(1_680_000)).toBe('1.68');
    expect(formatCredits(123_456_789)).toBe('123.46');
  });

  it('大额用千分位且不带小数（阅读性优先）', () => {
    expect(formatCredits(6_100_000_000)).toBe('6,100');
    expect(formatCredits(1_000_000_000)).toBe('1,000');
  });

  it('负数（理论上不该出现）也不产生 NaN', () => {
    expect(formatCredits(-1_000_000)).toBe('-1.00');
  });

  it('脏数据归 0，不产生 NaN 文本', () => {
    expect(formatCredits(Number.NaN)).toBe('0');
    expect(formatCredits(Number.POSITIVE_INFINITY)).toBe('0');
  });

  it('⭐ 与 ¥ 的换算关系：6100 分额度的显示值是 6100 积分', () => {
    // 库里 token_quota_micros = 6100 分 × 1e6 = 6.1e9 微积分
    expect(formatCredits(6100 * 1_000_000)).toBe('6,100');
  });
});
