/**
 * 聊天区自动滚动的**目标位置**（2026-10-06 用户反馈 #16，纯计算层）。
 *
 * 反馈原文：「提问后答案要从下往上翻看，不方便」。
 * 旧行为只有一个目标 —— 底部：回答一长就只剩个结尾在屏幕上，要读全文得自己往上翻。
 *
 * 规则（三条，按优先级）：
 * 1. 用户自己滚回/停在最底部（`followBottom`）⇒ 跟随尾部 —— 他明确想看最新的那一截；
 * 2. 有正在生成的新回答（`anchorTop` 非空）：
 *    - 回答**还装得下**整段 ⇒ 目标就是底部（与旧行为一致，短回答的"跟随"体验不变）；
 *    - 回答**长过视口** ⇒ 钉在回答首行（上方留 `SCROLL_ANCHOR_MARGIN_PX` 余量），
 *      让用户从第一句开始读，而不是被推到结尾；
 * 3. 没有锚点（没有进行中的回答）⇒ 底部（原行为）。
 *
 * ⚠️ 只在"跟随开启"（用户没滚离底部）时才有机会调用它；用户滚开后调用方直接不动。
 */
export const SCROLL_ANCHOR_MARGIN_PX = 12;

export interface AnchoredScrollMetrics {
  /** 视口内容总高（`viewport.scrollHeight`）。 */
  contentHeight: number;
  /** 视口可视高度（`viewport.clientHeight`）。 */
  viewportHeight: number;
  /**
   * 锚点（新回答首行）在**视口坐标系**里的位置：滚到多少时它会正好贴在视口顶端。
   * 调用方用 `anchor.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop`
   * 现算（对 padding / offsetParent 都不敏感）。没有锚点 = `null`。
   */
  anchorTop: number | null;
  /** 用户主动停在最底部（滚到底 / 点了回到底部按钮）⇒ 尊重用户，跟随尾部。 */
  followBottom: boolean;
}

export function anchoredScrollTop({
  contentHeight,
  viewportHeight,
  anchorTop,
  followBottom,
}: AnchoredScrollMetrics): number {
  const bottom = Math.max(0, contentHeight - viewportHeight);
  if (followBottom || anchorTop === null) return bottom;
  return Math.min(bottom, Math.max(0, anchorTop - SCROLL_ANCHOR_MARGIN_PX));
}

/**
 * 时间线每一项在"滚动"这件事里的语义（由聊天区从 `timelineItems` 映射出来）。
 * - `user` —— 用户消息；
 * - `assistant` —— 助手消息（含刚定稿收编的那一条，槽位 key 与它在流式时**同一个**）；
 * - `live-answer` —— 正在生成的那一格（等待中或流式）；
 * - `other` —— 其余（没有可渲染内容的 turn 等）。
 */
export type ChatScrollSlot = 'user' | 'assistant' | 'live-answer' | 'other';

/**
 * 决定视口该钉在**哪一个槽位**上（key），`null` = 不钉首行、随底。
 *
 * 两个只有真实运行时才知道的坑，规则就是为它们写的：
 *
 * 1. **"新回答" = 紧跟在用户提问之后的生成格**。收编那一刻 `promoteActiveTurn` 与
 *    `setProcessing(false)` 是两次 store 写入 ⇒ 中间会短暂出现一个"等待中"残格，
 *    它前面是助手消息（不是用户提问）。锚点若交给它，长回答会在**读完的瞬间**被甩到底部。
 * 2. 锚点一旦记下就**跨过定稿/收编保持**（收编前后 key 与 DOM 节点都不变），
 *    只在"这一格不在了"（换任务等）或"用户又发了一条"时释放。
 */
export function resolveChatScrollAnchor(
  items: ReadonlyArray<{ key: string; slot: ChatScrollSlot }>,
  currentAnchorKey: string | null,
): string | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index].slot !== 'live-answer') continue;
    // 只看**最新**那个生成格：它是"新回答"就认领，否则（残留等待格）不动锚点。
    const previous = index > 0 ? items[index - 1] : null;
    if (previous?.slot === 'user') return items[index].key;
    break;
  }

  if (currentAnchorKey === null) return null;
  const anchorIndex = items.findIndex((item) => item.key === currentAnchorKey);
  if (anchorIndex === -1) return null; // 那一格已经不在了（换任务、清空）
  if (items.slice(anchorIndex + 1).some((item) => item.slot === 'user')) return null; // 用户又发了一条
  return currentAnchorKey; // 定稿 / 收编 / 收尾阶段：保持
}
