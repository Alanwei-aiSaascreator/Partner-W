import { describe, expect, it } from 'vitest';
import {
  PORTRAIT_AGE_MAX,
  PORTRAIT_AGE_MIN,
  PORTRAIT_AXES,
  PORTRAIT_ROLE_CODES,
  derivePortrait,
  displayPortraitLetters,
  isCompletePortraitCode,
  isPortraitGender,
  parsePortraitAge,
  toOnboardingPortrait,
  withPortraitDetails,
  type PortraitAnswer,
  type PortraitAnswers,
} from '../src/renderer/lib/user-portrait';

/**
 * 3a 画像打分器（rulepack v1 §2/§3）。golden 值逐条手算核对：
 * 基线 50；"是"加分、"否"减分、跳过不加不减；共情另有 Q2/Q4 同号 +5 / 异号 −5。
 */
describe('derivePortrait', () => {
  it('scores all-yes and resolves the top tie by the rulepack §3 table order', () => {
    const result = derivePortrait(['yes', 'yes', 'yes', 'yes']);
    expect(result.axes).toEqual({ 外向力: 80, 探索力: 70, 理性力: 80, 条理力: 80, 共情力: 65 });
    expect(result.letters).toBe('ESTJ');
    // 衡川与百纳同为 80 分 ⇒ 取表序更靠前的衡川（确定性）。
    expect(result.role).toBe('hengchuan');
  });

  it('scores all-no and still returns a character', () => {
    const result = derivePortrait(['no', 'no', 'no', 'no']);
    expect(result.axes).toEqual({ 外向力: 20, 探索力: 30, 理性力: 20, 条理力: 20, 共情力: 45 });
    expect(result.letters).toBe('INFP');
    expect(result.role).toBe('hewei');
  });

  it('returns no role and no invented scores when every question is skipped', () => {
    const result = derivePortrait([null, null, null, null]);
    expect(result.axes).toEqual({ 外向力: 50, 探索力: 50, 理性力: 50, 条理力: 50, 共情力: 50 });
    expect(result.letters).toBe('XXXX');
    expect(result.role).toBeNull();
    expect(toOnboardingPortrait(result, true)).toBeNull();
  });

  it('keeps partial answers on the baseline instead of inventing the skipped ones', () => {
    const result = derivePortrait(['yes', 'no', null, 'yes']);
    expect(result.axes).toEqual({ 外向力: 60, 探索力: 30, 理性力: 60, 条理力: 70, 共情力: 55 });
    expect(result.letters).toBe('ENXJ');
    expect(result.role).toBe('hengchuan');
  });

  it('applies the Q2/Q4 empathy adjustment only when both questions are answered', () => {
    expect(derivePortrait(['yes', 'no', null, 'no']).axes['共情力']).toBe(65); // 同号 +5
    expect(derivePortrait(['yes', 'no', null, 'yes']).axes['共情力']).toBe(55); // 异号 −5
    expect(derivePortrait(['yes', null, 'no', null]).axes['共情力']).toBe(60); // 有跳过 ⇒ 不加不减
  });

  it('breaks two-way and three-way role ties by the rulepack §3 table order', () => {
    // 探索力 == 条理力（都是 30）⇒ 枕山与禾味同为 50 分，取表序靠前的枕山。
    expect(derivePortrait(['yes', 'no', null, 'no']).role).toBe('zhenshan');
    // 衡川 / 百纳 / 扬声同为 64 分 ⇒ 取表序最靠前的衡川。
    expect(derivePortrait([null, 'yes', null, 'yes']).role).toBe('hengchuan');
  });

  it('is deterministic, side-effect free and bounded for all 81 answer combinations', () => {
    const options: PortraitAnswer[] = ['yes', 'no', null];
    const combinations: PortraitAnswers[] = [];
    for (const first of options)
      for (const second of options)
        for (const third of options) for (const fourth of options) combinations.push([first, second, third, fourth]);
    expect(combinations).toHaveLength(81);

    for (const answers of combinations) {
      const snapshot = [...answers];
      const result = derivePortrait(answers);
      expect(derivePortrait(answers)).toEqual(result);
      expect([...answers]).toEqual(snapshot);
      for (const axis of PORTRAIT_AXES) {
        expect(Number.isInteger(result.axes[axis])).toBe(true);
        expect(result.axes[axis]).toBeGreaterThanOrEqual(0);
        expect(result.axes[axis]).toBeLessThanOrEqual(100);
      }
      expect(result.letters).toMatch(/^[EISTNFJPX]{4}$/);
      if (answers.every((answer) => answer === null)) {
        expect(result.role).toBeNull();
      } else {
        expect(PORTRAIT_ROLE_CODES).toContain(result.role);
      }
    }
  });

  it('wraps a derivation into a locked portrait record only when a role was chosen', () => {
    expect(toOnboardingPortrait(derivePortrait(['yes', 'yes', 'yes', 'yes']), true)).toEqual({
      axes: { 外向力: 80, 探索力: 70, 理性力: 80, 条理力: 80, 共情力: 65 },
      letters: 'ESTJ',
      role: 'hengchuan',
      ruleVersion: 'portrait-v1',
      locked: true,
    });
  });

  it('marks unanswered letters as unknown and only treats a full code as a type', () => {
    expect(displayPortraitLetters('ENXJ')).toBe('EN?J');
    expect(displayPortraitLetters('ESTJ')).toBe('ESTJ');
    expect(isCompletePortraitCode('ESTJ')).toBe(true);
    expect(isCompletePortraitCode('ENXJ')).toBe(false);
    expect(isCompletePortraitCode('XXXX')).toBe(false);
  });
});

/**
 * 形象层补充信息（2026-10-08，16 型形象）：性别/年龄只是"挑哪张素材"，**不进五维分数、
 * 不影响角色判定**；没填就不许占键（旧档案照读、旧测试照过）。
 */
describe('形象层补充信息（性别 / 年龄）', () => {
  const allYes = derivePortrait(['yes', 'yes', 'yes', 'yes']);

  it('性别只认 male / female，其余一律不是', () => {
    expect(isPortraitGender('male')).toBe(true);
    expect(isPortraitGender('female')).toBe(true);
    for (const value of ['m', 'F', '', null, undefined, 0, {}, [], 'nan']) {
      expect(isPortraitGender(value), String(value)).toBe(false);
    }
  });

  it('年龄只放行 1–120 的整数：空 / 越界 / 小数 / 字符串一律 null，不截断不取整', () => {
    expect(parsePortraitAge(PORTRAIT_AGE_MIN)).toBe(1);
    expect(parsePortraitAge(PORTRAIT_AGE_MAX)).toBe(120);
    expect(parsePortraitAge(28)).toBe(28);
    for (const value of [0, -1, 121, 1000, 28.5, '28', '', null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(parsePortraitAge(value), String(value)).toBeNull();
    }
  });

  it('填了才占键：没填的补充信息不许写进记录（旧档案兼容、旧断言不破）', () => {
    expect(toOnboardingPortrait(allYes, true, {})).not.toHaveProperty('gender');
    expect(toOnboardingPortrait(allYes, true)).not.toHaveProperty('age');
    expect(toOnboardingPortrait(allYes, true, { gender: null, age: null })).not.toHaveProperty('gender');
    // 坏值同样不占键（不写假数据）
    expect(toOnboardingPortrait(allYes, true, { gender: 'x' as never, age: 0 })).toEqual(
      toOnboardingPortrait(allYes, true),
    );
    // 年龄越界 ⇒ 只丢年龄，性别照留
    const partial = toOnboardingPortrait(allYes, true, { gender: 'female', age: 999 });
    expect(partial?.gender).toBe('female');
    expect(partial).not.toHaveProperty('age');
  });

  it('填了就进记录，且不影响画像主体（分数/四字码/角色一个字不动）', () => {
    const base = toOnboardingPortrait(allYes, true)!;
    expect(toOnboardingPortrait(allYes, true, { gender: 'male', age: 28 })).toEqual({
      ...base,
      gender: 'male',
      age: 28,
    });
  });

  it('全跳过时仍然没有画像记录 —— 补充信息也救不回一个虚构角色', () => {
    expect(
      toOnboardingPortrait(derivePortrait([null, null, null, null]), true, { gender: 'male', age: 30 }),
    ).toBeNull();
  });

  it('withPortraitDetails 只覆盖不删除：没填的保留原值', () => {
    const stored = toOnboardingPortrait(allYes, true, { gender: 'male', age: 30 })!;
    expect(withPortraitDetails(stored, { gender: 'female' })).toEqual({ ...stored, gender: 'female' });
    expect(withPortraitDetails(stored, { age: 31 })).toEqual({ ...stored, age: 31 });
    // 空补充信息 = 原样返回（编辑模式"没动"时不许把档案里的选择抹掉）
    expect(withPortraitDetails(stored, {})).toEqual(stored);
    expect(withPortraitDetails(stored, { gender: null, age: null })).toEqual(stored);
    expect(withPortraitDetails(stored, { gender: 'x' as never, age: 0 })).toEqual(stored);
    const bare = toOnboardingPortrait(allYes, true)!;
    expect(withPortraitDetails(bare, { gender: 'female', age: 28 })).toEqual({ ...bare, gender: 'female', age: 28 });
  });
});
