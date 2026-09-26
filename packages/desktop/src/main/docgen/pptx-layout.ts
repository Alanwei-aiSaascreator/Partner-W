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

/** 正文框（英寸）。与 `render-pptx.ts` 里的实际取值是同一份，改这里就是改那里。 */
export const BODY_BOX = Object.freeze({ x: 0.85, y: 1.6, w: 8.4, h: 3.2 });

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
const BODY_TEXT_W = BODY_BOX.w - 0.4;

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

/** 一条要点占几行。至少 1 行 —— 空串（虽然契约层会丢掉）不该算出 0。 */
function wrappedLines(text: string, sizePt: number): number {
  const perLineUnits = (BODY_TEXT_W * 72) / (sizePt / 2);
  return Math.max(1, Math.ceil(halfWidthUnits(text) / perLineUnits));
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
