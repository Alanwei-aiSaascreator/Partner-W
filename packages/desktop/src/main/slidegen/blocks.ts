import type { SlidegenFailure } from '@clawwork/shared';
import { SlideDslError, transformSlideJsx } from './dsl.js';

/**
 * 从助手消息里取出 ```` ```slidegen ```` 围栏块。
 *
 * ## 里面装的是什么
 *
 * **`.slide` DSL 原文**（JSX 子集），不是 JSON —— 与 `docgen` / `htmlgen` 的关键差别。
 * 那两条通道的内容模型是"结构化数据 + 客户端模板"；这条是"**模型直接写版面**"。
 *
 * 为什么这次允许模型写版面：`docgen` 的模板把版式**固化成了形状**，
 * 于是每格都有字符上限、内容一多就整份被拒（真机上出现过"让助手缩短 40 字，
 * 结果一个文件都没生成"）。那条路的表达力天花板是设计出来的，
 * 而"内容能不能写满"是用户真正在意的事。
 *
 * ## 一个围栏 = 一整份 deck
 *
 * 多个 `<Slide>` 并列即成多页，标题写在开头的 `// title: …` 注释里：
 *
 * ```text
 * // title: 九月经营简报
 * <Slide style={{ width: 1280, height: 720 }}>…</Slide>
 * <Slide style={{ width: 1280, height: 720 }}>…</Slide>
 * ```
 *
 * ⚠️ 围栏语言必须**恰好**是 `slidegen`。`jsx`、`slide`、`slidep` 都不算 ——
 *    用户贴一段 React 代码时，他期望那是代码产物，不是"我们试图当版面解析然后报错"。
 */

const FENCE_RE = /^```[ \t]*slidegen[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gim;

/** 标题声明：`// title: xxx`（行首注释）。 */
const TITLE_RE = /^[ \t]*\/\/[ \t]*title[ \t]*[:：][ \t]*(.+?)[ \t]*$/im;

export interface SlidegenDeck {
  title: string;
  source: string;
}

export interface SlidegenExtraction {
  decks: SlidegenDeck[];
  failures: { failure: SlidegenFailure; detail: string }[];
}

export function extractSlidegenBlocks(content: string): SlidegenExtraction {
  const decks: SlidegenDeck[] = [];
  const failures: { failure: SlidegenFailure; detail: string }[] = [];
  if (!content) return { decks, failures };

  // ⚠️ 每次调用都要重置 lastIndex：正则带 `g` 且是模块级常量，跨次调用会接着上次的位置找。
  FENCE_RE.lastIndex = 0;
  for (const match of content.matchAll(FENCE_RE)) {
    const body = (match[1] ?? '').trim();
    if (!body) {
      failures.push({ failure: { code: 'slidegen-block-empty' }, detail: 'empty slidegen block' });
      continue;
    }
    const title = TITLE_RE.exec(body)?.[1]?.trim();
    if (!title) {
      // 标题是**文件名**。没有它就只能编一个，而编出来的名字用户认不出是哪个文件。
      failures.push({
        failure: { code: 'slidegen-title-missing' },
        detail: 'slidegen block has no `// title: …` line',
      });
      continue;
    }
    // 语法层能当场判的先判掉 —— 让失败码精确到"这个标签不认"，
    // 而不是等到渲染阶段报一句泛泛的失败。
    try {
      transformSlideJsx(body);
    } catch (error) {
      const detail = error instanceof SlideDslError ? `${error.code}: ${error.message}` : String(error);
      // ⚠️ 判别联合**不能**写成 `{ code: cond ? 'a' : 'b' }` —— TS 不会把它收窄成
      //    联合的某一支（`slidegen-unknown-tag` 还要求 `tag` 字段）。分成两支写。
      failures.push({
        failure:
          error instanceof SlideDslError && error.code === 'dsl-unknown-tag'
            ? { code: 'slidegen-unknown-tag', tag: error.message.replace(/^unknown tag <|>$/g, '') }
            : {
                code: 'slidegen-unparsable',
                ...(error instanceof SlideDslError
                  ? { diagnostic: { code: error.code, offset: error.offset, detail: error.message } }
                  : {}),
              },
        detail,
      });
      continue;
    }
    decks.push({ title, source: body });
  }

  // ⚠️ `FENCE_RE` 只认**闭合**的围栏 —— 被截断的那一份既不进 decks 也不进 failures，
  //    上层两个分支都不进、**直接 return**。真机 2026-09-28 就是这么静默丢掉了一整份演示
  //    （助手消息 8,220 字符、有开头没结尾、末尾是 `...(truncated)...`，
  //     而日志里连一条 `slidegen.*` 都没有）。
  //    ⇒ 单独数一次**开头**：开头比"配成对的"多，就是被截断了。
  const openings = (content.match(/^```[ \t]*slidegen[ \t]*$/gim) ?? []).length;
  for (let extra = decks.length + failures.length; extra < openings; extra++) {
    failures.push({
      failure: { code: 'slidegen-block-unclosed' },
      detail: 'a slidegen fence is opened and never closed (the reply was truncated)',
    });
  }

  return { decks, failures };
}
