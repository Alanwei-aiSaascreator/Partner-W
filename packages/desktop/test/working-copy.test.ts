import { describe, expect, it } from 'vitest';
import { workingCopyKey } from '../src/renderer/components/TurnActivityRow.js';

/**
 * 干活中的趣味进度语（2026-10-17 用户要求）。
 *
 * 判据：
 *  ① 8 秒换一句（按已等待时长轮换，不是随机数 —— 重渲染不该改文案）；
 *  ② 同一会话同一时刻永远是同一句（确定性）；
 *  ③ 不同会话开场不同（哈希偏移），避免所有窗口同一句话。
 */
describe('workingCopyKey', () => {
  it('每隔 8 秒轮换一句，且只落在这六个键里', () => {
    const first = workingCopyKey('s1', 0);
    expect(first).toMatch(/^chatInput\.workingLines\.[0-5]$/);
    expect(workingCopyKey('s1', 7999)).toBe(first);
    expect(workingCopyKey('s1', 8000)).not.toBe(first);
  });

  it('确定性：同样输入永远同样输出', () => {
    expect(workingCopyKey('session-a', 16000)).toBe(workingCopyKey('session-a', 16000));
  });

  it('不同会话的起始句可以不同（哈希偏移）', () => {
    const keys = new Set(['a', 'b', 'c', 'd', 'e', 'f'].map((id) => workingCopyKey(id, 0)));
    expect(keys.size).toBeGreaterThan(1);
  });
});
