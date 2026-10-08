import { describe, expect, it } from 'vitest';
import {
  DECK_ROUTE_MODEL_ID,
  looksLikeDeckRequest,
  planDeckRouting,
  resolveDeckModelId,
} from '../src/renderer/lib/deck-intent';

/**
 * Deck 意图的判据（纯函数）——接线（改 `presetModel` + 粘性标记）由
 * `use-chat-send.test.tsx` 的「Deck 意图路由」describe 守。
 *
 * ⚠️ 判错方向的代价不对称：漏判 = 演示任务仍发给 qwen（真机实证：20 分钟修稿
 *    不收敛，就是要治的那个病）；误判 = 一句聊天发给 DeepSeek（无害，且任务
 *    随后多半真的在做 PPT）。所以规则取"动词 ∧ 名词"的合取，不堆负向守卫。
 */
describe('looksLikeDeckRequest —— 真例（制作动词 ∧ 演示名词）', () => {
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
    // 「写」族：极常见说法，必须命中（`编写`/`撰写` 是 `写` 的子串，一处扩表全覆盖）
    '帮我写个PPT',
    '写一份演示文稿',
    '编写幻灯片',
    '帮我撰写一份培训课件',
  ])('真例：%s', (text) => {
    expect(looksLikeDeckRequest(text)).toBe(true);
  });
});

describe('looksLikeDeckRequest —— 假例（缺动词或缺名词都不算）', () => {
  it.each([
    'PPT是什么', // 名词在、无制作动词
    '昨天的汇报讲了啥', // 两个都没有
    '帮我写个文档', // 名词不是演示类
    '随便聊聊幻灯片的历史', // 名词在、动词缺
    '这个PPT里都有哪些内容', // 同上
    '幻灯片模板在哪里下载', // 同上
    '做个表格吧', // 动词在、名词缺
    '帮我做个网站首页', // 同上
    '帮我做一份预算表', // 同上
    '写一份演讲稿', // 「写」在，但名词不是演示类
    '写邮件', // 同上
    '写一段周报', // 同上
    'make a deckchair', // 动词在，但 deck 是词内片段（\b 边界）
    'decks are stacked on the table', // 复数形式不算名词、也没有动词
    '   ', // 空白
    '', // 空串
  ])('假例：%j', (text) => {
    expect(looksLikeDeckRequest(text)).toBe(false);
  });
});

/**
 * ⭐ 2026-10-09 复审反例（P1）：**新任务首次改稿**的实际措辞。
 * 原制作动词表（做/制作/生成/整理/导出/输出/创建/转成/写）不含改稿动词 ⇒ 任务又没有
 * `deckRouted` 粘性标记 ⇒ 首次改稿照旧发给普通模型。判据已统一到 `@clawwork/shared`
 * （`isDeckWorkRequest` = 制作 ∨ 改稿 ∨ "再来一份全新的"）。
 */
describe('⭐ 2026-10-09 复审反例：新任务首次改稿必须命中', () => {
  it.each(['美化这个 PPT', '调整 PPT 的排版', '优化这份 PPT', '把这份演示文稿重新排版', 'revise the deck'])(
    '%s',
    (text) => {
      expect(looksLikeDeckRequest(text)).toBe(true);
    },
  );
});

describe('resolveDeckModelId —— 对着目录解析真实 id', () => {
  it('默认目标就是 deepseek-v4-flash', () => {
    expect(DECK_ROUTE_MODEL_ID).toBe('deepseek-v4-flash');
    expect(resolveDeckModelId(['deepseek-v4-flash'])).toBe('deepseek-v4-flash');
  });

  it('按末段比对：目录里带命名空间的写法命中，且返回**目录里的原样 id**（与 resolveModeModelId 同一把尺）', () => {
    expect(resolveDeckModelId(['clawrouter/qwen3.7-flash', 'clawrouter/deepseek-v4-flash'])).toBe(
      'clawrouter/deepseek-v4-flash',
    );
  });

  it('目录里没有它 ⇒ undefined（调用方原样放行、不拦截）', () => {
    expect(resolveDeckModelId(['qwen3.7-flash'])).toBeUndefined();
    expect(resolveDeckModelId([])).toBeUndefined();
  });

  it('不误命中同家族的其它型号（deepseek-v4-pro 不算）', () => {
    expect(resolveDeckModelId(['clawrouter/deepseek-v4-pro'])).toBeUndefined();
  });
});

describe('planDeckRouting —— 粘性标记与 custom 豁免', () => {
  const CATALOG = ['qwen3.7-flash', 'deepseek-v4-flash'];

  it('模式任务 + 本条首次命中 ⇒ 路由 + 标记任务', () => {
    expect(planDeckRouting({ sendMode: 'smart', task: {}, text: '帮我做一份PPT', catalogModelIds: CATALOG })).toEqual({
      route: true,
      modelId: 'deepseek-v4-flash',
      markTask: true,
    });
  });

  it('⭐ 粘性：已标记的任务 + 不含演示名词的后续消息（改稿"把标题改一下"）⇒ 仍走 deepseek、不重复标记', () => {
    expect(
      planDeckRouting({
        sendMode: 'smart',
        task: { deckRouted: true },
        text: '把标题改一下',
        catalogModelIds: CATALOG,
      }),
    ).toEqual({ route: true, modelId: 'deepseek-v4-flash', markTask: false });
  });

  it('未标记 + 普通聊天 ⇒ 完全不介入（一个字段都不写）', () => {
    expect(planDeckRouting({ sendMode: 'smart', task: {}, text: '帮我写一段周报', catalogModelIds: CATALOG })).toEqual({
      route: false,
      markTask: false,
    });
  });

  it('⭐ custom（用户显式选过模型）⇒ 永不覆盖、也不标记（哪怕任务已标记过）', () => {
    expect(
      planDeckRouting({
        sendMode: 'custom',
        task: { deckRouted: true },
        text: '帮我做一份PPT',
        catalogModelIds: CATALOG,
      }),
    ).toEqual({ route: false, markTask: false });
  });

  it('目录缺 deepseek ⇒ 不路由（原样放行），但任务照记"这是 deck 任务"——目录回来后的后续消息仍能粘上', () => {
    expect(
      planDeckRouting({ sendMode: 'smart', task: {}, text: '帮我做一份PPT', catalogModelIds: ['qwen3.7-flash'] }),
    ).toEqual({ route: false, markTask: true });
  });
});
