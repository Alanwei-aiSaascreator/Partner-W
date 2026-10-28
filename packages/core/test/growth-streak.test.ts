import { describe, expect, it } from 'vitest';
import { computeCheckInStreak, shanghaiDate } from '../src/index.js';
import type { GrowthEntry } from '@clawwork/shared';

/**
 * 连续签到天数。
 *
 * ⚠️ 这是**派生**出来的，服务端没有这个字段 —— `growth_history` 回的是一串流水，
 *    而签到那几条的 `refId` 就是**签的那天**（服务端写的是 `growth_today()`，
 *    即 Asia/Shanghai 的日期串）。所以「连续几天」= 从今天往回数连续存在的日期。
 */
const entry = (reason: string, refId: string): GrowthEntry => ({
  id: `${reason}-${refId}`,
  amount: 20,
  reason,
  refId,
  note: '',
  createdAt: '2026-09-27T00:00:00Z',
});

const TODAY = '2026-09-27';

describe('shanghaiDate', () => {
  /**
   * ⭐ 必须与**服务端**的 `growth_today()` 用同一个时区。
   * 用本机时区会在非 +08:00 的机器上差一天 ⇒ 连续天数整条错位。
   */
  it('按 Asia/Shanghai 取日期，不看本机时区', () => {
    // 2026-09-27T16:30:00Z = 上海时间 2026-09-28 00:30
    expect(shanghaiDate(new Date('2026-09-27T16:30:00Z'))).toBe('2026-09-28');
    // 2026-09-27T15:30:00Z = 上海时间 2026-09-27 23:30
    expect(shanghaiDate(new Date('2026-09-27T15:30:00Z'))).toBe('2026-09-27');
  });
});

describe('computeCheckInStreak', () => {
  /**
   * 🔴🔴 **被截断的历史一律返回 0（=不显示）。**
   *
   * `growthHistory` 只取 50 条。悬赏那些流水会把窗口占满，签到那几天就被挤出视野 ——
   * 此时数出来的"连续 3 天"可能真身是 7 天。**算错比不显示更糟**：
   * 用户会以为自己的连续记录断了。所以宁可不说。
   */
  it('🔴 历史可能被截断（complete=false）⇒ 返回 0，不猜', () => {
    const rows = [entry('check_in', '2026-09-27'), entry('check_in', '2026-09-26')];
    expect(computeCheckInStreak(rows, { today: TODAY, complete: false })).toBe(0);
  });

  it('今天 + 昨天 + 前天 ⇒ 3', () => {
    const rows = [entry('check_in', '2026-09-27'), entry('check_in', '2026-09-26'), entry('check_in', '2026-09-25')];
    expect(computeCheckInStreak(rows, { today: TODAY, complete: true })).toBe(3);
  });

  /**
   * ⭐ **今天还没签，但昨天签了 ⇒ 连续没断。**
   *
   * 一天要到**过完**才算断：早上打开应用时若从今天起算，所有人都会看到 0。
   * 起点是今天（签了）或昨天（还没签但昨天签了）。
   */
  it('⭐ 今天还没签、昨天签了 ⇒ 仍然算连续', () => {
    const rows = [entry('check_in', '2026-09-26'), entry('check_in', '2026-09-25')];
    expect(computeCheckInStreak(rows, { today: TODAY, complete: true })).toBe(2);
  });

  it('中间断了一天 ⇒ 只数到断点', () => {
    const rows = [
      entry('check_in', '2026-09-27'),
      entry('check_in', '2026-09-26'),
      // 09-25 缺
      entry('check_in', '2026-09-24'),
      entry('check_in', '2026-09-23'),
    ];
    expect(computeCheckInStreak(rows, { today: TODAY, complete: true })).toBe(2);
  });

  it('昨天和今天都没签 ⇒ 0（断了）', () => {
    const rows = [entry('check_in', '2026-09-25'), entry('check_in', '2026-09-24')];
    expect(computeCheckInStreak(rows, { today: TODAY, complete: true })).toBe(0);
  });

  it('一条签到都没有 ⇒ 0', () => {
    expect(computeCheckInStreak([], { today: TODAY, complete: true })).toBe(0);
  });

  /**
   * ⭐ **只认签到**：悬赏流水的 `refId` 是悬赏 id、日期也不连续，
   *    混进来会凭空造出"连续天数"。
   */
  it('⭐ 悬赏流水不参与（只认 reason=check_in）', () => {
    const rows = [
      entry('check_in', '2026-09-27'),
      entry('bounty_escrow', '2026-09-26'),
      entry('bounty_reward', '2026-09-25'),
    ];
    expect(computeCheckInStreak(rows, { today: TODAY, complete: true })).toBe(1);
  });

  it('跨月边界算得对（09-01 的昨天是 08-31）', () => {
    const rows = [entry('check_in', '2026-09-01'), entry('check_in', '2026-08-31'), entry('check_in', '2026-08-30')];
    expect(computeCheckInStreak(rows, { today: '2026-09-01', complete: true })).toBe(3);
  });

  it('跨年边界算得对（01-01 的昨天是去年 12-31）', () => {
    const rows = [entry('check_in', '2027-01-01'), entry('check_in', '2026-12-31')];
    expect(computeCheckInStreak(rows, { today: '2027-01-01', complete: true })).toBe(2);
  });

  it('同一天重复的签到流水只算一天', () => {
    const rows = [entry('check_in', '2026-09-27'), entry('check_in', '2026-09-27')];
    expect(computeCheckInStreak(rows, { today: TODAY, complete: true })).toBe(1);
  });

  it('refId 是垃圾（不是日期）⇒ 忽略，不炸', () => {
    const rows = [entry('check_in', '2026-09-27'), entry('check_in', 'not-a-date'), entry('check_in', '')];
    expect(computeCheckInStreak(rows, { today: TODAY, complete: true })).toBe(1);
  });
});
