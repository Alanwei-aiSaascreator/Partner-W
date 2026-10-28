import { parseDocgenRequest, type DocgenRequest } from './request.js';

/**
 * 从助手消息里取出 ```` ```docgen ```` 围栏块并校验。
 *
 * ## 为什么走"消息"而不是"文件"
 *
 * 原本的设计是让助手把请求写成工作区里的一个文件、客户端扫目录。**做不到**：
 * 助手的沙箱限在它自己的工作区（`<root>/partner-w-agents/<agentId>`），
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
const OPENING_FENCE_RE = /^```[ \t]*docgen[ \t]*$/gim;

const JSON_STRING_END_FOLLOWERS = new Set([':', ',', '}', ']']);

function nextNonWhitespace(source: string, start: number): string | undefined {
  for (let index = start; index < source.length; index += 1) {
    if (!/\s/.test(source[index] ?? '')) return source[index];
  }
  return undefined;
}

/**
 * 只修复模型最常见的一种 JSON 失误：字符串正文里未转义的 `"`。
 *
 * 不用 eval，不改结构字符，也不猜缺失的逗号/括号。一个引号只有在字符串内，
 * 且其后下一个非空白字符不是合法的字符串结束后继（`: , } ]` / EOF）时，
 * 才补一个反斜杠。修复结果还要再过 `JSON.parse` 和 `parseDocgenRequest`。
 */
function repairBareQuotesInJsonStrings(source: string): string | null {
  let insideString = false;
  let escaped = false;
  let repairs = 0;
  let repairsInCurrentString = 0;
  let repaired = '';

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] ?? '';
    if (!insideString) {
      repaired += char;
      if (char === '"') {
        insideString = true;
        repairsInCurrentString = 0;
      }
      continue;
    }

    if (escaped) {
      repaired += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      repaired += char;
      escaped = true;
      continue;
    }
    if (char !== '"') {
      repaired += char;
      continue;
    }

    const follower = nextNonWhitespace(source, index + 1);
    if (
      follower === undefined ||
      JSON_STRING_END_FOLLOWERS.has(follower) ||
      // `"a" "b"` 是两个相邻字符串缺逗号，不是正文引号。只有当前字符串前面
      // 已经出现过明确的裸引号，`...""` 才可能是「正文右引号 + JSON 结束引号」。
      (follower === '"' && repairsInCurrentString === 0)
    ) {
      repaired += char;
      insideString = false;
    } else {
      repaired += '\\"';
      repairs += 1;
      repairsInCurrentString += 1;
    }
  }

  if (insideString || escaped || repairs === 0) return null;
  return repaired;
}

/**
 * 只修复另一种有明确边界的模型笔误：属性值漏了**开**引号，但仍留下了闭引号。
 *
 * 真机样例：`"title": 🤖 我是谁？",`。这不是放宽成 JSON5：只接受“一整行、
 * 已加引号的属性名、无任何 JSON 结构字符的纯文本值、明确的闭引号”这个形状；
 * 不补逗号/括号，不执行代码，最多修 8 行，结果仍必须通过 JSON.parse 与完整 schema。
 */
function repairMissingOpeningQuotesForStringValues(source: string): string | null {
  let repairs = 0;
  const repaired = source
    .split(/(\r?\n)/)
    .map((line) => {
      if (line === '\n' || line === '\r\n') return line;
      const match = line.match(/^(\s*"(?:\\.|[^"\\])+"\s*:\s*)([^"\s{}[\],:\\][^"{}[\],:\\\r\n]*)"(\s*,?\s*)$/);
      if (!match) return line;
      const value = (match[2] ?? '').trim();
      if (!value || /^(?:true|false|null|-?\d+(?:\.\d+)?)$/i.test(value)) return line;
      repairs += 1;
      return `${match[1]}"${match[2]}"${match[3]}`;
    })
    .join('');

  return repairs > 0 && repairs <= 8 ? repaired : null;
}

function parseJsonWithNarrowRepairs(source: string): unknown {
  try {
    return JSON.parse(source);
  } catch (initialError) {
    const bareQuotes = repairBareQuotesInJsonStrings(source);
    const candidates = [
      bareQuotes,
      repairMissingOpeningQuotesForStringValues(source),
      bareQuotes === null ? null : repairMissingOpeningQuotesForStringValues(bareQuotes),
    ].filter((candidate): candidate is string => candidate !== null);

    for (const candidate of new Set(candidates)) {
      try {
        return JSON.parse(candidate);
      } catch {
        // Try the next narrowly-scoped repair candidate.
      }
    }
    throw initialError;
  }
}

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
  let closedBlocks = 0;
  for (const match of content.matchAll(FENCE_RE)) {
    closedBlocks += 1;
    const body = match[1] ?? '';
    let raw: unknown;
    try {
      raw = parseJsonWithNarrowRepairs(body);
    } catch (initialError) {
      errors.push(`invalid JSON in docgen block: ${(initialError as Error).message}`);
      continue;
    }
    const parsed = parseDocgenRequest(raw);
    if (!parsed.ok) {
      errors.push(parsed.error);
      continue;
    }
    requests.push(parsed.request);
  }

  OPENING_FENCE_RE.lastIndex = 0;
  const openings = [...content.matchAll(OPENING_FENCE_RE)].length;
  for (let extra = closedBlocks; extra < openings; extra += 1) {
    errors.push('unclosed docgen block');
  }

  return { requests, errors };
}
