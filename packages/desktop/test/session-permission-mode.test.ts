import { describe, expect, it } from 'vitest';
import { findPermissionMode, isFullAccessMode } from '../src/renderer/lib/session-permission-mode';

/**
 * 徽章读的是**网关回来的真值**，不是本地开关的猜测。
 *
 * ⚠️ 运行时其实有**四**个模式（`read-only` / `guarded` / `workspace` / `full`），
 *    其中只有 `full` 才解除工作区限制（`workspaceOnly = policy.mode !== 'full'`）。
 *    所以"不是 guarded 就是全权"这种写法是错的 —— 有测试按名钉住 `workspace` 不算全权。
 */
describe('isFullAccessMode', () => {
  it("只有 'full' 算全权", () => {
    expect(isFullAccessMode('full')).toBe(true);
  });

  it.each([['read-only'], ['guarded'], ['workspace']])("'%s' 不算全权", (mode) => {
    expect(isFullAccessMode(mode)).toBe(false);
  });

  it('没有模式 / 脏值 ⇒ 不算全权（fail-closed）', () => {
    expect(isFullAccessMode(null)).toBe(false);
    expect(isFullAccessMode(undefined)).toBe(false);
    expect(isFullAccessMode('')).toBe(false);
    expect(isFullAccessMode('FULL')).toBe(false);
    expect(isFullAccessMode(1)).toBe(false);
    expect(isFullAccessMode({})).toBe(false);
  });
});

describe('findPermissionMode', () => {
  const rows = [
    { key: 'agent:main:a', permissionMode: 'full' },
    { key: 'agent:main:b', permissionMode: 'guarded' },
    { key: 'agent:main:c' },
  ];

  it('从数组里按会话键取回模式', () => {
    expect(findPermissionMode(rows, 'agent:main:a')).toBe('full');
    expect(findPermissionMode(rows, 'agent:main:b')).toBe('guarded');
  });

  it('行里没有这个字段 ⇒ null（不是空串、不是 undefined）', () => {
    expect(findPermissionMode(rows, 'agent:main:c')).toBeNull();
  });

  it('找不到这个会话 ⇒ null', () => {
    expect(findPermissionMode(rows, 'agent:main:zzz')).toBeNull();
  });

  it('接 {sessions:[…]} 形状（网关两种包法都出现过）', () => {
    expect(findPermissionMode({ sessions: rows }, 'agent:main:a')).toBe('full');
  });

  it('会话键为空/缺失 ⇒ null，且不抛', () => {
    expect(findPermissionMode(rows, null)).toBeNull();
    expect(findPermissionMode(rows, undefined)).toBeNull();
    expect(findPermissionMode(rows, '')).toBeNull();
  });

  it('读不到列表（null / 非数组 / 脏值）⇒ null，且不抛', () => {
    expect(findPermissionMode(null, 'agent:main:a')).toBeNull();
    expect(findPermissionMode(undefined, 'agent:main:a')).toBeNull();
    expect(findPermissionMode('nonsense', 'agent:main:a')).toBeNull();
    expect(findPermissionMode({ sessions: 'nonsense' }, 'agent:main:a')).toBeNull();
    expect(findPermissionMode([null, 1, 'x'], 'agent:main:a')).toBeNull();
  });

  it('非字符串的模式值原样不当真（返回 null）', () => {
    expect(findPermissionMode([{ key: 'k', permissionMode: 42 }], 'k')).toBeNull();
    expect(findPermissionMode([{ key: 'k', permissionMode: {} }], 'k')).toBeNull();
  });
});
