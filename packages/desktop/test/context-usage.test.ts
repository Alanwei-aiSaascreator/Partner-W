import { describe, expect, it } from 'vitest';
import {
  contextUsagePercent,
  DEFAULT_CONTEXT_WINDOW,
  resolveContextWindow,
} from '../src/renderer/lib/context-usage.js';

/**
 * 顶栏「上下文占用 %」（2026-10-17 用户："上下文500%是啥意思"）。
 *
 * 现场 bug：分母写死 200,000，而当前模型的真实窗口更大 ⇒ 100 万 token 显示成 500%。
 * 判据：分母取模型目录的 `contextWindow`（缺失/非法才回落 200k），显示夹在 0–100。
 */
describe('resolveContextWindow', () => {
  it('目录声明了正数窗口 ⇒ 用它', () => {
    expect(resolveContextWindow({ contextWindow: 1_000_000 })).toBe(1_000_000);
  });

  it('缺目录 / 缺字段 / 非法值 ⇒ 回落默认 200k（不拿 0 去除）', () => {
    expect(resolveContextWindow(undefined)).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(resolveContextWindow({})).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(resolveContextWindow({ contextWindow: 0 })).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(resolveContextWindow({ contextWindow: -5 })).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(resolveContextWindow({ contextWindow: Number.NaN })).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(resolveContextWindow({ contextWindow: '1000000' })).toBe(DEFAULT_CONTEXT_WINDOW);
  });
});

describe('contextUsagePercent', () => {
  it('没有读数的会话 ⇒ null（不显示 0%）', () => {
    expect(contextUsagePercent(null, 200_000)).toBeNull();
    expect(contextUsagePercent(undefined, 200_000)).toBeNull();
    expect(contextUsagePercent(0, 200_000)).toBeNull();
  });

  it('正常换算', () => {
    expect(contextUsagePercent(50_000, 200_000)).toBe(25);
    expect(contextUsagePercent(1_000_000, 1_000_000)).toBe(100);
  });

  it('⭐ 100 万 token × 200k 分母不再显示 500%（夹到 100）', () => {
    expect(contextUsagePercent(1_000_000, 200_000)).toBe(100);
  });

  it('负数 / NaN / 坏窗口 ⇒ null 或安全值，不产生怪数字', () => {
    expect(contextUsagePercent(-1, 200_000)).toBeNull();
    expect(contextUsagePercent(Number.NaN, 200_000)).toBeNull();
    expect(contextUsagePercent(10_000, 0)).toBe(5);
  });
});
