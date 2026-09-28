/**
 * 元素树 → HTML（供浏览器渲染 + 量框）。
 *
 * 这一层只做一件事：把树摊成 DOM，让**浏览器**去算布局。
 * 我们**不实现任何布局引擎** —— flex、换行、居中、绝对定位全由 Chromium 算，
 * 我们只把算完的矩形记下来（见 `measure.ts`），回头在 pptx 里绝对定位放回去。
 */
import type { SlideChild, SlideNode } from './dsl.js';

/** 画布尺寸（px）。16:9；与 pptx 的换算见 `emit.ts`（÷96 = 英寸）。 */
export const SLIDE_CANVAS = { width: 1280, height: 720 } as const;

/** 这些 CSS 属性的数字**不带单位**（带了反而无效）。 */
const UNITLESS = new Set(['fontWeight', 'lineHeight', 'flex', 'flexGrow', 'flexShrink', 'opacity', 'zIndex', 'order']);

const kebab = (s: string): string => s.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());

/** 样式对象 → CSS 文本。 */
export function styleToCss(raw: Record<string, unknown> | undefined): string {
  const out: string[] = [];
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (v === undefined || v === null) continue;
    // ⚠️ **不要跳过 `display`。** 早期为了"不输出多余的 display"跳过它，
    //    结果把下面给 Box 设的 `display:flex` 一起吞了；而 `flex-direction` / `gap`
    //    在非 flex 容器上**全是死的** —— 实测一整页的三栏（`flexDirection:'row'`）
    //    被竖着排成一列、冲出画布（39 个元素越界）。
    let value: unknown = v;
    if (typeof value === 'number' && !UNITLESS.has(k)) value = `${value}px`;
    out.push(`${kebab(k)}:${String(value)}`);
  }
  return out.join(';');
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 量框时用的标记属性名（`data-sg` / `data-sg-kind`）。 */
export const MARK_ATTR = 'data-sg';
export const MARK_KIND_ATTR = 'data-sg-kind';

export interface RenderedSlide {
  html: string;
  /** 元素总数（含容器）。 */
  count: number;
}

/**
 * 树 → HTML。每个元素带 `data-sg="<序号>"`，量框时按序号回填几何。
 *
 * ⚠️ 序号即**绘制顺序**：pptx 里按同一顺序加图形，z-order 才和浏览器一致。
 *    改成别处排序（比如"先画形状再画文字"）会与浏览器不一致 —— 那正是
 *    「源文件里被卡片盖住的副标题，在浏览器里被盖住、在 pptx 里却浮在上面」这类偏差的来源。
 */
export function renderSlide(root: SlideNode): RenderedSlide {
  let next = 0;

  const render = (node: SlideChild): string => {
    if (node === null || node === undefined) return '';
    if (typeof node === 'string') return escapeHtml(node);
    if (typeof node === 'number') return escapeHtml(String(node));
    if (typeof node === 'boolean') return '';
    if (Array.isArray(node)) return node.map(render).join('');
    if (typeof node !== 'object' || node.kind !== 'element') return '';

    const { tag, props, children } = node;
    const id = next++;
    const style: Record<string, unknown> = { ...((props.style as Record<string, unknown>) ?? {}) };

    // ⭐ `<Slide>` / `<Box>` 在这个 DSL 里**就是 flex 容器**。
    if (tag !== 'Text' && tag !== 'Image') {
      style.display = 'flex';
      // 🔴 2026-09-28 真机：**缺省方向必须是 `column`**，不是 CSS flex 的 `row`。
      //    模型写「标题 → 装饰线 → 副标题」这种最自然的堆叠时**不会写方向**
      //    （没人会想到"容器默认横着排"），于是三件东西被挤成一行、互相压住 ——
      //    一份本来设计得不错的 deck 就毁在这一条上。
      //    ⇒ 对一个**给人排版的 DSL**，容器的默认该跟"文档流"的直觉一致；
      //      要横排的显式写 `flexDirection: 'row'`（技能示例里就是这么写的）。
      if (style.flexDirection === undefined) style.flexDirection = 'column';
    }

    const mark = `${MARK_ATTR}="${id}" ${MARK_KIND_ATTR}="${tag === 'Text' ? 'text' : tag === 'Image' ? 'image' : tag === 'Box' ? 'box' : 'slide'}"`;

    if (tag === 'Image') {
      const src = typeof props.src === 'string' ? props.src : '';
      return `<img ${mark} src="${escapeHtml(src)}" style="${styleToCss(style)}">`;
    }

    const inner = children.map(render).join('');
    return `<div ${mark} style="${styleToCss(style)}">${inner}</div>`;
  };

  return { html: render(root), count: next };
}

/**
 * 包成一份完整、可渲染的 HTML 文档。
 *
 * ⚠️ 两张图当年都加载不上，是因为把这段塞进 `setContent` 之后基准 URL 是 `about:blank`，
 *    相对路径 `assets/…` 解析不了。**调用方必须用一个真 URL 伺服这一页**（见 measure.ts）。
 */
export function slideDocument(html: string): string {
  return `<!doctype html><meta charset="utf-8">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { width:${SLIDE_CANVAS.width}px; height:${SLIDE_CANVAS.height}px; overflow:hidden; }
  body { font-family:"Microsoft YaHei", "PingFang SC", sans-serif; -webkit-font-smoothing:antialiased; }
  img { object-fit: fill; }
</style>
<body>${html}</body>`;
}
