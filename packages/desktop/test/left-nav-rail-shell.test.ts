import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LEFT_NAV_RAIL_WIDTH } from '../src/renderer/styles/design-tokens';

/**
 * 外壳层的源码契约：**收起 = 图标条，不是归零**（2026-09-29，体验稿 `侧栏收纳-方案.html`）。
 *
 * ## 为什么用"读源码"这种形式
 *
 * 本仓已有先例（`gateway-disappearance.test.tsx`、`module-open-tracking.test.tsx`
 * 都把 `App.tsx` 当文本读）。`App.tsx` 依赖网关/激活/引导一堆状态，**没有测试渲染它**，
 * 而这一刀改的恰恰是它那两行——不钉住的话，谁把宽度改回 `0` 都不会有人发现，
 * 而"收起之后整列消失"正是用户今天抱怨的那个形态。
 *
 * ⚠️ 这份测试**只钉"形状"**，不证明"看起来对"。视觉要靠真机/`pnpm dev` 看。
 */
const APP = readFileSync(join(__dirname, '..', 'src', 'renderer', 'App.tsx'), 'utf8');

describe('应用外壳 —— 左列的收纳态', () => {
  it('收纳宽度是一个具名常量，不是散落的字面量', () => {
    expect(LEFT_NAV_RAIL_WIDTH).toBeGreaterThanOrEqual(48);
    expect(LEFT_NAV_RAIL_WIDTH).toBeLessThan(200); // 必须明显窄于展开态的下限
  });

  it('⭐ 收起时动画到的是图标条宽度，**不是 0**', () => {
    expect(APP, '收起不许再归零').not.toContain('leftNavCollapsed ? 0 : leftNavWidth');
    expect(APP).toContain('leftNavCollapsed ? LEFT_NAV_RAIL_WIDTH : leftNavWidth');
  });

  it('⭐ 最小宽度也跟着走（否则 flex 会把它压回 0）', () => {
    expect(APP).toContain('minWidth: leftNavCollapsed ? LEFT_NAV_RAIL_WIDTH : 200');
  });

  it('那条 28px 展开窄条已经删掉（图标条自己就是展开入口）', () => {
    expect(APP, '展开图标应该搬到 LeftNav 的图标条里，不在外壳上').not.toContain('PanelLeftOpen');
    // 旧的窄条是外壳里唯一一处 `w-7`（`w-72` 之类会连坐，所以先确认它不存在）
    expect(APP).not.toContain('w-72');
    expect(APP, '旧的窄条还在：两条窄栏并排会让用户以为是两个东西').not.toContain('w-7');
  });

  it('拖宽手柄只在展开态出现（图标条不需要可拖）', () => {
    expect(APP).toContain('{!leftNavCollapsed && (');
  });
});
