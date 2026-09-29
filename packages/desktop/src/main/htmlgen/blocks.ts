import type { HtmlgenFailure } from '@clawwork/shared';
import { parseHtmlgenRequest, type HtmlgenRequest } from './request.js';

/**
 * 从助手消息里取出 ```` ```htmlgen ```` 围栏块并校验。
 *
 * ## 为什么是**另一条**围栏，而不是给 `docgen` 加第五种 kind
 *
 * `docgen` 的四种 kind 共用一个 `sections`/`slides` 内容模型，出口是**文件**（要 Office 打开）。
 * 这条出口是**网页**：内容模型多出指标卡/表格/行动项/来源，排版交给浏览器。
 * 硬塞进 `DOCGEN_KINDS` 会让那个集合同时表示两件不相干的事，
 * 也会让"`docgen` 只支持四种格式"这句在文档、界面、测试里同时变成假话。
 *
 * ⚠️ 围栏语言必须**恰好**是 `htmlgen`（大小写不敏感）：`html`、`htmlgen.json` 之类都不算。
 *    尤其**不能**把 `html` 也算进来 —— 用户贴一段真网页源码时，
 *    他会期望那是代码产物，而不是"我们试图把它解析成结构化内容然后报错"。
 *
 * ⚠️ 与 `docgen/blocks.ts` 一样走**消息**而不是工作区文件：助手的工作目录与任务目录
 *    是兄弟目录，它写不过去（那条教训见 `docgen/blocks.ts` 的注释）。
 */

const FENCE_RE = /^```[ \t]*htmlgen[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gim;
const OPENING_FENCE_RE = /^```[ \t]*htmlgen[ \t]*$/gim;

export interface HtmlgenExtraction {
  requests: HtmlgenRequest[];
  /** 有 `htmlgen` 块但没通过校验的，带**结构化的原因**（要上屏）+ 英文细节（进日志）。 */
  failures: { failure: HtmlgenFailure; detail: string }[];
}

export function extractHtmlgenBlocks(content: string): HtmlgenExtraction {
  const requests: HtmlgenRequest[] = [];
  const failures: { failure: HtmlgenFailure; detail: string }[] = [];
  if (!content) return { requests, failures };

  // ⚠️ 每次调用都要重置 lastIndex：正则带 `g` 且是模块级常量，跨次调用会接着上次的位置找。
  FENCE_RE.lastIndex = 0;
  let closedBlocks = 0;
  for (const match of content.matchAll(FENCE_RE)) {
    closedBlocks += 1;
    const body = match[1] ?? '';
    let raw: unknown;
    try {
      raw = JSON.parse(body);
    } catch (error) {
      failures.push({
        failure: { code: 'htmlgen-block-invalid' },
        detail: `invalid JSON in htmlgen block: ${(error as Error).message}`,
      });
      continue;
    }
    const parsed = parseHtmlgenRequest(raw);
    if (!parsed.ok) {
      failures.push({ failure: parsed.failure, detail: parsed.detail });
      continue;
    }
    requests.push(parsed.request);
  }

  OPENING_FENCE_RE.lastIndex = 0;
  const openings = [...content.matchAll(OPENING_FENCE_RE)].length;
  for (let extra = closedBlocks; extra < openings; extra += 1) {
    failures.push({ failure: { code: 'htmlgen-block-invalid' }, detail: 'unclosed htmlgen block' });
  }

  return { requests, failures };
}
