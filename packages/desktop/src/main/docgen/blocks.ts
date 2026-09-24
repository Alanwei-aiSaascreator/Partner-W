import { parseDocgenRequest, type DocgenRequest } from './request.js';

/**
 * 从助手消息里取出 ```` ```docgen ```` 围栏块并校验。
 *
 * ## 为什么走"消息"而不是"文件"
 *
 * 原本的设计是让助手把请求写成工作区里的一个文件、客户端扫目录。**做不到**：
 * 助手的沙箱限在它自己的工作区（`<root>/rongying-agents/<agentId>`），
 * 而客户端的产物通道要的是任务目录（`<root>/<taskId>`）—— 两者是**兄弟目录**，
 * 助手写不过去（同事那条 `exec 列出桌面…` 失败就是同一个沙箱边界的另一面）。
 * 而且"助手的工作目录到底是哪个"是**没验证过的运行时事实**，
 * 不该把整条链建在它上面。
 *
 * 消息是**已经验证过**的通道：客户端的产物链本来就从消息里抽东西
 * （`artifact/extract.ts` 抽代码块与图片）。这里沿用同一条路。
 *
 * ⚠️ 围栏语言必须**恰好**是 `docgen`（大小写不敏感）：`json`、`docgen.json` 之类
 *    都不算 —— 否则用户贴一段普通 JSON 就可能意外触发文件生成。
 */

const FENCE_RE = /^```[ \t]*docgen[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gim;

export interface DocgenExtraction {
  requests: DocgenRequest[];
  /** 有 `docgen` 块但没通过校验的，带原因（给日志；不上屏，避免把 JSON 报错糊到用户脸上）。 */
  errors: string[];
}

export function extractDocgenBlocks(content: string): DocgenExtraction {
  const requests: DocgenRequest[] = [];
  const errors: string[] = [];
  if (!content) return { requests, errors };

  // ⚠️ 每次调用都要重置 lastIndex：正则带 `g` 且是模块级常量，跨次调用会接着上次的位置找。
  FENCE_RE.lastIndex = 0;
  for (const match of content.matchAll(FENCE_RE)) {
    const body = match[1] ?? '';
    let raw: unknown;
    try {
      raw = JSON.parse(body);
    } catch (error) {
      errors.push(`invalid JSON in docgen block: ${(error as Error).message}`);
      continue;
    }
    const parsed = parseDocgenRequest(raw);
    if (!parsed.ok) {
      errors.push(parsed.error);
      continue;
    }
    requests.push(parsed.request);
  }

  return { requests, errors };
}
