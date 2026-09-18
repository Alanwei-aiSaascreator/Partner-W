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
    // ⚠️ 匹配**行首缩进不敏感**：这段启动块会被重排/嵌进分支里（T-U1 就把工作区准备
    //    提到了最前，整块缩进从 4 空格变 6 空格）。钉缩进等于钉排版 —— 一旦重排，
    //    测试会因为"找不到调用"而红，而它想守的次序其实没变（这种假红浪费过一次排查）。
    const analyticsCall = source.search(/^\s*setupAnalytics\(\);/m);
    const windowCall = source.search(/^\s*createWindow\(\);/m);

    expect(analyticsCall, 'index.ts 里找不到 `setupAnalytics();` 调用').toBeGreaterThan(-1);
    expect(windowCall, 'index.ts 里找不到 `createWindow();` 调用').toBeGreaterThan(-1);
    // 注意：`createWindow` 还有第二处调用（`app.on('activate')` 里重建窗口），
    // `search` 取的是**首次**出现，也就是启动块那处，正是要比较的那个。
    expect(analyticsCall).toBeLessThan(windowCall);
  });
});
