/**
 * **一份演示文稿没生成出来**的形状（助手在回复里写了 ```` ```slidegen ```` 块，
 * 但客户端没能把它排成 `.pptx`）。
 *
 * ## 这条通道是什么
 *
 * 与 `docgen` / `htmlgen` 的根本差别：**这次让模型写版面本身**。
 *
 * `docgen` 的模板把版式**固化成了 pptx 形状**，于是每个占位符都有字符上限，
 * 内容一多就整份被拒 —— 真机上出现过「让助手把第二页缩短 40 字，结果**一个文件都没生成**」。
 * 那条路的表达力天花板是设计出来的，而"内容能不能写满"恰恰是用户最在意的事。
 *
 * 这条通道换成对标产品的做法：**用 JSX + CSS（flex / 绝对定位 / 渐变）描述版面**，
 * 客户端拿真浏览器（Electron）排版、量出每个元素的最终矩形，
 * 再写回成一页**真文字、可编辑**的 pptx。
 * 模型写它最擅长的 CSS，而不是去凑一套固定格子的字段名。
 *
 * ⚠️ 与 `docgen-failure.ts` / `htmlgen-failure.ts` 同一个道理：定义在 shared 是**故意的** ——
 *    这个形状要跨 主进程 → IPC → 渲染层 三道边界，每层各写一遍必然漂移。
 * ⚠️ 这里只放**码 + 数据**，不放句子：文案在界面那一侧本地化（九种语言各一份）。
 */

/**
 * 一栅最多几页。
 *
 * 不是安全限制，是**成本**限制：每页都要起一次浏览器渲染 + 量框，
 * 一栅几百页会让消息收尾路径卡住（那正是本项目已经踩过的"收尾链拖垮界面"）。
 */
export const SLIDEGEN_MAX_PAGES = 60;

/**
 * 没生成出来的原因。**判别联合**，不是"码 + 一堆可选字段" ——
 * 理由与 `DocgenFailure` 逐条相同（不带假默认值、穷尽性可查）。
 *
 * ⚠️ **注意这里没有"内容太长"这一档**，是刻意的：这条通道**不因为内容多而拒绝**。
 *    版式有问题（越界、被盖住）走的是**警告**，文件照样出（见 `main/slidegen/validate.ts`）。
 *    要恢复这个档位之前，先回去读 `docgen` 那段历史 —— 那是个已经踩过的坑。
 */
export type SlidegenFailure =
  /** 围栏里是空的。 */
  | { code: 'slidegen-block-empty' }
  /**
   * 围栏**开了头没有结尾** —— 几乎总是"助手的回复被截断了"。
   *
   * ⚠️ 这一档是 2026-09-28 真机补上的，而且它防的正是**静默**：`FENCE_RE` 只认闭合的围栏，
   *    所以被截断的那一份既不进 `decks` 也不进 `failures` ⇒ 上层两个分支都不进、直接 return
   *    ⇒ 用户看到"任务已完成、结果已保存"，产物面板却是空的，且**日志里一条都没有**。
   */
  | { code: 'slidegen-block-unclosed' }
  /** 没有 `// title: …`。标题是文件名，缺了就只能编一个，而用户认不出编出来的名字。 */
  | { code: 'slidegen-title-missing' }
  /** JSX 结构不成立（标签不配平、属性没值…）。 */
  | { code: 'slidegen-unparsable' }
  /** 用了四个标签之外的标签（含 HTML 标签）。这是个**封闭集合**，不是"尽量兼容"。 */
  | { code: 'slidegen-unknown-tag'; tag: string }
  /** 求值失败（表达式抛错、超时）。`detail` 里有原始信息，只进日志、不上屏。 */
  | { code: 'slidegen-eval-failed' }
  /** 页数超了 `SLIDEGEN_MAX_PAGES`。 */
  | { code: 'slidegen-too-many-pages'; max: number; got: number }
  /** 渲染或写出阶段失败（浏览器起不来、写盘失败…）。我们自己的意外，不假装知道原因。 */
  | { code: 'slidegen-render-failed' };

/**
 * 版式**警告**（文件出来了，但某几处不对）。
 *
 * ⭐ 与 `SlidegenFailure` 分开是这一条通道的核心设计：**警告不挡交付**。
 *    对标产品那份 deck 里就有一处重叠，它照样出了成品 ——
 *    "版式有点毛病"和"什么都没生成"是两种完全不同的坏。
 */
export type SlidegenWarning =
  /** 元素冲出画布 ⇒ 放映时那一块看不到。 */
  | { code: 'layout-out-of-bounds'; page: number; element: number; detail: string }
  /** 文字被别的元素盖住 ⇒ 用户看不到那句话，还不知道它存在。 */
  | { code: 'layout-text-occluded'; page: number; element: number; detail: string };
