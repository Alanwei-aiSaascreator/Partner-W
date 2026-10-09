/**
 * 「这是不是一次演示文稿（PPT/deck）任务」的**唯一判据** —— 渲染层路由与主进程硬门共用。
 *
 * ## 为什么必须只有一个判据（2026-10-09 只读复审 · P1 ×2）
 *
 * 同一条用户消息此前在**两个进程里各算各的**：渲染层用「制作动词 ∧ 演示名词」决定
 * 把这一轮钉到 DeepSeek（`planDeckRouting`），主进程另用一套只认「另做/新的/改稿」
 * 的正则决定 `reroutePptxToSlidegen`。两个词表不一致 ⇒ 两个可达的漏判：
 *
 *   · 「把材料做成一份 PPT / 做一份公司介绍 PPT / Generate a PPT」——
 *     渲染层命中、主进程不命中 ⇒ **首次制作**的演示路线硬门不生效；
 *   · 「美化这个 PPT / 调整 PPT 的排版 / 优化这份 PPT」（新任务首次改稿）——
 *     主进程口径命中、渲染层制作动词表不命中 ⇒ 不走 DeepSeek。
 *
 * ⇒ 词表统一搬到这里：两个进程只 import，不再各写一份（改一处、两处同时生效）。
 *
 * ## 判错的代价不对称（沿用渲染层原口径）
 *
 * 漏判 = 演示任务发给稳定性差的模型（真机实证：20 分钟修稿不收敛，就是要治的病）；
 * 误判 = 一句聊天钉到 DeepSeek（无害，且这类任务随后多半真在做 PPT）。
 * 所以规则保持短、可预测，不堆负向守卫（"怎么/如何"之类）。
 *
 * ⚠️ 只吃**用户自己手打的字**（发送路径里的 `content`），不吃被 @ 的文件正文 /
 *    附件名 —— 一份叫「培训课件.pdf」的附件不代表这一轮要"做课件"（与
 *    `attachment-actions.ts` 的 edit 判据同一条纪律）。
 *
 * ## 收紧（2026-10-09 · H2 修复：非 PPT 改稿误路由）
 *
 * 改稿族 `DECK_REVISE` 里有一批**省略形态**（不带演示名词的「美化 / 重新排版 /
 * 调整…字号」——它们服务"在已有 deck 的上下文里改稿"）。把它直接当成"本轮要一份
 * 演示文稿"的证据是错的：只读探针实证（`reviews/e5024996-deck-probe.txt`），新任务
 * 首条消息「美化这个网页」「帮我重新排版这份 Word 文档」「调整 Excel 的字号」
 * 全部命中 ⇒ 任务被误标 deck 路由（粘性），**后续所有消息**被钉到 DeepSeek。
 * 裸"美化"是普通动词（网页/Word/Excel 都能美化），不是演示意图。
 *
 * ⇒ 省略形态只在调用方手里**已有可信 deck 上下文**（任务已标 deck 路由 / 受控链
 *    有上一版收据）时才算命中；带演示名词的形态（「美化这个 PPT」）不受影响。
 *    上下文**不得**用本轮文本自证（"因为说了美化所以是 deck 任务"是循环论证）。
 */

/**
 * 演示名词（中文 + 英文；英文一律带 `\b`）。
 * `deckchair` / `decks` 这类词内片段不算（`slide`/`slides`/`slideshow(s)` 都算，
 * `ppt`/`pptx` 都算）。
 */
const DECK_NOUN = /(演示文稿|幻灯片|课件|\bppt(?:x)?\b|\bslide(?:s|show|shows)?\b|\bdeck\b)/i;

/**
 * 制作动词（中文）。`整理` 覆盖 `整理成/整理为`；`做` 覆盖 `做个/帮我做/做一份`；
 * `写` 覆盖 `编写/撰写/写一份` —— "帮我写个 PPT / 写一份演示文稿"是极常见说法，
 * 必须命中（名词门保证"写文档 / 写演讲稿 / 写邮件"照旧不算）。
 */
const DECK_CREATE_CN = /(做|制作|生成|整理|导出|输出|创建|转成|写)/;

/** 制作动词（英文；与英文名词混排的写法，大小写不敏感）。 */
const DECK_CREATE_EN =
  /\b(mak(?:e|es|ing)|creat(?:e|es|ing)|generat(?:e|es|ing)|build(?:s|ing)?|produc(?:e|es|ing)|export(?:s|ing)?|convert(?:s|ing)?|draft(?:s|ing)?|prepar(?:e|es|ing))\b/i;

/**
 * 改稿动词族（主进程原口径原样搬入 —— 它服务"已有 deck 的修改"这条链，
 * 部分形态**允许不带演示名词**：在 PPT 任务的上下文里「重新排版」「文字太挤」本身就是
 * 指向那份 deck 的修改请求；带上演示名词的形态同样命中）。
 *
 * ⚠️ 这条与主进程旧实现逐字等价（含 `文字.{0,16}(挤|字号)` 与 `(修改|调整|优化)+演示词/排版/字号`），
 *    不在这里"顺手改进"——它同时是受控 native 链的收据判定输入。
 *
 * ⚠️ 它本身**不是**"本轮是不是 deck 工作"的完整判据：省略形态（不带演示名词）要
 *    经过 `isDeckWorkRequest` 的 `hasDeckContext` 把关（见模块头「收紧」节）。
 */
const DECK_REVISE =
  /(?:改稿|美化|重新排版|(?:再|更)美观|文字.{0,16}(?:挤|字号)|(?:修改|调整|优化).{0,12}(?:PPT|幻灯片|演示文稿|排版|字号)|(?:revise|restyle|redesign).{0,24}(?:ppt|slides?|deck))/i;

/**
 * "再来一份**全新**的"（主进程原 `newDeckIntent` 口径，逐字搬入）。
 *
 * ⚠️ 它与上面两族**用途不同**：在受控 native 链里它决定"这一轮是否抛弃上一份收据
 *    （开启一份新 deck，而不是改上一份）"。所以它是窄口径、「另/新的 + 演示词」，
 *    不要把"任何制作动词"并进来。
 */
const DECK_FRESH = /(?:另.{0,8}(?:PPT|幻灯片|演示文稿)|新的.{0,8}PPT|(?:new|another).{0,16}(?:ppt|deck|presentation))/i;

function nonEmptyText(text: unknown): text is string {
  return typeof text === 'string' && text.trim() !== '';
}

/** 制作请求（制作动词 ∧ 演示名词）——空串/空白一律 false。 */
export function isDeckCreateRequest(text: string): boolean {
  if (!nonEmptyText(text)) return false;
  if (!DECK_CREATE_CN.test(text) && !DECK_CREATE_EN.test(text)) return false;
  return DECK_NOUN.test(text);
}

/** 改稿请求（改稿动词族；部分形态允许不带演示名词，见 `DECK_REVISE` 注释）。 */
export function isDeckRevisionRequest(text: string): boolean {
  if (!nonEmptyText(text)) return false;
  return DECK_REVISE.test(text);
}

/** "再来一份全新的"（专供受控 native 链的收据语义；窄口径）。 */
export function isFreshDeckRequest(text: string): boolean {
  if (!nonEmptyText(text)) return false;
  return DECK_FRESH.test(text);
}

/**
 * 这一轮是不是 deck 工作（三族取并）——**渲染层路由**与**主进程 `reroutePptxToSlidegen`
 * 硬门**的共同判据（2026-10-09 起只有这一个出口）。
 *
 * ⚠️ 2026-10-09（H2 收紧）：改稿族的**省略形态**（无演示名词的「美化 / 重新排版 /
 *    调整…字号」）只有 `hasDeckContext` 为真时才算命中（见模块头「收紧」节）；
 *    带演示名词的形态与制作族 / 全新的族不受影响。
 *
 * ⚠️ `DECK_NOUN` 是非 /g 正则（无 lastIndex 状态），这里的 `.test` 可安全重复调用。
 *
 * @param hasDeckContext 调用方手上的**可信**上下文：任务已标记 deck 路由（粘性）
 *   或受控链存在上一版收据。默认 false = 不假设上下文（新任务首条消息的场景）。
 */
export function isDeckWorkRequest(text: string, hasDeckContext = false): boolean {
  return (
    isDeckCreateRequest(text) ||
    isFreshDeckRequest(text) ||
    (isDeckRevisionRequest(text) && (hasDeckContext || DECK_NOUN.test(text)))
  );
}
