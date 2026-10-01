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
  code: 'layout-out-of-bounds' | 'layout-text-occluded' | 'layout-footer-overlap' | 'layout-text-low-contrast';
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
  return [
    ...findOutOfBounds(elements),
    ...findOccludedText(elements),
    ...findFooterOverlap(elements),
    ...findLowContrast(elements),
  ];
}

type Bounds = Pick<MeasuredElement, 'x' | 'y' | 'w' | 'h'>;

function overlaps(a: Bounds, b: Bounds): boolean {
  return (
    Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > BOUNDS_TOLERANCE &&
    Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > BOUNDS_TOLERANCE
  );
}

function contains(a: Bounds, b: Bounds): boolean {
  return (
    a.x <= b.x + BOUNDS_TOLERANCE &&
    a.y <= b.y + BOUNDS_TOLERANCE &&
    a.x + a.w >= b.x + b.w - BOUNDS_TOLERANCE &&
    a.y + a.h >= b.y + b.h - BOUNDS_TOLERANCE
  );
}

function findFooterOverlap(elements: readonly MeasuredElement[]): LayoutWarning[] {
  const roots = new Set(elements.filter((e) => e.kind === 'slide').map((e) => e.id));
  const out: LayoutWarning[] = [];
  for (const footer of elements) {
    if (
      footer.kind !== 'text' ||
      !footer.text.trim() ||
      footer.position !== 'absolute' ||
      footer.parentId === undefined ||
      !roots.has(footer.parentId) ||
      footer.y < SLIDE_CANVAS.height - 80 ||
      footer.fontSize > 18 ||
      footer.w < SLIDE_CANVAS.width / 2
    )
      continue;
    const card = elements.find(
      (e) =>
        e.kind === 'box' &&
        !(e.y <= 0 && e.h >= SLIDE_CANVAS.height) &&
        e.y < SLIDE_CANVAS.height - 80 &&
        e.h > 80 &&
        overlaps(e, footer) &&
        (e.borderWidth > 0 || (rgba(e.background)?.[3] ?? 0) > 0),
    );
    if (card)
      out.push({
        code: 'layout-footer-overlap',
        element: footer.id,
        detail: `Footer #${footer.id} enters body region #${card.id}. Reserve space above the footer or move the body region; keep all text.`,
      });
  }
  return out;
}

type Rgba = [number, number, number, number];
function rgba(value: string): Rgba | null {
  const match = /^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/.exec(value.trim());
  if (!match) return null;
  const color: Rgba = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4] ?? 1)];
  return color.every(Number.isFinite) &&
    color.slice(0, 3).every((n) => n >= 0 && n <= 255) &&
    color[3] >= 0 &&
    color[3] <= 1
    ? color
    : null;
}

function blend(front: Rgba, back: Rgba): Rgba {
  return [
    front[0] * front[3] + back[0] * (1 - front[3]),
    front[1] * front[3] + back[1] * (1 - front[3]),
    front[2] * front[3] + back[2] * (1 - front[3]),
    1,
  ];
}

function luminance(color: Rgba): number {
  const channels = color
    .slice(0, 3)
    .map((n) => n / 255)
    .map((n) => (n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4));
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function containsPaint(layer: MeasuredElement, region: Bounds): boolean {
  if (!contains(layer, region)) return false;
  const radius = Math.min(layer.borderRadius, layer.w / 2, layer.h / 2);
  if (radius <= 0) return true;
  return [region.x, region.x + region.w].every((x) =>
    [region.y, region.y + region.h].every((y) => {
      const nearestX = Math.max(layer.x + radius, Math.min(x, layer.x + layer.w - radius));
      const nearestY = Math.max(layer.y + radius, Math.min(y, layer.y + layer.h - radius));
      return Math.hypot(x - nearestX, y - nearestY) <= radius;
    }),
  );
}

function findLowContrast(elements: readonly MeasuredElement[]): LayoutWarning[] {
  const out: LayoutWarning[] = [];
  for (const [index, text] of elements.entries()) {
    if (
      text.kind !== 'text' ||
      !text.text.trim() ||
      text.w <= 0 ||
      text.h <= 0 ||
      (text.opacity !== undefined && text.opacity !== 1)
    )
      continue;
    const ink = rgba(text.color);
    const textFill = rgba(text.background);
    if (!ink || !textFill || textFill[3] > 0) continue;
    for (const region of text.textBounds?.length ? text.textBounds : [text]) {
      let back: Rgba | null = null;
      let unknown = false;
      for (const layer of elements.slice(0, index + 1)) {
        if (layer.kind === 'text' && layer.id !== text.id) continue;
        if (!overlaps(layer, region)) continue;
        const fill = rgba(layer.background);
        if (
          layer.kind === 'image' ||
          (layer.backgroundImage && layer.backgroundImage !== 'none') ||
          (layer.opacity !== undefined && layer.opacity !== 1)
        ) {
          unknown = true;
          continue;
        }
        if (!fill) {
          unknown = true;
          continue;
        }
        if (fill[3] === 0) continue;
        if (!containsPaint(layer, region)) {
          unknown = true;
          continue;
        }
        if (fill[3] === 1) {
          back = fill;
          unknown = false;
        } else if (back && !unknown) back = blend(fill, back);
      }
      if (!back || unknown) continue;
      const light = luminance(blend(ink, back)),
        dark = luminance(back);
      const ratio = (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05);
      const minimum = text.fontSize >= 24 || (text.fontSize >= 18.67 && Number(text.fontWeight) >= 700) ? 3 : 4.5;
      if (ratio + 0.01 < minimum) {
        out.push({
          code: 'layout-text-low-contrast',
          element: text.id,
          detail: `Text #${text.id} has ${ratio.toFixed(2)}:1 contrast on the measured solid background (target ${minimum}:1). Change text or background color.`,
        });
        break;
      }
    }
  }
  return out;
}
