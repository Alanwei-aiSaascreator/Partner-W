/**
 * 正文排版：**字号是算出来的，不是写死的**。
 *
 * ## 为什么必须算（2026-09-26 用真渲染器量出来的）
 *
 * 契约允许一页 12 条、每条 300 字。那几个上限是 P1 定的，技能里也是照它们写的，
 * **一个都不许改**（见 `request.ts` 的 `DOCGEN_LIMITS`）。于是只能从排版这侧解决。
 *
 * 写死 18pt 的实测后果（WPS 渲染成图看的，不是推断）：
 *
 * | 内容 | 结果 |
 * | --- | --- |
 * | 3 条短要点 | 正常 |
 * | **12 条短要点** | **第 1 条压在标题上** |
 * | 12 条 × 300 字 | 上下都冲出版面，不可读 |
 *
 * 成因两条叠加：正文框只有 3.2 英寸高，而 12 条在 18pt 下约 **4.38 英寸**高；
 * 且 pptxgenjs 的文本框默认**垂直居中** ⇒ 溢出是**对称**的，往上正好糊到标题。
 *
 * ## 模型是怎么标定的
 *
 * 从渲染图里反推：12 条短要点占 4.375 英寸 ⇒ 每行 ≈ 26.2pt。18pt × 行距 1.3 = 23.4pt，
 * 差出来的约 2.8pt 是 pptxgenjs 的**段间距**。所以：
 *
 * ```
 * 高 = 总行数 × 字号 × 1.3 + (条数 - 1) × PARA_SPACE_PT
 * ```
 *
 * ⚠️ 这是个**估算**，不是一个真排版引擎。它只保证"按这个模型装得下"，
 *    真正的保证来自用它渲染后用真渲染器回看（本项目就是这么验的）。
 */

import type { DocgenPptxRequest } from './request.js';

/** 正文框（英寸）。与 `render-pptx.ts` 里的实际取值是同一份，改这里就是改那里。 */
export const BODY_BOX = Object.freeze({ x: 0.85, y: 1.6, w: 8.4, h: 3.2 });

/**
 * 文本两侧留的内缩（英寸）。
 *
 * 文本框自己有内边距，项目符号还要再吃掉一条 —— 不扣的话估**行数**会偏少，
 * 而偏乐观正是这一族 bug 的成因。标题与正文用同一个值，尺子只有一把。
 */
const BOX_INSET_W = 0.4;

/** 封面主标题：位置、绘制框、字号。与 `render-pptx.ts` 共用一份。 */
export const COVER_TITLE = Object.freeze({ x: 0.6, y: 2.1, w: 9, h: 1.4, pt: 34 });

/** 封面副标题（时间 / 汇报人）。 */
export const COVER_SUBTITLE = Object.freeze({ x: 0.6, y: 3.75, w: 9, h: 0.8, pt: 16 });

/** 内容页标题。 */
export const SLIDE_TITLE = Object.freeze({ x: 0.6, y: 0.45, w: 9, h: 0.9, pt: 26 });

/**
 * 标题下沿那条装饰线的位置。
 *
 * ⭐ 它是标题真正的**下边界**，不是 `SLIDE_TITLE` 的绘制高度：标题框写 0.9 英寸
 * 只是画框，文字并不会被裁（pptxgenjs 不做 autofit），两行 26pt 是 0.94 英寸 ——
 * 越过这条线，第二行就压在装饰线上。判定按这条线算，不按绘制框算。
 */
export const SLIDE_TITLE_RULE = Object.freeze({ x: 0.6, y: 1.28, w: 1.2, h: 0.045 });

/**
 * 封面标题下面那条短装饰线。封面上唯一在标题与副标题之间的元素，也就是标题的下边界。
 *
 * ⚠️ 这里的 `y` **不是**画上去才有的数字：`COVER_SUBTITLE` 的上边界、以及
 *    `findPptxLayoutProblem` 判"封面标题装不装得下"都读它。改了它 = 改了判定。
 */
export const COVER_RULE = Object.freeze({ x: 0.6, y: 3.5, w: 1.6, h: 0.06 });

/**
 * 页脚那一行：**左边演示标题、右边页码**。
 *
 * 分两处放而不是居中合成一句，是为了页码**右对齐** —— 页码会从 9 变到 10，
 * 居中的话每翻一页都在挪位置。左框留宽、右框贴右边界，两边互不打扰。
 */
export const FOOTER_BOX = Object.freeze({ x: 0.6, y: 5.02, w: 6.0, h: 0.32 });
export const PAGE_NUMBER_BOX = Object.freeze({ x: 8.0, y: 5.02, w: 1.4, h: 0.32 });

/** 页脚与页码的字号。比正文最小号（`MIN_BODY_PT`）还小 —— 它们不该跟内容抢视线。 */
export const CHROME_PT = 9;

/** 封面底部那条满幅色带（x=0、宽=整幅）。封面上唯一的"设计感"来源。 */
export const COVER_BAND = Object.freeze({ x: 0, y: 5.325, w: 10, h: 0.3 });

/** 内容装得下时用的字号 —— 与 P1 的观感一致，正常篇幅的版式不会因此改变。 */
export const MAX_BODY_PT = 18;

/**
 * 下限。再小就不是"排版"而是"缩微"了；到这个值还装不下说明内容真的过量，
 * 那是**内容**该分页的事，不是把字缩到看不见能解决的。
 */
export const MIN_BODY_PT = 11;

/** 行距倍数。与 `render-pptx.ts` 的 `lineSpacingMultiple` 同源。 */
export const LINE_SPACING = 1.3;

/**
 * 每条要点之间的间距（pt）。从真渲染图反推出来的，不是 pptxgenjs 的公开默认值。
 */
const PARA_SPACE_PT = 3;

/**
 * 去掉项目符号占位后可用的正文宽度（英寸）。
 * 符号与缩进吃掉一小条，不扣的话估高会偏乐观 —— 而偏乐观正是这个 bug 的成因。
 */
const BODY_TEXT_W = BODY_BOX.w - BOX_INSET_W;

/**
 * 文本的"半角宽"（CJK/全角算 2，ASCII 算 1）。
 *
 * 用半角为单位、字号折算成"每行多少个半角"，是为了让中英混排同一个口径 ——
 * 简报里的"U 盘更新：已复验"正是混排。
 */
function halfWidthUnits(text: string): number {
  let units = 0;
  for (const char of text) {
    units += (char.codePointAt(0) ?? 0) > 0x2e7f ? 2 : 1;
  }
  return units;
}

/** 一行放得下多少个"半角"。框越窄、字号越大，一行放得越少。 */
function halfUnitsPerLine(widthIn: number, sizePt: number): number {
  return (widthIn * 72) / (sizePt / 2);
}

/** 一段文字占几行。至少 1 行 —— 空串（虽然契约层会丢掉）不该算出 0。 */
function wrappedLinesIn(text: string, sizePt: number, widthIn: number): number {
  return Math.max(1, Math.ceil(halfWidthUnits(text) / halfUnitsPerLine(widthIn, sizePt)));
}

/** 一条要点占几行。 */
function wrappedLines(text: string, sizePt: number): number {
  return wrappedLinesIn(text, sizePt, BODY_TEXT_W);
}

/**
 * 一段**不带项目符号**的文字（标题、副标题）按这个字号排，需要多高（pt）。
 *
 * 与正文同一套口径（同样的行距倍数、同样扣掉两侧内缩）—— 这样"标题装不下"
 * 和"正文装不下"是同一把尺子量出来的，不会一个宽一个严。
 */
export function estimateTextHeightPt(text: string, sizePt: number, box: { w: number }): number {
  if (!text) return 0;
  return wrappedLinesIn(text, sizePt, box.w - BOX_INSET_W) * sizePt * LINE_SPACING;
}

/**
 * 按这个字号排，正文一共多高（pt）。导出是为了让测试能独立验算"装得下"，
 * 而不是在测试里手抄一份 —— 手抄的那份绿了不代表真身对。
 */
export function estimateBodyHeightPt(bullets: readonly string[], sizePt: number): number {
  if (bullets.length === 0) return 0;
  const lines = bullets.reduce((sum, text) => sum + wrappedLines(text, sizePt), 0);
  return lines * sizePt * LINE_SPACING + (bullets.length - 1) * PARA_SPACE_PT;
}

/**
 * 正文该用多大字号：从 `MAX_BODY_PT` 起往下找第一个装得下的整数号。
 * 都装不下就返回 `MIN_BODY_PT`（此时超量的是内容，不是排版能救的）。
 */
export function bodyFontSizePt(bullets: readonly string[]): number {
  const available = BODY_BOX.h * 72;
  for (let size = MAX_BODY_PT; size > MIN_BODY_PT; size -= 1) {
    if (estimateBodyHeightPt(bullets, size) <= available) return size;
  }
  return MIN_BODY_PT;
}

/**
 * 一处**排版上装不下**的地方。
 *
 * 为什么要有这个类型（而不是直接抛一句人话）：这个结论要跨主进程 → IPC → 界面三道边界，
 * 每一道都得能被判定，所以是**码 + 数字**，文案在各层各自本地化（见 `docgen-failure.ts`）。
 *
 * `page` 是 `slides` 数组里**从 1 数**的那一页，封面不算。选这个口径是因为要照着改的是
 * **助手**：它手里就是那个 `slides` 数组，`slides[page-1]` 一步到位。用"含封面的页序"
 * 会让它每次都得减一，而减错一次就是再失败一轮。
 */
export type PptxLayoutProblem =
  | { code: 'slide-body-overflow'; page: number }
  | { code: 'slide-title-overflow'; page: number; maxChars: number }
  | { code: 'cover-title-overflow'; maxChars: number }
  | { code: 'cover-subtitle-overflow'; maxChars: number };

/**
 * 排不下时抛的错。**带着可判定的 `problem`**，不是一句人话字符串 ——
 * 调用方要按它决定给用户看哪句话（见 `shared/docgen-failure.ts`）。
 */
export class PptxLayoutError extends Error {
  readonly problem: PptxLayoutProblem;

  constructor(problem: PptxLayoutProblem) {
    super(`pptx layout: ${problem.code}${'page' in problem ? ` (slide ${problem.page})` : ''}`);
    this.name = 'PptxLayoutError';
    this.problem = problem;
  }
}

/** 一个框里还能放得下几个**全角**字（给用户的提示用；按全角估，英文能放更多）。 */
function maxFullWidthChars(box: { w: number }, sizePt: number, availablePt: number): number {
  const lines = Math.floor(availablePt / (sizePt * LINE_SPACING));
  return Math.max(0, Math.floor((lines * halfUnitsPerLine(box.w - BOX_INSET_W, sizePt)) / 2));
}

/** 这段文字在这个字号下，是否装得进"框顶端 → 下边界"这段高度。 */
function fitsAbove(text: string, sizePt: number, box: { w: number }, limitY: number, topY: number): boolean {
  return estimateTextHeightPt(text, sizePt, box) <= (limitY - topY) * 72;
}

/**
 * 这份演示文稿**能不能排成一份看得清的 PPT**。返回第一处装不下的地方，全装得下则 `null`。
 *
 * ## 为什么要判，而不是"让字号再小一点"
 *
 * 契约允许一页 12 条 × 300 字（`DOCGEN_LIMITS` 是 P1 定死的，一个都不许动），
 * 于是有**结构上就装不下**的体量。在这之前那种输入会得到一份**糊出画面的 PPT**：
 * 文字冲出上下边界、压在标题上 —— 用户拿到的是"我们坏了"，而不是"内容太多"。
 * 现在同样的输入会被**当场拒掉**并说清楚是哪一页、为什么、怎么改。
 *
 * ## 判定顺序
 *
 * 封面标题 → 封面副标题 → 逐页（先标题、后正文）。**只报第一处**：一次让助手改一件事，
 * 改完再来，比一次糊十行错误更可能被改对。
 *
 * ⚠️ 这仍然是个**估算模型**，不是真排版引擎。真正的保证来自生成之后用真渲染器回看
 *    （本项目就是这么验的，见 `docs/` 里的 PPT 记录）。
 */
export function findPptxLayoutProblem(request: DocgenPptxRequest): PptxLayoutProblem | null {
  const coverTitleLimit = COVER_RULE.y;
  if (!fitsAbove(request.title, COVER_TITLE.pt, COVER_TITLE, coverTitleLimit, COVER_TITLE.y)) {
    return {
      code: 'cover-title-overflow',
      maxChars: maxFullWidthChars(COVER_TITLE, COVER_TITLE.pt, (coverTitleLimit - COVER_TITLE.y) * 72),
    };
  }

  if (request.subtitle) {
    // 副标题下面没有别的元素，一直到封面底部那条色带为止。
    const limit = COVER_BAND.y;
    if (!fitsAbove(request.subtitle, COVER_SUBTITLE.pt, COVER_SUBTITLE, limit, COVER_SUBTITLE.y)) {
      return {
        code: 'cover-subtitle-overflow',
        maxChars: maxFullWidthChars(COVER_SUBTITLE, COVER_SUBTITLE.pt, (limit - COVER_SUBTITLE.y) * 72),
      };
    }
  }

  for (const [index, slide] of request.slides.entries()) {
    const page = index + 1;
    const titleLimit = SLIDE_TITLE_RULE.y;
    if (!fitsAbove(slide.title, SLIDE_TITLE.pt, SLIDE_TITLE, titleLimit, SLIDE_TITLE.y)) {
      return {
        code: 'slide-title-overflow',
        page,
        maxChars: maxFullWidthChars(SLIDE_TITLE, SLIDE_TITLE.pt, (titleLimit - SLIDE_TITLE.y) * 72),
      };
    }
    if (estimateBodyHeightPt(slide.bullets, MIN_BODY_PT) > BODY_BOX.h * 72) {
      return { code: 'slide-body-overflow', page };
    }
  }

  return null;
}
