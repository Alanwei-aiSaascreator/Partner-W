/**
 * 「流式中还没写完的围栏代码块」判据（2026-10-08 对话可视化改造 · Task 6；R7 重写）。
 *
 * 用途：流式渲染时，**尚未闭合**的代码块要打虚线占位（`.prose-chat [data-code-pending] pre`），
 * 闭合后整体套样式（复刻包实测的渲染时机策略：代码块先占位、闭合后整体套用）。
 *
 * ## 为什么不是"裸文本围栏扫描器"（Codex 审核 P2 / R7）
 *
 * 计数法与"剥引用标记再正则"都有真实反例：4 反引号开 + 3 反引号闭、```/~~~ 混用、
 * 列表里缩进 4 空格的闭合围栏、根级代码正文里字面量 `> \`\`\``（不是容器）——
 * 固定缩进/字符剥离都会误判。本函数**不重扫围栏**，改用解析器已经给出的两样东西做
 * **行数对齐**（token/AST + 源位置）：
 *
 *   - `startOffset/endOffset`：解析器给出的该 code 节点在原文里的跨度；
 *   - `codeText`：解析器给出的**代码正文**（容器前缀已被剥掉，行结构原样保留）。
 *
 * 事实：围栏内的正文按**原样行**保留（一个内容行 ↔ 原文一个行，只差容器前缀）。
 * 因此 —— 未闭合 ⇒ 原始段落行数与 codeText 行数**一一对齐**；已闭合 ⇒ 原始段落里
 * 多出**一行闭合围栏**（行数 = codeText + 1）。多出来即闭合。不猜容器前缀、不做
 * 任何按内容剥字符的操作（那会把代码正文里的字面量 `> \`\`\`` 错当闭合符）。
 */

/** 去掉尾部空白行（两侧对齐前统一口径；代码块尾随空行不计结构）。 */
function trimTrailingBlankLines(lines: readonly string[]): string[] {
  let end = lines.length;
  while (end > 0 && (lines[end - 1] ?? '').trim() === '') end -= 1;
  return lines.slice(0, end);
}

/**
 * 解析器给出的节点位置（hast `node.position`，offsets 基于**原文**字符）+ 代码正文。
 *
 * @param content    当前 Markdown 原文
 * @param startOffset 该 code 节点在原文中的起始偏移（hast position.start.offset）
 * @param endOffset   该 code 节点在原文中的结束偏移（hast position.end.offset）
 * @param codeText    该代码块的正文（组件已从 children 展平，容器前缀已由解析器剥掉）
 */
export function isPendingFencedCode(
  content: string,
  startOffset: number,
  endOffset: number,
  codeText: string,
): boolean {
  if (!Number.isFinite(startOffset) || !Number.isFinite(endOffset)) return false;
  if (startOffset < 0 || endOffset <= startOffset || endOffset > content.length) return false;
  // ① 只有**贴到文档末尾**（忽略尾部空白）的代码块才可能是"还在写"的那一块。
  const trimmedLength = content.replace(/\s+$/u, '').length;
  if (endOffset < trimmedLength) return false;

  const slice = content.slice(startOffset, endOffset);
  const firstNewline = slice.indexOf('\n');
  const firstLine = firstNewline === -1 ? slice : slice.slice(0, firstNewline);
  // ② 只处理**围栏**代码块（≤3 空格 + 可选引用标记后是 ```/~~~）；缩进代码不在本判据范围。
  if (!/^(?: {0,3}> ?)* {0,3}(`{3,}|~{3,})/.test(firstLine)) return false;

  const rawBody = firstNewline === -1 ? [] : slice.slice(firstNewline + 1).split('\n');
  const rawBodyLines = trimTrailingBlankLines(rawBody);
  const codeLines = trimTrailingBlankLines(codeText.split('\n'));
  // ③ 行数对齐：未闭合 ⇒ raw body 与 codeText 一一行对齐（相等）；已闭合 ⇒ raw 多一行围栏。
  return rawBodyLines.length <= codeLines.length;
}
