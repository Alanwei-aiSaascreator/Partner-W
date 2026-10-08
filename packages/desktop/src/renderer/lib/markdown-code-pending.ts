/**
 * 「流式中还没写完的围栏代码块」判据（2026-10-08 对话可视化改造 · Task 6；G2 重写）。
 *
 * 用途与样式契约不变：流式渲染时 **尚未闭合** 的代码块打虚线占位
 * （`.prose-chat [data-code-pending] pre`），闭合后整体套样式。
 *
 * ## G2（集中终审 · P2 必修）：行数启发式换真实解析器 token
 *
 * 旧判据（原文行数与解析器给出的正文行数"对齐"）在三个形状上同根失效：
 * 引用/嵌套引用的**两行及以上容器空尾**再次误判、**纯 CR 换行**下已闭合围栏误判。
 * 现在改为**两次真实解析的交叉判定**，不再数行：
 *
 *   - `mdast-util-from-markdown`：取文档 AST 里"最后一个有实际内容的叶节点"——
 *     它必须是 `code`（未闭合围栏才会是文档的最后一块），记下它的原文起点；
 *   - `micromark` 的 `codeFenced` token 事件流：数该围栏的 `codeFencedFence`
 *     边沿（开启 + 显式闭合 = 2 个）；**恰好 1 个** = 只有开启、没有显式闭合 ⇒ 还在写。
 *
 * 与渲染链同源（react-markdown → remark-parse → 同族解析器），不引入另一套
 * Markdown 规则；缩进代码（`codeIndented`）、已闭合围栏、尾部真正的新块都会被
 * 正确排除，尾部空引用容器（`> `）不算"新内容"。两个依赖已声明为 desktop 的
 * 直接运行时依赖（`pnpm-lock.yaml` 同步）。
 */
import { fromMarkdown } from 'mdast-util-from-markdown';
import { parse, postprocess, preprocess } from 'micromark';

interface PositionedNode {
  type: string;
  children?: readonly PositionedNode[];
  position?: { start: { offset?: number } };
}

const CONTAINERS = new Set(['root', 'blockquote', 'list', 'listItem']);

// 只忽略没有实际内容的尾部容器；空 listItem 代表已开始的新块。
function lastMeaningfulLeaf(node: PositionedNode): PositionedNode | undefined {
  if (!CONTAINERS.has(node.type)) return node;
  if (node.type === 'listItem' && !node.children?.length) return node;
  let last: PositionedNode | undefined;
  for (const child of node.children ?? []) last = lastMeaningfulLeaf(child) ?? last;
  return last;
}

/** 返回文档最后仍未显式闭合的围栏代码节点的原文起点。 */
export function pendingFencedCodeStarts(content: string): ReadonlySet<number> {
  const pending = new Set<number>();
  const last = lastMeaningfulLeaf(fromMarkdown(content));
  const lastStart = last?.position?.start.offset;
  if (last?.type !== 'code' || typeof lastStart !== 'number') return pending;

  const events = postprocess(
    parse()
      .document()
      .write(preprocess()(content, undefined, true)),
  );
  let start: number | undefined;
  let fenceCount = 0;
  for (const [phase, token] of events) {
    if (phase === 'enter' && token.type === 'codeFenced') {
      start = token.start.offset;
      fenceCount = 0;
    } else if (phase === 'enter' && token.type === 'codeFencedFence') {
      fenceCount += 1;
    } else if (phase === 'exit' && token.type === 'codeFenced') {
      if (fenceCount === 1 && start === lastStart) pending.add(lastStart);
      start = undefined;
    }
  }
  return pending;
}

// 保留旧入口，避免无关调用方改名。生产渲染应在父层按 content memo 一次后查 Set。
export function isPendingFencedCode(
  content: string,
  startOffset: number,
  endOffset: number,
  _codeText: string,
): boolean {
  if (!Number.isFinite(startOffset) || !Number.isFinite(endOffset)) return false;
  if (startOffset < 0 || endOffset <= startOffset || endOffset > content.length) return false;
  return pendingFencedCodeStarts(content).has(startOffset);
}
