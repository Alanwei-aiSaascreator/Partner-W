/**
 * 一页的完整流水线：**树 → HTML → 浏览器量框 → 校验 → 形状**。
 *
 * 这条链就是整个方案的全部秘密，四步各自单一职责：
 *
 * 1. `renderSlide` —— 树摊成 DOM（**不做布局**）
 * 2. `measureSlide` —— Chromium 排版，量出每个元素的最终矩形（**布局在这一步被解决**）
 * 3. `validateLayout` —— 越界 / 遮挡 ⇒ **警告**（不挡交付）
 * 4. `toShapes` —— 矩形 + 计算样式 ⇒ pptx 形状（**纯函数**）
 *
 * 判据是"我们从不自己算坐标"：坐标全部来自浏览器。
 * 一旦有人在这里加了"估算文字宽度"之类的逻辑，就回到了 `docgen` 那条老路
 * （估算模型 → 装不下就拒 → 用户拿到零），那是本项目已经付过代价的弯路。
 */
import type { SlideNode } from './dsl.js';
import { renderSlide } from './layout.js';
import { measureSlide, type MeasuredElement } from './measure.js';
import { toShapes, type Shape } from './emit.js';
import { validateLayout, type LayoutWarning } from './validate.js';
import { hexOf } from './emit.js';

export interface EmittedPage {
  page: { shapes: Shape[]; background: string };
  /**
   * 版式警告。**这里不带页码** —— 页码是"第几页"这个循环变量的属性，
   * 由调用方（`generate.ts`）补。让这一层去猜页码只会把循环知识漏进来。
   */
  warnings: LayoutWarning[];
}

/**
 * 一页：树 ⇒ 形状 + 警告。
 *
 * ⚠️ **警告不抛**。版式有毛病时文件照样要出来 —— 见 `validate.ts` 顶部那段。
 *    只有"渲染/量框本身没成功"才抛（那是另一档：不可能有文件）。
 */
export async function emitPageShapes(page: SlideNode, assetsRoot: string | null): Promise<EmittedPage> {
  const { html } = renderSlide(page);
  const measured: MeasuredElement[] = await measureSlide(html, assetsRoot);

  const root = measured.find((e) => e.kind === 'slide');
  // 底色必须从量测里取。写死成封面那页的深色 ⇒ 浅色内容页变成「黑底 + 深色字」，
  // 整页标题看不见（实测踩过）。
  const background = hexOf(root?.background) ?? 'FFFFFF';

  return {
    page: { shapes: toShapes(measured), background },
    warnings: validateLayout(measured),
  };
}
