import PptxGenJS from 'pptxgenjs';
import {
  BODY_BOX,
  CHROME_PT,
  COVER_BAND,
  COVER_RULE,
  COVER_SUBTITLE,
  COVER_TITLE,
  FOOTER_BOX,
  LINE_SPACING,
  PAGE_NUMBER_BOX,
  PptxLayoutError,
  SLIDE_TITLE,
  SLIDE_TITLE_RULE,
  bodyFontSizePt,
  coverTitlePtFor,
  findPptxLayoutProblem,
} from './pptx-layout.js';
import type { DocgenPptxRequest } from './request.js';

/**
 * 把校验过的 pptx 请求渲染成 pptx 字节。
 *
 * ⚠️ 这一层是**唯一**碰 pptxgenjs 的地方：`request.ts` 只做校验（可穷举测试），
 * 这里只做排版（用"解包看结构 + 文字真的在"来验，见 `test/docgen-render-pptx.test.ts`）。
 *
 * ## 三个刻意的取舍
 *
 * 1. **只存字体名、不内嵌字体**（`fontFace`）。中文用微软雅黑：这是 Windows 自带字体，
 *    而本产品只发 Windows。内嵌字体既有体积问题也有授权问题，不做。
 * 2. **一种版式**（封面 + 标题/要点页）。P1 的目标是把链路走通，
 *    多版式是后续版本的事 —— 现在多做一种版式就多一份没人验过的代码。
 * 3. **排不下就当场拒**（`findPptxLayoutProblem`，写在**动任何一页之前**）。
 *    以前这里会把一份装不下的内容照样画出来，用户拿到的是文字冲出画面、
 *    压在标题上的 PPT —— 那不是"生成失败"，那比失败更难发现。
 *
 * ## 几何量只有一份
 *
 * 所有框的位置/尺寸/字号都从 `pptx-layout.ts` 来（那里同时是判定模型的家）。
 * 在这里另写一份坐标，就会出现"判定按 A 算、绘制按 B 画"的错位 ——
 * 而那种错位的表现恰好是"判定说装得下、画面却压在一起"。
 */

/** 屏幕 16:9，与交付盘上大家习惯的投影比例一致。 */
const LAYOUT = 'LAYOUT_16x9' as const;
const FONT = '微软雅黑';

const COLOR_TITLE = '1F2937';
const COLOR_BODY = '374151';
const COLOR_MUTED = '6B7280';
const COLOR_ACCENT = '2563EB';

export async function renderPptx(request: DocgenPptxRequest): Promise<Buffer> {
  // ⭐ 判定在**最前面**，早于 `new PptxGenJS()`。排不下的内容在这个函数里
  //    一个字节都不会产出 —— 调用方拿到的是异常，不是一份半成品文件。
  const problem = findPptxLayoutProblem(request);
  if (problem) throw new PptxLayoutError(problem);

  const pptx = new PptxGenJS();
  pptx.layout = LAYOUT;
  pptx.title = request.title;
  if (request.subtitle) pptx.subject = request.subtitle;

  // ── 封面 ──────────────────────────────────────────────────────────────
  const cover = pptx.addSlide();
  cover.addText(request.title, {
    x: COVER_TITLE.x,
    y: COVER_TITLE.y,
    w: COVER_TITLE.w,
    h: COVER_TITLE.h,
    fontSize: coverTitlePtFor(request.title),
    bold: true,
    color: COLOR_TITLE,
    fontFace: FONT,
  });
  cover.addShape('rect', {
    x: COVER_RULE.x,
    y: COVER_RULE.y,
    w: COVER_RULE.w,
    h: COVER_RULE.h,
    fill: { color: COLOR_ACCENT },
  });
  if (request.subtitle) {
    cover.addText(request.subtitle, {
      x: COVER_SUBTITLE.x,
      y: COVER_SUBTITLE.y,
      w: COVER_SUBTITLE.w,
      h: COVER_SUBTITLE.h,
      fontSize: COVER_SUBTITLE.pt,
      color: COLOR_MUTED,
      fontFace: FONT,
    });
  }
  // 满幅色带。封面本来只有一块白底加两行字，加这一条是为了让它**看起来被设计过**，
  // 而不是 Word 文档截了个图。刻意只加这一处 —— 封面越素，内容页越显专业。
  cover.addShape('rect', {
    x: COVER_BAND.x,
    y: COVER_BAND.y,
    w: COVER_BAND.w,
    h: COVER_BAND.h,
    fill: { color: COLOR_ACCENT },
  });

  // ── 内容页 ────────────────────────────────────────────────────────────
  // 页码按**含封面**的总数编，与 PowerPoint 自己的编号一致 —— 否则有人说"第 3 页"，
  // 我们对不上。封面不显示页码，但占一个号。
  const totalPages = request.slides.length + 1;
  for (const [index, slide] of request.slides.entries()) {
    const page = pptx.addSlide();
    page.addText(slide.title, {
      x: SLIDE_TITLE.x,
      y: SLIDE_TITLE.y,
      w: SLIDE_TITLE.w,
      h: SLIDE_TITLE.h,
      fontSize: SLIDE_TITLE.pt,
      bold: true,
      color: COLOR_TITLE,
      fontFace: FONT,
    });
    page.addShape('rect', {
      x: SLIDE_TITLE_RULE.x,
      y: SLIDE_TITLE_RULE.y,
      w: SLIDE_TITLE_RULE.w,
      h: SLIDE_TITLE_RULE.h,
      fill: { color: COLOR_ACCENT },
    });

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
    // 页脚：左演示标题、右页码。分两处放是为了页码**右对齐** ——
    // 页码会从 9 变到 10，居中会让它每翻一页挪一下。
    page.addText(request.title, {
      x: FOOTER_BOX.x,
      y: FOOTER_BOX.y,
      w: FOOTER_BOX.w,
      h: FOOTER_BOX.h,
      fontSize: CHROME_PT,
      color: COLOR_MUTED,
      fontFace: FONT,
    });
    page.addText(`${index + 2} / ${totalPages}`, {
      x: PAGE_NUMBER_BOX.x,
      y: PAGE_NUMBER_BOX.y,
      w: PAGE_NUMBER_BOX.w,
      h: PAGE_NUMBER_BOX.h,
      fontSize: CHROME_PT,
      color: COLOR_MUTED,
      fontFace: FONT,
      align: 'right',
    });

    if (slide.notes) page.addNotes(slide.notes);
  }

  // `outputType: 'nodebuffer'` 是 pptxgenjs 在 Node 下的写法；返回的是 zip 字节。
  return (await pptx.write({ outputType: 'nodebuffer' })) as Buffer;
}
