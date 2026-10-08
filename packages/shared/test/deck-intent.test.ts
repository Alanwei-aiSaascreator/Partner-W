import { describe, expect, it } from 'vitest';
import {
  isDeckCreateRequest,
  isDeckRevisionRequest,
  isDeckWorkRequest,
  isFreshDeckRequest,
} from '../src/deck-intent.js';

/**
 * Deck 判据**唯一真源**（2026-10-09 起）：渲染层路由与主进程 `reroutePptxToSlidegen`
 * 硬门共用这三个族。真实消费者的接线由
 * `packages/desktop/test/deck-intent.test.ts`（渲染层）与
 * `packages/desktop/test/data-handlers-slide-quality.test.ts`（主进程）各守一半。
 *
 * ⚠️ 判错方向的代价不对称：漏判 = 演示任务发给稳定性差的模型（真机实证：20 分钟
 *    修稿不收敛）；误判 = 一句聊天钉到 DeepSeek（无害）。规则保持短合取/短词表。
 */
describe('isDeckCreateRequest —— 制作动词 ∧ 演示名词', () => {
  it.each([
    '帮我做成一份PPT',
    '把这次培训的内容整理成培训课件',
    '生成演示文稿',
    '帮我做个 slides',
    '输出一份 deck',
    '把这个 Word 文档转成 PPT',
    '做一份培训课件，讲第三季度的数据',
    '帮我整理一份幻灯片',
    'PPT 帮我做一下',
    '生成 pptx',
    'export a deck for the client',
    'Create me a slide deck',
    '帮我做一个 slideshow',
    '帮我写个PPT',
    '写一份演示文稿',
    '编写幻灯片',
    '帮我撰写一份培训课件',
    // 2026-10-09 复审反例：首次制作的实际措辞（主进程旧口径漏判这三种）
    '把材料做成一份 PPT',
    '做一份公司介绍 PPT',
    'Generate a PPT',
  ])('真例：%s', (text) => {
    expect(isDeckCreateRequest(text)).toBe(true);
  });

  it.each([
    'PPT是什么',
    '昨天的汇报讲了啥',
    '帮我写个文档',
    '随便聊聊幻灯片的历史',
    '这个PPT里都有哪些内容',
    '幻灯片模板在哪里下载',
    '做个表格吧',
    '帮我做个网站首页',
    '帮我做一份预算表',
    '写一份演讲稿',
    '写邮件',
    '写一段周报',
    'make a deckchair',
    'decks are stacked on the table',
    '   ',
    '',
  ])('假例：%j', (text) => {
    expect(isDeckCreateRequest(text)).toBe(false);
  });
});

describe('isDeckRevisionRequest —— 改稿动词族（主进程原口径逐字搬入）', () => {
  it.each([
    // 2026-10-09 复审反例：新任务首次改稿的实际措辞（渲染层旧制作动词表漏判这三种）
    '美化这个 PPT',
    '调整 PPT 的排版',
    '优化这份 PPT',
    // 主进程既有的固定正例（data-handlers-slide-quality 接线测试钉住）
    '把这份 PPT 美化一下',
    '第一版不好看，重新排版',
    '改稿',
    '帮我重新排版一下',
    '这一页文字太挤了',
    'revise the deck layout',
    'restyle my slides',
  ])('真例：%s', (text) => {
    expect(isDeckRevisionRequest(text)).toBe(true);
  });

  it.each(['帮我做一份PPT', '把这份表格整理成 Excel', '', '   '])('假例：%j', (text) => {
    expect(isDeckRevisionRequest(text)).toBe(false);
  });
});

describe('isFreshDeckRequest —— "再来一份全新的"（窄口径，供 native 收据语义）', () => {
  it.each(['另做一份PPT', '帮我生成另外一份新的PPT', '另外做一份新的PPT，风格再美观一点', 'new deck please'])(
    '真例：%s',
    (text) => {
      expect(isFreshDeckRequest(text)).toBe(true);
    },
  );

  it.each(['把这份 PPT 美化一下', '生成演示文稿', '第一版不好看，重新排版'])('假例：%s', (text) => {
    expect(isFreshDeckRequest(text)).toBe(false);
  });
});

describe('isDeckWorkRequest —— 三族取并（两个消费者共用这一个出口）', () => {
  it.each([
    '把材料做成一份 PPT',
    '做一份公司介绍 PPT',
    'Generate a PPT',
    '美化这个 PPT',
    '调整 PPT 的排版',
    '优化这份 PPT',
    '另做一份PPT',
    '帮我做一份PPT',
  ])('命中：%s', (text) => {
    expect(isDeckWorkRequest(text)).toBe(true);
  });

  it.each(['PPT是什么', '帮我写个文档', '把这份表格整理成 Excel', '', '   '])('不命中：%j', (text) => {
    expect(isDeckWorkRequest(text)).toBe(false);
  });

  it('已知的宽判（有意保留）：无演示名词的「美化」也命中改稿族 —— 渲染层按代价不对称接受（误判 = 一句聊天钉 DeepSeek，无害）', () => {
    expect(isDeckWorkRequest('帮我把卧室美化一下，选浅色窗帘')).toBe(true);
  });
});
