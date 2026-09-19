import { describe, expect, it } from 'vitest';
import { IDENTITY_DEFAULT_TAGS, IDENTITY_PERSONA_TAGS, nextTagSelection } from '../src/renderer/lib/identity-persona';

/**
 * 「换一个标签」的轮换规则（2026-09-19）。
 *
 * 刻意**不做随机**：随机不可测，用户连点两次还会看到不稳定的结果。
 * 这里钉住的就是"确定性"本身 —— 同一个输入永远同一个输出，且整体沿环挪一格。
 */
describe('nextTagSelection', () => {
  it('空选 ⇒ 回到默认那四个（"换"之前得先有个起点）', () => {
    expect(nextTagSelection([])).toEqual(IDENTITY_DEFAULT_TAGS);
  });

  it('⭐ 整体沿环挪一格，**选中个数不变**', () => {
    expect(nextTagSelection(IDENTITY_DEFAULT_TAGS)).toEqual(['efficiency', 'logical', 'reporting', 'timeManagement']);
  });

  it('绕到环尾会回到开头（不是截断、也不是越界）', () => {
    // 以 'timeManagement'（环上最后一个）打头 ⇒ 下一个是 'goalOriented'
    expect(nextTagSelection(['timeManagement', 'goalOriented'])).toEqual(['goalOriented', 'efficiency']);
  });

  it('全选也照轮（集合不变，但结果仍由同一个纯函数算出）', () => {
    const all = [...IDENTITY_PERSONA_TAGS];
    expect(new Set(nextTagSelection(all))).toEqual(new Set(all));
  });

  it('确定性：同样的输入连算两次结果一样', () => {
    const once = nextTagSelection(IDENTITY_DEFAULT_TAGS);
    expect(nextTagSelection(IDENTITY_DEFAULT_TAGS)).toEqual(once);
  });

  it('不改动传进来的数组（纯函数）', () => {
    const input = ['goalOriented', 'efficiency'] as const;
    const snapshot = [...input];
    nextTagSelection(input);
    expect([...input]).toEqual(snapshot);
  });
});
