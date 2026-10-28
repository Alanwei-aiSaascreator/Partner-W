import { describe, it, expect } from 'vitest';
import { formatCredits, formatCreditsPrecise } from '../src/renderer/lib/utils';

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

/**
 * BUG-082（C-B §4）：**余额**要看得见小数。
 *
 * 旧 `formatCredits` 在 ≥1000 积分时四舍五入成整数 —— 1000.40 → 1000.10
 * 两笔已经结算的消耗在屏幕上都是「1,000」，用户读到的是"没扣费"。
 *
 * 方案（刻意选这条，而不是改 `formatCredits` 的默认行为）：
 *   · `formatCredits` 保持原样 —— 图表刻度、30 天汇总、总量这些**非余额**场景
 *     继续用整数形态（改了它们会全站变吵，而且那些数字本来就不是余额）；
 *   · 新增 `formatCreditsPrecise` 给**余额**用：始终两位小数 + 千分位。
 * 下面这组断言把这条分工锁住。
 */
describe('formatCreditsPrecise（余额展示）', () => {
  it('⭐ ≥1000 积分也保留两位小数：1000.40 → 1000.10 的消费看得见', () => {
    expect(formatCreditsPrecise(1000.4 * 1_000_000)).toBe('1,000.40');
    expect(formatCreditsPrecise(1000.1 * 1_000_000)).toBe('1,000.10');
    // 两个不同的余额必须是两个不同的字符串（旧格式化下它们都是 "1,000"）
    expect(formatCreditsPrecise(1000.4 * 1_000_000)).not.toBe(formatCreditsPrecise(1000.1 * 1_000_000));
  });

  it('千分位与两位小数并存', () => {
    expect(formatCreditsPrecise(6_100 * 1_000_000)).toBe('6,100.00');
    expect(formatCreditsPrecise(123_456_789)).toBe('123.46');
  });

  it('小额保持 <0.01 的说法，不虚构成 0', () => {
    expect(formatCreditsPrecise(9_999)).toBe('<0.01');
    expect(formatCreditsPrecise(0)).toBe('0.00');
  });

  it('脏数据不产生 NaN 文本', () => {
    expect(formatCreditsPrecise(Number.NaN)).toBe('0');
    expect(formatCreditsPrecise(Number.POSITIVE_INFINITY)).toBe('0');
  });

  it('负数（理论上不该出现）也不产生 NaN', () => {
    expect(formatCreditsPrecise(-1_000_000)).toBe('-1.00');
  });

  it('旧 formatCredits 的行为不被这次改动带走（非余额场景仍然整数化）', () => {
    expect(formatCredits(1000.4 * 1_000_000)).toBe('1,000');
  });
});
