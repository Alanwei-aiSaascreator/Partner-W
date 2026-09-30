/**
 * 版式校验 —— 产文件**之前/之后**该说的话。
 *
 * ## 一条贯穿全案的原则：**宁可出文件**
 *
 * 对标产品那份 deck 里，第 2 页其实**有一个重叠**（页头块压着卡片列，卡片又把副标题盖住）。
 * 它照样出了成品 —— 因为"版式有点毛病"和"什么都没生成"是两种完全不同的坏。
 * 用户要的是能改的文件，不是一句"你的内容有问题"。
 *
 * ⇒ 所以这里把结论分成两档，**判据是"这个文件还看不看得懂"**：
 *
 * | 档 | 含义 | 处置 |
 * | --- | --- | --- |
 * | **致命** | 求值/渲染/写出**没成功** ⇒ 不可能有文件 | 拒绝，报码 |
 * | **警告** | 文件出来了，但**某几处版式不对** | **照常交付**，把话说清楚 |
 *
 * ⚠️ 越界和遮挡**都不致命**。把它们做成致命会让"内容多一点"直接变成"零输出" ——
 *    那正是本项目已经踩过、并明令不要再踩的那个坑（见 `document-deck` 技能里
 *    「长了会被拒」那段历史）。
 */

import type { MeasuredElement } from './measure.js';
import { SLIDE_CANVAS } from './layout.js';

/** 一页跑完之后，值得回头告诉助手/用户的版式问题。 */
export interface LayoutWarning {
  code: 'layout-out-of-bounds' | 'layout-text-occluded';
  /** 元素在页面里的绘制序号（= `data-sg`）。 */
  element: number;
  /** 人能读懂的一句话。**要能直接照着改**，所以带元素类型与文字片段。 */
  detail: string;
}

/** 越界容差（px）：四舍五入与亚像素会让贴边的元素差个零点几。 */
const BOUNDS_TOLERANCE = 1.5;

function describe(e: MeasuredElement): string {
  const label = e.kind === 'text' ? `文字「${e.text.slice(0, 18)}」` : e.kind === 'image' ? '图片' : '色块';
  return `${label}（#${e.id}）`;
}

/**
 * 找出**冲出画布**的元素。
 *
 * 为什么会冲出去：内容比版式装得下的多。典型是列表项写太长、卡片高度不够。
 * 后果是导出后那一块**在幻灯片外面**，放映时看不见 —— 用户会以为内容丢了。
 */
export function findOutOfBounds(elements: readonly MeasuredElement[]): LayoutWarning[] {
  const out: LayoutWarning[] = [];
  for (const e of elements) {
    if (e.kind === 'slide') continue;
    const overRight = e.x + e.w - SLIDE_CANVAS.width;
    const overBottom = e.y + e.h - SLIDE_CANVAS.height;
    if (
      e.x < -BOUNDS_TOLERANCE ||
      e.y < -BOUNDS_TOLERANCE ||
      overRight > BOUNDS_TOLERANCE ||
      overBottom > BOUNDS_TOLERANCE
    ) {
      const parts: string[] = [];
      if (e.x < -BOUNDS_TOLERANCE) parts.push(`左边超出 ${Math.round(-e.x)}px`);
      if (e.y < -BOUNDS_TOLERANCE) parts.push(`上边超出 ${Math.round(-e.y)}px`);
      if (overRight > BOUNDS_TOLERANCE) parts.push(`右边超出 ${Math.round(overRight)}px`);
      if (overBottom > BOUNDS_TOLERANCE) parts.push(`下边超出 ${Math.round(overBottom)}px`);
      out.push({
        code: 'layout-out-of-bounds',
        element: e.id,
        detail: `${describe(e)} 冲出画布：${parts.join('、')}。这一块导出后在幻灯片外面，放映时看不到。`,
      });
    }
  }
  return out;
}

/**
 * 找出**被盖住的文字**。
 *
 * 为什么专挑文字：色块被盖住通常是有意的（层叠装饰），而**文字被盖住一定是事故** ——
 * 用户看不到那句话，却完全不知道它存在。
 *
 * 判据由**浏览器**给（`elementFromPoint`，见 `measure.ts`）：它的答案就是"谁在最上面"。
 * 导出按 Chromium paint order。文字行内采样能发现部分遮挡，但并非完整可见性证明。
 */
export function findOccludedText(elements: readonly MeasuredElement[]): LayoutWarning[] {
  const out: LayoutWarning[] = [];
  for (const e of elements) {
    if (e.kind !== 'text' || !e.occludedBy) continue;
    if (!e.text.trim()) continue; // 空文字被盖住无所谓
    out.push({
      code: 'layout-text-occluded',
      element: e.id,
      detail: `${describe(e)} 有部分被 ${e.occludedBy} 盖住了。把它的位置或盖住它的那块挪开。`,
    });
  }
  return out;
}

/** 全部版式检查。 */
export function validateLayout(elements: readonly MeasuredElement[]): LayoutWarning[] {
  return [...findOutOfBounds(elements), ...findOccludedText(elements)];
}
