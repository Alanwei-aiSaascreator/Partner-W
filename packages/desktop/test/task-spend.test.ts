import { describe, expect, it } from 'vitest';
import { EMPTY_TASK_SPEND, addTurnSpend } from '../src/renderer/lib/task-spend.js';

/**
 * 「本次任务累计消耗」（2026-10-17 用户要求）。
 *
 * 三条判据：
 *  ① 同一轮被重放（同一个 `at`）只能计一次 —— 否则屏幕上会出现翻倍的数字；
 *  ② 不同任务各算各的（切任务不能串账）；
 *  ③ 非法/零值不写（余额读不到时 `micros=0`，不该出现"累计 0"）。
 */
describe('addTurnSpend', () => {
  it('逐轮累加，微积分保留给 formatCredits 去格式化', () => {
    const first = addTurnSpend(EMPTY_TASK_SPEND, 't1', 1_500_000, 1000);
    const second = addTurnSpend(first, 't1', 500_000, 2000);
    expect(second.totals.t1).toBe(2_000_000);
  });

  it('⭐ 同一条结算重放（at 相同或更早）不重复计入', () => {
    const first = addTurnSpend(EMPTY_TASK_SPEND, 't1', 1_000_000, 1000);
    const replay = addTurnSpend(first, 't1', 1_000_000, 1000);
    expect(replay).toBe(first); // 引用不变 ⇒ 调用方跳过 setState
    const older = addTurnSpend(first, 't1', 1_000_000, 999);
    expect(older).toBe(first);
  });

  it('不同任务互不影响', () => {
    const a = addTurnSpend(EMPTY_TASK_SPEND, 't1', 1_000_000, 1000);
    const b = addTurnSpend(a, 't2', 2_000_000, 1000);
    expect(b.totals).toEqual({ t1: 1_000_000, t2: 2_000_000 });
  });

  it('零值/负值/脏数据/无任务 id 一律不写', () => {
    expect(addTurnSpend(EMPTY_TASK_SPEND, 't1', 0, 1000)).toBe(EMPTY_TASK_SPEND);
    expect(addTurnSpend(EMPTY_TASK_SPEND, 't1', -5, 1000)).toBe(EMPTY_TASK_SPEND);
    expect(addTurnSpend(EMPTY_TASK_SPEND, 't1', Number.NaN, 1000)).toBe(EMPTY_TASK_SPEND);
    expect(addTurnSpend(EMPTY_TASK_SPEND, undefined, 1_000_000, 1000)).toBe(EMPTY_TASK_SPEND);
  });
});
