/**
 * 「流式中还没写完的围栏代码块」判据（2026-10-08 对话可视化改造 · Task 6）。
 *
 * 用途：流式渲染时，**尚未闭合**的代码块要打虚线占位（`.prose-chat [data-code-pending] pre`），
 * 闭合后整体套样式（复刻包实测的渲染时机策略：代码块先占位、闭合后整体套用）。
 *
 * ## 为什么不是"裸文本围栏扫描器"（Codex 审核 P2 / Task 6 补充）
 *
 * 计数法（奇偶）在 CommonMark 反例下是错的：4 反引号开 + 3 反引号闭、```/~~~ 混用、
 * 内容里含短围栏 —— 都会误判。本函数**不自己划块**：它只在**解析器（remark/react-markdown）
 * 已经给出的 code 节点**上回答两个问题（token/AST + 源位置核对）：
 *   ① 这个节点是不是**贴到文档末尾**的？（没贴边 ⇒ 后面还有内容 ⇒ 它已闭合）；
 *   ② 它的源片段里有没有**合法的闭合围栏行**（同字符、长度 ≥ 开启、行内只余空白）？
 * 容器（引用/列表）由解析器负责；这里只剥**引用标记**再判行（列表缩进由 ≤3 空格的
 * CommonMark 规则覆盖常见情形）。docgen/htmlgen 不走本判据（调用方在那之前就分支了）。
 */

/** 解析器给出的节点位置（hast `node.position`，offsets 基于**原文**字符）。 */
export function isPendingFencedCode(content: string, startOffset: number, endOffset: number): boolean {
  if (!Number.isFinite(startOffset) || !Number.isFinite(endOffset)) return false;
  if (startOffset < 0 || endOffset <= startOffset || endOffset > content.length) return false;
  // ① 只有**贴到文档末尾**（忽略尾部空白）的代码块才可能是"还在写"的那一块。
  const trimmedLength = content.replace(/\s+$/u, '').length;
  if (endOffset < trimmedLength) return false;

  const slice = content.slice(startOffset, endOffset);
  const lines = slice.split('\n');
  const opener = /^ {0,3}(`{3,}|~{3,})/.exec(lines[0] ?? '');
  if (!opener) return false; // 缩进代码（无围栏）等：不是本判据的对象

  const marker = opener[1]!;
  const fenceChar = marker[0] === '`' ? '`' : '~';
  const closerRe = new RegExp(`^ {0,3}${fenceChar}{${marker.length},}\\s*$`);
  for (let i = 1; i < lines.length; i += 1) {
    // ② 源片段里出现合法闭合行 ⇒ 已闭合。引用标记在原文里还在：剥掉再判。
    const line = (lines[i] ?? '').replace(/^(?: *> ?)+/, '');
    if (closerRe.test(line)) return false;
  }
  return true;
}
