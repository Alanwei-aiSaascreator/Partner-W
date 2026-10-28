import { describe, expect, it } from 'vitest';
import {
  SCROLL_ANCHOR_MARGIN_PX,
  anchoredScrollTop,
  resolveChatScrollAnchor,
  type ChatScrollSlot,
} from '../src/renderer/lib/chat-scroll-anchor';

const slot = (key: string, kind: ChatScrollSlot) => ({ key, slot: kind });

/**
 * 用户反馈 #16（`USER-FEEDBACK-TRIAGE-20261006.md` 第 25 行）：
 * 「提问后答案要从下往上翻看，不方便」。
 *
 * 规则（纯计算的那一半）：
 * - 没有正在生成的新回答（没有锚点）⇒ 维持原行为：滚到底；
 * - 新回答**还装得下**整段 ⇒ 继续跟随到底（跟随体验不变）；
 * - 新回答**长过视口** ⇒ 钉在回答首行（上方留一点余量），不让开头滑出视野；
 * - 用户自己主动回到最底部（`followBottom`）⇒ 尊重用户，跟随尾部。
 */
describe('anchoredScrollTop — 新回答的滚动目标', () => {
  it('没有锚点（没有正在生成的回答）时保持原行为：滚到底', () => {
    expect(anchoredScrollTop({ contentHeight: 1000, viewportHeight: 400, anchorTop: null, followBottom: false })).toBe(
      600,
    );
  });

  it('内容装不满视口：目标是 0，不产生负滚动', () => {
    expect(anchoredScrollTop({ contentHeight: 300, viewportHeight: 400, anchorTop: null, followBottom: false })).toBe(
      0,
    );
  });

  it('回答短于视口：整段还在视口内 ⇒ 跟随到底（跟随体验不变）', () => {
    // 底部 = 500 - 400 = 100；锚点在 300 ⇒ 288 > 100 ⇒ 取底
    expect(anchoredScrollTop({ contentHeight: 500, viewportHeight: 400, anchorTop: 300, followBottom: false })).toBe(
      100,
    );
  });

  it('回答长于视口：钉在回答首行（上留余量），不让开头滑出视野', () => {
    // 底部 = 2000 - 400 = 1600；锚点 588 ⇒ 目标 = 588 - 余量
    expect(anchoredScrollTop({ contentHeight: 2000, viewportHeight: 400, anchorTop: 588, followBottom: false })).toBe(
      588 - SCROLL_ANCHOR_MARGIN_PX,
    );
  });

  it('锚点已经在视口顶端附近：不产生负值', () => {
    expect(anchoredScrollTop({ contentHeight: 2000, viewportHeight: 400, anchorTop: 4, followBottom: false })).toBe(0);
  });

  it('用户主动回到最底部（followBottom）：即使回答很长也跟随尾部', () => {
    expect(anchoredScrollTop({ contentHeight: 2000, viewportHeight: 400, anchorTop: 588, followBottom: true })).toBe(
      1600,
    );
  });
});

/**
 * 锚点该落在**哪一格**。这里的规则是被真实时序逼出来的：
 * 收编（`promoteActiveTurn`）与 `setProcessing(false)` 是两次 store 写入 ⇒ 中间会短暂出现
 * 一个"等待中"残格，它前面是**助手消息**而不是用户提问 —— 它绝不是"新回答"。
 */
describe('resolveChatScrollAnchor — 锚点落在哪一格', () => {
  it('紧跟在用户提问之后的生成格 = 新回答 ⇒ 认领它', () => {
    const items = [slot('u1', 'user'), slot('a1', 'live-answer')];
    expect(resolveChatScrollAnchor(items, null)).toBe('a1');
  });

  it('同一个生成格从等待变流式（key 不变）⇒ 锚点不动', () => {
    const items = [slot('u1', 'user'), slot('a1', 'live-answer')];
    expect(resolveChatScrollAnchor(items, 'a1')).toBe('a1');
  });

  it('残留等待格（前一项是助手消息）⇒ **不移动**锚点，用户正读的长回答不被甩走', () => {
    // 收编那一刻的真实形状：正式消息 a1 已经在了，processingBySession 还没清 ⇒ 多出 a2
    const items = [slot('u1', 'user'), slot('a1', 'assistant'), slot('a2', 'live-answer')];
    expect(resolveChatScrollAnchor(items, 'a1')).toBe('a1');
  });

  it('定稿 / 收编之后（生成格没了、锚点那一格还在）⇒ 保持', () => {
    const items = [slot('u1', 'user'), slot('a1', 'assistant')];
    expect(resolveChatScrollAnchor(items, 'a1')).toBe('a1');
  });

  it('用户又发了一条（锚点之后出现用户消息）⇒ 释放，回到底部', () => {
    const items = [slot('u1', 'user'), slot('a1', 'assistant'), slot('u2', 'user')];
    expect(resolveChatScrollAnchor(items, 'a1')).toBeNull();
  });

  it('锚点那一格已经不在时间线里（换任务 / 清空）⇒ 释放', () => {
    const items = [slot('u1', 'user'), slot('a9', 'assistant')];
    expect(resolveChatScrollAnchor(items, 'a1')).toBeNull();
  });

  it('没有锚点、也没有新回答 ⇒ null（原行为：随底）', () => {
    expect(resolveChatScrollAnchor([slot('u1', 'user'), slot('a1', 'assistant')], null)).toBeNull();
  });

  it('时间线为空 ⇒ null', () => {
    expect(resolveChatScrollAnchor([], 'a1')).toBeNull();
  });
});
