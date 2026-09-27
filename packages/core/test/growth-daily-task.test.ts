import { describe, expect, it } from 'vitest';
import { describeGrowthError, normalizeDailyTasks } from '../src/index.js';

/**
 * 每日任务（迁移 065）的归一化与错误码。
 *
 * ⚠️ 这一层存在的理由和别的 normalizer 一样：RPC 回来的是 snake_case 裸行，
 *    可能缺字段、可能是垃圾（服务端换了返回形状、旧版本…）。**逐字段收敛，不 `as` 一把梭。**
 */
describe('normalizeDailyTasks', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    task: 'publish',
    reward: 10,
    done: true,
    claimed: false,
    ...over,
  });

  it('逐字段收敛成 camelCase', () => {
    expect(normalizeDailyTasks([row()])).toEqual([{ task: 'publish', reward: 10, done: true, claimed: false }]);
  });

  it('不是数组 ⇒ 空数组（不是崩）', () => {
    expect(normalizeDailyTasks(null)).toEqual([]);
    expect(normalizeDailyTasks(undefined)).toEqual([]);
    expect(normalizeDailyTasks({})).toEqual([]);
    expect(normalizeDailyTasks('nope')).toEqual([]);
  });

  /**
   * ⭐ 没有 `task` 键的行**必须丢掉**：任务是按 key 去 i18n 词表和派发动作的，
   *    留一行没有键的会给界面一个点不动的空气按钮。
   */
  it('⭐ 没有 task 的行丢掉', () => {
    expect(normalizeDailyTasks([row(), { reward: 10, done: true }])).toHaveLength(1);
  });

  /**
   * ⭐⭐ `done` / `claimed` **只有 true 才算真**。
   *
   * 这两个布尔是界面按钮的**唯一**依据（能不能领）。宽松判真（`1` / `"true"` / 非空）会让
   * **没做过的事显示成能领**，点下去后端回 `task_not_done` —— 用户看到的是"点了没反应"。
   * 反过来漏判（把 true 当 false）只是让人多点一次，危害小得多。
   */
  it('⭐⭐ done/claimed 只有 true 才算真（垃圾值一律 false）', () => {
    const [task] = normalizeDailyTasks([row({ done: 1, claimed: 'true' })]);
    expect(task).toEqual({ task: 'publish', reward: 10, done: false, claimed: false });
  });

  it('reward 是垃圾 ⇒ 0（不是 NaN，NaN 会渲染成 "NaN"）', () => {
    expect(normalizeDailyTasks([row({ reward: 'abc' })])[0]?.reward).toBe(0);
    expect(normalizeDailyTasks([row({ reward: null })])[0]?.reward).toBe(0);
  });

  it('reward 是数字字符串 ⇒ 收敛成数字（PostgREST 回 int 有时是字符串）', () => {
    expect(normalizeDailyTasks([row({ reward: '10' })])[0]?.reward).toBe(10);
  });
});

describe('describeGrowthError：每日任务的两个新码', () => {
  it('invalid_task 有中文', () => {
    expect(describeGrowthError('invalid_task')).toMatch(/[一-龥]/);
  });

  /**
   * 🔴 这条是**防白送**那道闸的用户侧文案。
   *
   * ⚠️ 断言写成"不等于兜底"而不是"等于某句话"：只断言"有中文"的话，
   *    **兜底文案本身就是中文** ⇒ 就算这个码没进表，断言照样绿（本仓库栽过的形状）。
   */
  it('⭐ task_not_done 有自己的文案，不是兜底', () => {
    const fallback = describeGrowthError('a_code_that_does_not_exist');
    expect(describeGrowthError('task_not_done')).toMatch(/[一-龥]/);
    expect(
      describeGrowthError('task_not_done'),
      'task_not_done 退回了兜底文案 —— 用户会看到"操作没成功"，不知道自己只是还没做那件事',
    ).not.toBe(fallback);
  });

  it('invalid_task 也走了自己的文案', () => {
    expect(describeGrowthError('invalid_task')).not.toBe(describeGrowthError('a_code_that_does_not_exist'));
  });
});
