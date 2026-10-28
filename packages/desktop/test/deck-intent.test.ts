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

/**
 * ⭐ 2026-10-09（H2 修复 · 复现自只读探针 `reviews/e5024996-deck-probe.txt`）：
 * **非 PPT 改稿不许把新任务标成 deck 路由**。
 *
 * 改稿族里的**省略形态**（无演示名词的「美化 / 重新排版 / 调整…字号」）此前在
 * **首条消息**上直接命中 ⇒ 任务被误标 `deckRouted`（粘性）⇒ 后续所有消息被钉到
 * DeepSeek。词表保留给"已有 deck 上下文"：无上下文时，裸"美化"只是普通动词
 *（网页/Word/Excel 都能"美化"），不是"要一份演示文稿"的证据。
 */
describe('⭐ H2：非 PPT 改稿误路由（只读探针三条负例 ⇒ 无上下文不命中）', () => {
  // 2026-10-10 Cephalon 批：目录里**新旧两条 DeepSeek 渠道并存**（旧 deepseek-v4-flash
  // 保留可选、新 deepseek-v4-flash-cephalon 是默认路由目标）—— 路由必须精确命中新 ID。
  const CATALOG = ['glm-5.3-flash', 'deepseek-v4-flash-cephalon', 'deepseek-v4-flash'];

  it.each(['美化这个网页', '帮我重新排版这份 Word 文档', '调整 Excel 的字号'])('不命中、不标记、不路由：%s', (text) => {
    expect(looksLikeDeckRequest(text)).toBe(false);
    expect(planDeckRouting({ sendMode: 'smart', task: {}, text, catalogModelIds: CATALOG })).toEqual({
      route: false,
      markTask: false,
    });
  });

  it('⭐ 有可信上下文（任务已粘性）⇒ 省略形态照旧是 deck 改稿（继续路由、不重复标记）', () => {
    expect(looksLikeDeckRequest('第一版不好看，重新排版', true)).toBe(true);
    expect(
      planDeckRouting({
        sendMode: 'smart',
        task: { deckRouted: true },
        text: '第一版不好看，重新排版',
        catalogModelIds: CATALOG,
      }),
    ).toEqual({ route: true, modelId: 'deepseek-v4-flash-cephalon', markTask: false });
  });

  it('对照面：带演示名词的改稿不受影响（「美化这个 PPT」首条即命中）', () => {
    expect(looksLikeDeckRequest('美化这个 PPT', false)).toBe(true);
    expect(planDeckRouting({ sendMode: 'smart', task: {}, text: '美化这个 PPT', catalogModelIds: CATALOG })).toEqual({
      route: true,
      modelId: 'deepseek-v4-flash-cephalon',
      markTask: true,
    });
  });
});

describe('resolveDeckModelId —— 对着目录解析真实 id', () => {
  it('默认目标就是新 Cephalon 平台 ID（deepseek-v4-flash-cephalon）', () => {
    expect(DECK_ROUTE_MODEL_ID).toBe('deepseek-v4-flash-cephalon');
    expect(resolveDeckModelId(['deepseek-v4-flash-cephalon'])).toBe('deepseek-v4-flash-cephalon');
  });

  it('⭐ 新旧两条 DeepSeek 渠道并存 ⇒ 精确命中新渠道，不误选旧同名渠道（目录顺序无关）', () => {
    expect(resolveDeckModelId(['deepseek-v4-flash', 'deepseek-v4-flash-cephalon'])).toBe('deepseek-v4-flash-cephalon');
    expect(resolveDeckModelId(['deepseek-v4-flash-cephalon', 'deepseek-v4-flash'])).toBe('deepseek-v4-flash-cephalon');
  });

  it('按末段比对：目录里带命名空间的写法命中，且返回**目录里的原样 id**（与 resolveModeModelId 同一把尺）', () => {
    expect(resolveDeckModelId(['clawrouter/glm-5.3-flash', 'clawrouter/deepseek-v4-flash-cephalon'])).toBe(
      'clawrouter/deepseek-v4-flash-cephalon',
    );
  });

  it('只有旧渠道（deepseek-v4-flash）⇒ 不命中、原样放行（默认路由已迁到新 ID，不悄悄回退旧渠道）', () => {
    expect(resolveDeckModelId(['glm-5.3-flash', 'deepseek-v4-flash'])).toBeUndefined();
    expect(resolveDeckModelId([])).toBeUndefined();
  });

  it('不误命中同家族的其它型号（deepseek-v4-pro 不算）', () => {
    expect(resolveDeckModelId(['clawrouter/deepseek-v4-pro'])).toBeUndefined();
  });
});

describe('planDeckRouting —— 粘性标记与 custom 豁免', () => {
  const CATALOG = ['glm-5.3-flash', 'deepseek-v4-flash-cephalon', 'deepseek-v4-flash'];

  it('模式任务 + 本条首次命中 ⇒ 路由 + 标记任务', () => {
    expect(planDeckRouting({ sendMode: 'smart', task: {}, text: '帮我做一份PPT', catalogModelIds: CATALOG })).toEqual({
      route: true,
      modelId: 'deepseek-v4-flash-cephalon',
      markTask: true,
    });
  });

  it('⭐ 粘性：已标记的任务 + 不含演示名词的后续消息（改稿"把标题改一下"）⇒ 仍走新渠道、不重复标记', () => {
    expect(
      planDeckRouting({
        sendMode: 'smart',
        task: { deckRouted: true },
        text: '把标题改一下',
        catalogModelIds: CATALOG,
      }),
    ).toEqual({ route: true, modelId: 'deepseek-v4-flash-cephalon', markTask: false });
  });

  it('未标记 + 普通聊天 ⇒ 完全不介入（一个字段都不写）', () => {
    expect(planDeckRouting({ sendMode: 'smart', task: {}, text: '帮我写一段周报', catalogModelIds: CATALOG })).toEqual({
      route: false,
      markTask: false,
    });
  });

  it('⭐ custom（用户显式选过模型）⇒ 永不覆盖、也不标记（哪怕任务已标记过；含显式选旧 DeepSeek）', () => {
    expect(
      planDeckRouting({
        sendMode: 'custom',
        task: { deckRouted: true },
        text: '帮我做一份PPT',
        catalogModelIds: CATALOG,
      }),
    ).toEqual({ route: false, markTask: false });
  });

  it('目录缺新渠道 ⇒ 不路由（原样放行），但任务照记"这是 deck 任务"——目录回来后的后续消息仍能粘上', () => {
    expect(
      planDeckRouting({ sendMode: 'smart', task: {}, text: '帮我做一份PPT', catalogModelIds: ['glm-5.3-flash'] }),
    ).toEqual({ route: false, markTask: true });
  });
});
