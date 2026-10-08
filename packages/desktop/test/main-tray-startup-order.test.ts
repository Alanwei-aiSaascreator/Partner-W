import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 启动顺序的源码契约（与 `analytics-startup-order.test.ts` 同款做法：有些事没有运行时缝，
 * 只能对着源码文本钉）。
 *
 * ⚠️ 这里钉的是**一次真实体检发现**（2026-10-07 区 7 问题 6）：窗口的 `close` 一律被拦下来
 *    改成"隐藏"（托盘形态），而托盘原来是 `bootstrap` **之后**才建的 —— 首跑那 1–20 分钟里
 *    点 X 的后果是：窗口没了、托盘还没有 ⇒ 用户眼里"程序消失了"，只能去任务管理器杀进程。
 *    修法就是**把 `initTray()` 提到开窗之后、拉起运行时之前**：关窗立刻有一个可回来的托盘。
 *
 * ⚠️ 为什么不用运行期测试：这条链要真 Electron + 真托盘，而我们只需要钉住**次序**。
 *    同款先例见 `analytics-startup-order.test.ts`（埋点必须早于开窗那次事故）。
 */
const source = readFileSync(join(__dirname, '../src/main/index.ts'), 'utf8');

describe('主进程启动顺序：托盘必须早于"长准备"', () => {
  it('initTray() 在 createWindow() 之后、本机运行时拉起之前', () => {
    // ⚠️ 匹配**行首缩进不敏感**：这段启动块会被重排/嵌进分支里，钉缩进等于钉排版
    //    （同 `analytics-startup-order.test.ts` 的理由）。
    const windowCall = source.search(/^\s*createWindow\(\);/m);
    const trayCall = source.search(/^\s*initTray\(\);/m);
    const bootstrapCall = source.search(/^\s*const runtimeResult = await runRuntimeBootstrap\(/m);

    expect(windowCall, 'index.ts 里找不到 `createWindow();` 调用').toBeGreaterThan(-1);
    expect(trayCall, 'index.ts 里找不到 `initTray();` 调用').toBeGreaterThan(-1);
    expect(bootstrapCall, 'index.ts 里找不到拉起运行时那一步').toBeGreaterThan(-1);

    expect(windowCall).toBeLessThan(trayCall);
    expect(trayCall, '托盘必须赶在"1–20 分钟的长准备"之前建好：否则首跑关窗 = 窗口没了、托盘也没有').toBeLessThan(
      bootstrapCall,
    );
  });
});
