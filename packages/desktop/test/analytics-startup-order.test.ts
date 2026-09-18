import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 启动顺序的源码契约（与 `*-preload-surface.test.ts` 同款做法：有些事没有运行时缝，
 * 只能对着源码文本钉）。
 *
 * ⚠️ 这里钉的是**一次真实事故**（2026-09-18 审阅发现）：`setupAnalytics()` 原本照抄
 * `initUsageReporter()` 的位置，排在 `await bootstrapLocalGatewayRuntime(...)` **之后** ——
 * 而那次运行时就绪等待在首跑要 **37–74 秒**，窗口和登录/激活的 IPC 早就活着了。
 * 用户在这段里登录/激活时，未初始化的 `trackEvent` 是**静默 no-op**（无日志、无重试），
 * 首跑漏斗最关键的 `login_success` / `license_activated` 会被直接丢掉。
 */
const source = readFileSync(join(__dirname, '../src/main/index.ts'), 'utf8');

describe('主进程启动顺序：埋点必须在开窗之前', () => {
  it('setupAnalytics() 的调用出现在 createWindow() 之前', () => {
    const analyticsCall = source.indexOf('\n    setupAnalytics();');
    const windowCall = source.indexOf('\n    createWindow();');

    expect(analyticsCall, 'index.ts 里找不到 `setupAnalytics();` 调用').toBeGreaterThan(-1);
    expect(windowCall, 'index.ts 里找不到 `createWindow();` 调用').toBeGreaterThan(-1);
    expect(analyticsCall).toBeLessThan(windowCall);
  });
});
