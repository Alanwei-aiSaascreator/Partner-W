/**
 * 量好的几何 → `.pptx`。
 *
 * ## 比例尺（不是猜的，是拿参考 pptx 反推出来的）
 *
 * 对标那份 deck 的 `.slide` 写着 `fontSize: 66`，产出的 pptx 里是 `sz="4950"`：
 *
 * ```
 * 1280px 画布 ÷ 96 = 13.333 英寸   ← PPT 16:9 标准版面
 * 66px × 0.75 = 49.5pt = sz "4950"
 * ```
 *
 * ⇒ **位置 / 尺寸：`px / 96` 英寸；字号：`px × 0.75` 磅。**
 * 按这个换算复现出来的字号与那份参考**逐条相同**（1200/1425/1500/3900/4950）。
 *
 * ## 为什么文字是"绝对定位的文本框"而不是截图
 *
 * 每个 `<Text>` 变成一个**真的文本框**，字号/颜色/加粗都是真的 ⇒ 用户在 PowerPoint 里
 * 可以直接改字。截图也能"看起来一样"，但那样交付的是图片，不是文档。
 */
import PptxGenJS from 'pptxgenjs';
import JSZip from 'jszip';
import fs from 'node:fs';
import path from 'node:path';
import type { MeasuredElement } from './measure.js';
import { SLIDE_CANVAS } from './layout.js';

export const PX_PER_INCH = 96;
export const PT_PER_PX = 0.75;
const inOf = (px: number): number => px / PX_PER_INCH;

/** 渐变定义（从计算样式里解出来的）。 */
export interface GradientSpec {
  stops: readonly { pos: number; color: string }[];
  angleDeg: number;
}

interface GradientTarget {
  gradient: GradientSpec;
  objectName: string;
}

export type Shape =
  | {
      kind: 'rect';
      id: number;
      x: number;
      y: number;
      w: number;
      h: number;
      fill: string;
      fillTransparency?: number;
      radius: number;
      borderWidth: number;
      borderColor: string | null;
      borderTransparency?: number;
      gradient: GradientSpec | null;
    }
  | { kind: 'image'; id: number; x: number; y: number; w: number; h: number; src: string }
  | {
      kind: 'text';
      id: number;
      x: number;
      y: number;
      w: number;
      h: number;
      text: string;
      fontSize: number;
      fontFace?: string;
      lineSpacing?: number;
      italic?: boolean;
      bold: boolean;
      color: string;
      transparency?: number;
      align: 'left' | 'center' | 'right';
      letterSpacing: number;
      wrap: boolean;
      gradient: GradientSpec | null;
    };

/** `rgb(16, 13, 19)` / `rgba(0,0,0,0)` → `100D13` / null（透明）。 */
export function hexOf(color: string | undefined): string | null {
  const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(color ?? '');
  if (!m) return null;
  if (m[4] !== undefined && Number(m[4]) === 0) return null;
  return [m[1], m[2], m[3]]
    .map((n) => Math.round(Number(n)).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

/** Computed CSS alpha must survive conversion to native DrawingML transparency. */
function transparencyOf(color: string): number | undefined {
  const alpha = /^rgba\([\d.]+,\s*[\d.]+,\s*[\d.]+,\s*([\d.]+)\)$/.exec(color.trim())?.[1];
  if (alpha === undefined) return undefined;
  const transparency = Math.round((1 - Math.max(0, Math.min(1, Number(alpha)))) * 100000) / 1000;
  return transparency > 0 ? transparency : undefined;
}

/**
 * 解析 `linear-gradient(90deg, #A 0%, #B 50%, #C 100%)`。
 *
 * ⚠️ **计算样式给的色标是 `rgb(...)`，不是 `#RRGGBB`。** 只认十六进制的话会一路
 *    掉到兜底色 —— 实测渐变副标题变成纯白、顶栏变成纯粉。
 */
export function parseGradient(css: string | undefined): GradientSpec | null {
  if (!css || !css.includes('gradient')) return null;
  const stops: { pos: number; color: string }[] = [];
  for (const m of css.matchAll(/(#[0-9A-Fa-f]{6}|rgba?\([^)]*\))\s+([\d.]+)%/g)) {
    const color = m[1].startsWith('#') ? m[1].slice(1).toUpperCase() : hexOf(m[1]);
    if (color) stops.push({ pos: Number(m[2]) / 100, color });
  }
  if (stops.length < 2) return null;
  const angle = /linear-gradient\(\s*([\d.]+)deg/.exec(css)?.[1];
  return { stops, angleDeg: angle === undefined ? 90 : Number(angle) };
}

/** 在渐变的 `t`（0..1）处取色。 */
export function sampleGradient(g: GradientSpec, t: number): string {
  const st = g.stops;
  const first = st[0];
  const last = st[st.length - 1];
  if (!first || !last) return 'FFFFFF';
  if (t <= first.pos) return first.color;
  if (t >= last.pos) return last.color;
  for (let i = 1; i < st.length; i += 1) {
    const a = st[i - 1];
    const b = st[i];
    if (!a || !b) break;
    if (t <= b.pos) {
      const span = b.pos - a.pos || 1;
      const k = (t - a.pos) / span;
      const pa = [0, 2, 4].map((o) => parseInt(a.color.slice(o, o + 2), 16));
      const pb = [0, 2, 4].map((o) => parseInt(b.color.slice(o, o + 2), 16));
      return pa
        .map((v, idx) =>
          Math.round(v + ((pb[idx] ?? v) - v) * k)
            .toString(16)
            .padStart(2, '0'),
        )
        .join('')
        .toUpperCase();
    }
  }
  return last.color;
}

/** 渐变里"中间那个色标" —— pptxgenjs 不支持渐变，先用它当单色近似，稍后由 `applyGradients` 补真渐变。 */
function midColor(g: GradientSpec): string {
  return g.stops[Math.floor(g.stops.length / 2)]?.color ?? g.stops[0]?.color ?? 'FFFFFF';
}

/**
 * 量测结果 → 形状列表（**纯函数**，可单测）。
 *
 * 顺序 = 绘制顺序（即 z-order），与浏览器一致。
 * 纯布局容器（没有背景的 `Box`）不产生形状 —— 它们的价值已经在子元素的坐标里了。
 */
export function toShapes(elements: readonly MeasuredElement[]): Shape[] {
  const shapes: Shape[] = [];
  for (const e of elements) {
    // 多行文本给 3% 宽度余量：折行位置由 PowerPoint 的字宽决定，卡得太死会多折一行。
    const slack = e.kind === 'text' && e.lines > 1 ? 1.03 : 1;
    const geo = { x: e.x, y: e.y, w: e.w * slack, h: e.h };

    if (e.kind === 'image') {
      shapes.push({ kind: 'image', id: e.id, ...geo, src: e.src ?? '' });
      continue;
    }

    if (e.kind === 'box' || e.kind === 'slide') {
      const solid = hexOf(e.background);
      const gradient = parseGradient(e.backgroundImage);
      if (e.kind === 'slide' && !gradient) continue;
      const fill = gradient ? midColor(gradient) : solid;
      if (!fill) continue; // 纯布局容器
      shapes.push({
        kind: 'rect',
        id: e.id,
        ...geo,
        fill,
        ...(!gradient && solid && transparencyOf(e.background) !== undefined
          ? { fillTransparency: transparencyOf(e.background) }
          : {}),
        gradient,
        radius: Math.min(e.borderRadius, Math.min(e.w, e.h) / 2),
        borderWidth: e.borderWidth,
        borderColor: e.borderWidth > 0 ? hexOf(e.borderColor) : null,
        ...(e.borderWidth > 0 && transparencyOf(e.borderColor) !== undefined
          ? { borderTransparency: transparencyOf(e.borderColor) }
          : {}),
      });
      continue;
    }

    // text
    const solid = hexOf(e.color);
    const gradient = solid ? null : parseGradient(e.backgroundImage);
    shapes.push({
      kind: 'text',
      id: e.id,
      ...geo,
      text: e.textLines?.join('\n') ?? e.text,
      fontSize: e.fontSize * PT_PER_PX,
      fontFace:
        e.fontFamily
          ?.split(',')[0]
          ?.trim()
          .replace(/^["']|["']$/g, '') || 'Microsoft YaHei',
      lineSpacing: e.lineHeight && Number.isFinite(e.lineHeight) ? e.lineHeight * PT_PER_PX : undefined,
      italic: e.fontStyle === 'italic' || e.fontStyle === 'oblique',
      bold: e.fontWeight === 'bold' || Number(e.fontWeight) >= 600,
      color: solid ?? (gradient ? midColor(gradient) : 'FFFFFF'),
      ...(!gradient && transparencyOf(e.color) !== undefined ? { transparency: transparencyOf(e.color) } : {}),
      align: e.textAlign === 'center' ? 'center' : e.textAlign === 'right' ? 'right' : 'left',
      letterSpacing: e.letterSpacing * PT_PER_PX,
      // ⭐ 单行 ⇒ 关掉折行。框宽是**量出来的紧贴宽度**，PowerPoint 的字宽差一点点就会折
      //    （实测：「战略落地」被折成「战略落」+「地」）。
      wrap: e.textLines ? false : e.lines > 1,
      gradient,
    });
  }
  return shapes;
}

/**
 * 把 pptxgenjs 写出来的**单色近似**换成原生 `<a:gradFill>`。
 *
 * pptxgenjs 4.0.1 **不支持渐变填充**（类型里只有 solid），所以走 XML 手术。
 * 参考那份 deck 用的也是原生 `gradFill` + `<a:lin ang="0" scaled="1"/>` ——
 * 这样在 PowerPoint 里是**可编辑的真渐变**，不是贴一张图。
 */
export async function applyGradients(pptxPath: string, gradients: readonly GradientTarget[]): Promise<number> {
  if (gradients.length === 0) return 0;
  const zip = await JSZip.loadAsync(fs.readFileSync(pptxPath));
  let patched = 0;

  for (const name of Object.keys(zip.files)) {
    if (!/^ppt\/slides\/slide\d+\.xml$/.test(name)) continue;
    let xml = await zip.file(name)!.async('string');

    for (const { gradient: g, objectName } of gradients) {
      const solid = `<a:solidFill><a:srgbClr val="${midColor(g)}"/></a:solidFill>`;
      if (!xml.includes(solid)) continue;
      const stops = g.stops
        .map((s) => `<a:gs pos="${Math.round(s.pos * 100000)}"><a:srgbClr val="${s.color}"/></a:gs>`)
        .join('');
      // CSS 90deg（向右）↔ OOXML ang=0；CSS 180deg（向下）↔ ang=5400000（60000/度）。
      const ang = Math.round(((((g.angleDeg - 90) % 360) + 360) % 360) * 60000);
      xml = xml.replace(/<p:sp>[\s\S]*?<\/p:sp>/g, (shape) => {
        if (!shape.includes(`name="${objectName}"`) || !shape.includes(solid)) return shape;
        patched += 1;
        return shape.replace(
          solid,
          `<a:gradFill><a:gsLst>${stops}</a:gsLst><a:lin ang="${ang}" scaled="1"/></a:gradFill>`,
        );
      });
    }
    zip.file(name, xml);
  }
  if (patched > 0) fs.writeFileSync(pptxPath, await zip.generateAsync({ type: 'nodebuffer' }));
  return patched;
}

/**
 * 写出 `.pptx`。
 *
 * ⚠️ 底色**必须从量测里取**（`<Slide>` 的 background），不能写死成封面那页的深色 ——
 *    写死之后浅色内容页会变成「黑底 + 深色字」= 整页标题看不见。
 */
export interface SlidePage {
  shapes: readonly Shape[];
  /** 这一页的底色（从 `<Slide style={{background}}>` 量出来的）。 */
  background: string;
}

export async function writeSlidePptx(
  pages: readonly SlidePage[],
  outPath: string,
  assetsRoot: string | null,
): Promise<void> {
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'SLIDE169', width: inOf(SLIDE_CANVAS.width), height: inOf(SLIDE_CANVAS.height) });
  pptx.layout = 'SLIDE169';
  const gradients: GradientTarget[] = [];
  for (const page of pages) emitPage(pptx, page, assetsRoot, gradients);
  await pptx.writeFile({ fileName: outPath });
  await applyGradients(outPath, gradients);
}

function emitPage(pptx: PptxGenJS, page: SlidePage, assetsRoot: string | null, gradients: GradientTarget[]): void {
  const slide = pptx.addSlide();
  slide.background = { color: page.background };

  for (const s of page.shapes) {
    const box = { x: inOf(s.x), y: inOf(s.y), w: inOf(s.w), h: inOf(s.h) };

    if (s.kind === 'image') {
      const abs = assetsRoot ? path.join(assetsRoot, path.basename(decodeURIComponent(s.src))) : '';
      if (!abs || !fs.existsSync(abs)) continue; // 缺图就跳过这一张，不让整页失败
      // ⚠️ 传 `path` 会让 pptxgenjs 走浏览器的 XHR 取图（node 下直接
      //    `XMLHttpRequest is not defined` 崩掉）。自己读字节、以 data URL 交给它。
      const ext = path.extname(abs).slice(1).toLowerCase();
      const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`;
      const data = `data:${mime};base64,${fs.readFileSync(abs).toString('base64')}`;
      slide.addImage({ data, ...box, sizing: { type: 'cover', w: box.w, h: box.h } });
      continue;
    }

    if (s.kind === 'rect') {
      const objectName = s.gradient ? `slidegen-gradient-${gradients.length}` : undefined;
      if (s.gradient && objectName) gradients.push({ gradient: s.gradient, objectName });
      slide.addShape(s.radius > 0 ? pptx.ShapeType.roundRect : pptx.ShapeType.rect, {
        ...box,
        objectName,
        fill: { color: s.fill, transparency: s.fillTransparency },
        line:
          s.borderWidth > 0 && s.borderColor
            ? { color: s.borderColor, width: s.borderWidth * PT_PER_PX, transparency: s.borderTransparency }
            : { color: s.fill, width: 0, transparency: 100 },
        ...(s.radius > 0 ? { rectRadius: inOf(s.radius) } : {}),
      });
      continue;
    }

    const shared = {
      ...box,
      fontSize: s.fontSize,
      bold: s.bold,
      fontFace: s.fontFace || 'Microsoft YaHei',
      lineSpacing: s.lineSpacing,
      italic: s.italic,
      align: s.align,
      valign: 'top' as const,
      charSpacing: s.letterSpacing,
      margin: 0,
      wrap: s.wrap,
    };

    if (s.gradient) {
      // ⭐ 渐变文字：**逐字一个 run，各自插值取色** —— 真的渲染出渐变。
      //    （对标那份 deck 这里是降级成第一站的单色；我们这条更贴近设计稿。）
      const chars = [...s.text];
      const runs = chars.map((ch, i) => ({
        text: ch,
        options: { color: sampleGradient(s.gradient!, chars.length > 1 ? i / (chars.length - 1) : 0) },
      }));
      slide.addText(runs, shared);
      continue;
    }
    slide.addText(s.text, { ...shared, color: s.color, transparency: s.transparency });
  }
}
