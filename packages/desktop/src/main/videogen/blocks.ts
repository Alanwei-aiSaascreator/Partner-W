import type { VideogenFailure } from '@clawwork/shared';
import { parseVideogenRequest, type VideogenRequest } from './request.js';

/**
 * 从助手消息里取出 ```` ```videogen ```` 围栏块并校验。
 *
 * 与 `htmlgen/blocks.ts` 逐条同构（那条通道是"结构化内容 → 客户端排版"，这条是
 * "视频描述 → 客户端去远端生成"），三个决定也一样：
 *  · 围栏语言必须**恰好**是 `videogen`（大小写不敏感）—— `video`、`mp4` 之类都不算
 *    （用户贴一段真代码时不该被当成生成请求）；
 *  · 块坏了**不抛**：返回结构化 failure，调用方决定怎么上屏；
 *  · 没闭合的开栏也要报（截断的回复里 `videogen` 块可能只剩开头）。
 *
 * ⚠️ 与 docgen/htmlgen 同一个道理走**消息**而不是工作区文件：助手的工作目录与任务目录
 *    是兄弟目录，它写不过去。
 */

const FENCE_RE = /^```[ \t]*videogen[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gim;
const OPENING_FENCE_RE = /^```[ \t]*videogen[ \t]*$/gim;

export interface VideogenExtraction {
  requests: VideogenRequest[];
  /** 有 `videogen` 块但没通过校验的，带**结构化的原因**（要上屏）+ 英文细节（进日志）。 */
  failures: { failure: VideogenFailure; detail: string }[];
}

export function extractVideogenBlocks(content: string): VideogenExtraction {
  const requests: VideogenRequest[] = [];
  const failures: { failure: VideogenFailure; detail: string }[] = [];
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
        failure: { code: 'videogen-block-invalid' },
        detail: `invalid JSON in videogen block: ${(error as Error).message}`,
      });
      continue;
    }
    const parsed = parseVideogenRequest(raw);
    if (!parsed.ok) {
      failures.push({ failure: parsed.failure, detail: parsed.detail });
      continue;
    }
    requests.push(parsed.request);
  }

  OPENING_FENCE_RE.lastIndex = 0;
  const openings = [...content.matchAll(OPENING_FENCE_RE)].length;
  for (let extra = closedBlocks; extra < openings; extra += 1) {
    failures.push({ failure: { code: 'videogen-block-invalid' }, detail: 'unclosed videogen block' });
  }

  return { requests, failures };
}
