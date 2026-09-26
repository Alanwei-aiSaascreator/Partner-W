import PptxGenJS from 'pptxgenjs';
import { BODY_BOX, LINE_SPACING, bodyFontSizePt } from './pptx-layout.js';
import type { DocgenPptxRequest } from './request.js';

/**
 * 把校验过的 pptx 请求渲染成 pptx 字节。
 *
 * ⚠️ 这一层是**唯一**碰 pptxgenjs 的地方：`request.ts` 只做校验（可穷举测试），
 * 这里只做排版（用"解包看结构 + 文字真的在"来验，见 `test/docgen-render.test.ts`）。
 *
 * ## 两个刻意的取舍
 *
 * 1. **只存字体名、不内嵌字体**（`fontFace`）。中文用微软雅黑：这是 Windows 自带字体，
 *    而本产品只发 Windows。内嵌字体既有体积问题也有授权问题，不做。
 * 2. **一种版式**（封面 + 标题/要点页）。P1 的目标是把链路走通，
 *    排版样式（品牌色、多版式、模板）是 P3 的事 —— 现在多做一种版式就多一份没人验过的代码。
 */

/** 屏幕 16:9，与交付盘上大家习惯的投影比例一致。 */
const LAYOUT = 'LAYOUT_16x9' as const;
const FONT = '微软雅黑';

const COLOR_TITLE = '1F2937';
const COLOR_BODY = '374151';
const COLOR_MUTED = '6B7280';
const COLOR_ACCENT = '2563EB';

export async function renderPptx(request: DocgenPptxRequest): Promise<Buffer> {
  const pptx = new PptxGenJS();
  pptx.layout = LAYOUT;
  pptx.title = request.title;
  if (request.subtitle) pptx.subject = request.subtitle;

  // ── 封面 ──────────────────────────────────────────────────────────────
  const cover = pptx.addSlide();
  cover.addText(request.title, {
    x: 0.6,
    y: 2.1,
    w: 9,
    h: 1.4,
    fontSize: 34,
    bold: true,
    color: COLOR_TITLE,
    fontFace: FONT,
  });
  cover.addShape('rect', { x: 0.6, y: 3.5, w: 1.6, h: 0.06, fill: { color: COLOR_ACCENT } });
  if (request.subtitle) {
    cover.addText(request.subtitle, {
      x: 0.6,
      y: 3.75,
      w: 9,
      h: 0.8,
      fontSize: 16,
      color: COLOR_MUTED,
      fontFace: FONT,
    });
  }

  // ── 内容页 ────────────────────────────────────────────────────────────
  for (const slide of request.slides) {
    const page = pptx.addSlide();
    page.addText(slide.title, {
      x: 0.6,
      y: 0.45,
      w: 9,
      h: 0.9,
      fontSize: 26,
      bold: true,
      color: COLOR_TITLE,
      fontFace: FONT,
    });
    page.addShape('rect', { x: 0.6, y: 1.28, w: 1.2, h: 0.045, fill: { color: COLOR_ACCENT } });

    if (slide.bullets.length > 0) {
      // 字号由内容量算出来 —— 写死 18pt 会让 12 条要点压到标题上（`pptx-layout.ts`
      // 里有真渲染的实测记录）。框的取值也从那里来，两处只留一份。
      page.addText(
        slide.bullets.map((text) => ({ text, options: { bullet: true } })),
        {
          x: BODY_BOX.x,
          y: BODY_BOX.y,
          w: BODY_BOX.w,
          h: BODY_BOX.h,
          fontSize: bodyFontSizePt(slide.bullets),
          color: COLOR_BODY,
          fontFace: FONT,
          lineSpacingMultiple: LINE_SPACING,
        },
      );
    }
    if (slide.notes) page.addNotes(slide.notes);
  }

  // `outputType: 'nodebuffer'` 是 pptxgenjs 在 Node 下的写法；返回的是 zip 字节。
  return (await pptx.write({ outputType: 'nodebuffer' })) as Buffer;
}
