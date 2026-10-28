/**
 * Deck 意图路由 —— "这条消息是在要一份 PPT / 演示文稿吗"的唯一判据，以及"这轮该钉哪个模型"。
 *
 * ## 为什么需要它（产品拍板，2026-10-08）
 *
 * 真机实证：PPT 生成/改稿链在 `qwen3.7-flash` 上 20 分钟修稿循环不收敛；同一任务换成
 * DeepSeek 后 2.6 分钟出 9 页合格成品（改稿链同样是"一次单点 edit 即过"）。瓶颈在
 * **输出稳定性**，不在速度档 —— 所以三条档（快速/智能/深度）**都**把演示类任务内部
 * 路由到 DeepSeek，模式芯片照旧显示用户选的那一档（这是内部路由，不是用户可见的模式）。
 *
 * ## 判据：`@clawwork/shared` 的 `isDeckWorkRequest`（唯一真源，2026-10-09 起）
 *
 * = 制作 ∨ 改稿 ∨ "再来一份全新的"（词表与主进程 `reroutePptxToSlidegen` 硬门共用）。
 * ⚠️ **判错方向的代价不对称**：漏判 = 演示任务仍发给 qwen（就是要治的那个病）；
 *    误判 = 一句聊天发给 DeepSeek（无害，且这种任务随后多半真的在做 PPT）。
 *    所以不堆负向守卫（"怎么/如何"之类），保持规则短、可预测。
 *
 * ⚠️ 2026-10-09（H2 收紧）：改稿族的**省略形态**（裸「美化 / 重新排版 / 调整字号」）
 *    只在**已有 deck 上下文**（任务粘性 `deckRouted`）时命中 —— 没有上下文时它不是
 *    "要一份演示文稿"的证据（真机 probe：「美化这个网页」曾把新任务误标 deck 路由，
 *    后续所有消息被钉到 DeepSeek）。带演示名词的形态（「美化这个 PPT」）不受影响。
 *
 * ⚠️ 只吃**用户自己手打的字**（发送路径里的 `content`），不吃被 @ 的文件正文 /
 *    附件名 —— 一份叫「培训课件.pdf」的附件不代表这一轮要"做课件"（与
 *    `attachment-actions.ts` 的 edit 判据同一条纪律）。
 */

import { isDeckWorkRequest, modelIdMatches, type TaskModeSetting } from '@clawwork/shared';

/**
 * Deck 任务统一路由到的模型。**写本体、不写前缀** —— 目录里的 id 才是真身，
 * 解析结果原样当 `presetModel`（与 `resolveModeModelId` 同一把尺，见 task-modes.ts）。
 *
 * 2026-10-10 Cephalon 批：迁到**新平台渠道** `deepseek-v4-flash-cephalon`
 * （旧 `deepseek-v4-flash` 在中转目录里可能并存为可选）；旧渠道还在目录里时
 * **不悄悄回退旧渠道** —— 目录里没有新 ID ⇒ `undefined` ⇒ 不路由、不拦截，照原模型发。
 */
export const DECK_ROUTE_MODEL_ID = 'deepseek-v4-flash-cephalon';

/**
 * 这条文本是不是"要一份演示文稿"？（纯函数，单独钉）
 *
 * ⚠️ 2026-10-09 起判据的**唯一真源在 `@clawwork/shared`**（`isDeckWorkRequest` =
 *    制作 ∨ 改稿 ∨ "再来一份全新的"）：主进程的 `reroutePptxToSlidegen` 硬门用**同一个**
 *    出口 —— 此前两边各写一份词表，首次制作（"把材料做成一份 PPT"）与首次改稿
 *    （"美化这个 PPT"）各漏一个方向（见 shared 模块头注释）。空串/空白一律 false。
 *
 * @param hasDeckContext **可信**上下文（任务已标 deck 路由 / 受控链有上一版收据）——
 *   改稿族的省略形态（裸「美化 / 重新排版」）只在有上下文时命中：裸"美化"是普通
 *   动词（网页/Word/Excel 都能美化），无上下文时不是"要一份演示文稿"的证据
 *   （2026-10-09 H2 修复：此前「美化这个网页」会把新任务误标成 deck 路由）。
 */
export function looksLikeDeckRequest(text: string, hasDeckContext = false): boolean {
  return isDeckWorkRequest(text, hasDeckContext);
}

/**
 * 对着**目录**解析 deck 路由该用的模型 id；解析不出来返回 `undefined`。
 *
 * 与 `resolveModeModelId` 同一个契约：返回目录里真实存在的那个 id（可能是
 * `clawrouter/deepseek-v4-flash` 这种带命名空间的写法），调用方拿它直接当
 * `presetModel`；`undefined` ⇒ **保持现状、不拦截**。
 */
export function resolveDeckModelId(catalogModelIds: readonly string[]): string | undefined {
  return catalogModelIds.find((id) => modelIdMatches(id, DECK_ROUTE_MODEL_ID));
}

export interface DeckRoutePlan {
  /** 这一轮是否按 deck 路由（false ⇒ 调用方原样放行，不碰模型）。 */
  route: boolean;
  /** `route` 为真时 = 目录里解析到的真实模型 id。 */
  modelId?: string;
  /**
   * 是否是"本条消息首次命中"——调用方据此把**任务**标记为 deck 路由（粘性）：
   * 后续消息（含"把标题改一下"这类不含演示名词的改稿）继续走 DeepSeek，
   * 直到用户显式切 custom（那时 `sendMode === 'custom'`，本函数整体不介入）。
   */
  markTask: boolean;
}

/**
 * 组装这一轮的 deck 路由决定（纯函数，接线只做三件事：`route` ⇒ 改 `presetModel`；
 * `markTask` ⇒ `updateTaskMetadata`；都不动 ⇒ 原行为）。
 *
 * | 输入 | route | markTask |
 * |---|---|---|
 * | `custom`（用户显式选过模型） | false | false（**永不被覆盖**） |
 * | 任务已标记（粘性） | 目录有 deepseek 才 true | false（不重复写） |
 * | 本条命中、任务未标记 | 同上 | true |
 * | 本条没命中、任务也没标记 | false | false |
 *
 * ⚠️ `markTask` 与 `route` **故意解耦**：目录暂时没有 deepseek（冷启动还没拉到、
 *    或将来下架）时也要把"这是 deck 任务"记下来 —— 这样等目录回来后，同一任务
 *    的后续消息（哪怕只是"把标题改一下"）仍能粘上。目录永远没有它的话，
 *    `route` 始终 false，等于什么都没发生。
 *
 * ⚠️ 2026-10-09（H2 收紧）：`hasDeckContext` **只取任务粘性**这一条可信证据 ——
 *    无粘性时裸「美化 / 重新排版」不算命中（「美化这个网页」不许把新任务标成
 *    deck 路由）；粘性任务本来就继续路由，`hit` 在这里只影响 `markTask`
 *   （`!sticky && hit` ⇒ 粘性恒 false，不会重复标记）。裸文本不许自证上下文。
 */
export function planDeckRouting(args: {
  sendMode: TaskModeSetting;
  task: { deckRouted?: boolean } | undefined | null;
  text: string;
  catalogModelIds: readonly string[];
}): DeckRoutePlan {
  const { sendMode, task, text, catalogModelIds } = args;
  if (sendMode === 'custom') return { route: false, markTask: false };

  const sticky = task?.deckRouted === true;
  const hit = looksLikeDeckRequest(text, sticky);
  if (!sticky && !hit) return { route: false, markTask: false };

  const modelId = resolveDeckModelId(catalogModelIds);
  return { route: modelId !== undefined, modelId, markTask: !sticky && hit };
}
