import type { KbChunkingOptions } from './types.js';

/**
 * 切片器（自研，几十行；**没有**引入 `@langchain/textsplitters` —— 那个包会带进
 * 一整套 langchain 依赖，而我们要的只是"按标题层级 + 段落切、带重叠"）。
 *
 * 策略（设计 §三）：
 * 1. 先按 markdown 标题（`#`–`######`）切成"小节"，每节记下**所属标题路径**；
 *    代码围栏里的 `#` 不算标题。
 * 2. 节内优先按**空行分段**；段落本身超过块大小时，再按句号/问号/分号切；句子仍超长
 *    就按字符硬切。切点永远落在这些边界上 —— 不会在词/句中间随手剪一刀。
 * 3. 贪心装箱到 `chunkSize`（默认 500 字），块与块之间带 `chunkOverlap`（默认 75 字，
 *    约 15%）重叠：下一块的开头**复用上一块的结尾**（`overlapChars` 如实记录重叠了多少）。
 * 4. 收尾块太短（< `minChunkSize`）就并回上一块（丢掉那点重叠，正文不重复、也不丢字）。
 * 5. 每块的最终文本 = `【所属：一级 › 二级】\n` + 正文 —— 标题路径进了正文，所以它
 *    一样被 FTS 索引到、一样参与嵌入（问"预算那章说了什么"能命中该章每一块）。
 */

export const DEFAULT_CHUNK_SIZE = 500;
export const DEFAULT_CHUNK_OVERLAP = 75;
export const DEFAULT_MIN_CHUNK_SIZE = 80;

/** 标题路径前缀（设计 §三的"所属：第三章 › 预算"）。 */
export const HEADING_PREFIX_LABEL = '所属';

export interface TextChunk {
  /** 在整份资料内的序号，从 0 开始、连续。 */
  ordinal: number;
  /** 不含标题前缀的正文（可能带上与上一块重叠的头部）。 */
  body: string;
  /** 正文开头有多少字符是从上一块重叠过来的（第一块恒为 0）。 */
  overlapChars: number;
  /** 所属标题路径；纯文本（无标题）时是空数组。 */
  headingPath: string[];
  /** 落库 / 送模型 / 建索引的最终文本（前缀 + 正文）。 */
  text: string;
}

interface Section {
  headingPath: string[];
  body: string;
}

const HEADING_PATTERN = /^(#{1,6})\s+(.*)$/;
/** 围栏（``` 或 ~~~，三个起步）；**必须**连着写，`~~` 不是围栏。 */
const FENCE_PATTERN = /^\s*(`{3,}|~{3,})/;
const SENTENCE_PATTERN = /[^。！？!?；;\n]*[。！？!?；;]+|[^。！？!?；;\n]+/g;

export function headingPrefix(headingPath: readonly string[]): string {
  const path = headingPath.filter((part) => part.length > 0);
  return path.length === 0 ? '' : `【${HEADING_PREFIX_LABEL}：${path.join(' › ')}】\n`;
}

/** 打开中的代码围栏：记住**它是什么字符、有几个**（关闭必须同字符且不短于它）。 */
interface Fence {
  char: string;
  length: number;
}

/**
 * 按标题层级把正文切成小节（标题本身不进正文，只进路径）。
 *
 * 围栏按 markdown 的标准规则配对（不按"见到围栏就取反"）：
 * - 开围栏记下**字符与长度**，只有**同字符且不更短**的围栏才算关闭（`~~~` 关不掉 ``` 块）；
 * - 没闭合的围栏一直吃到文末。
 * 不这么判的两个已知误判：① ``` 块里的 `~~~` 会把围栏"提前关掉"，块里的 `# 注释`
 * 于是被当成标题、渗进 `headingPath`；② 少写一个闭合围栏就会把**后面所有标题**都吞进
 * 同一节（整段正文贴上同一个出处）。
 */
function splitSections(text: string): Section[] {
  const sections: Section[] = [];
  const stack: Array<string | undefined> = [];
  let lines: string[] = [];
  let headingPath: string[] = [];
  let fence: Fence | null = null;

  const flush = (): void => {
    const body = lines.join('\n').trim();
    if (body.length > 0) sections.push({ headingPath, body });
    lines = [];
  };

  for (const line of text.split(/\r?\n/)) {
    const marker = FENCE_PATTERN.exec(line);
    if (marker) {
      const token = marker[1];
      if (!fence) fence = { char: token[0], length: token.length };
      else if (token[0] === fence.char && token.length >= fence.length) fence = null;
    }
    const heading = fence ? null : HEADING_PATTERN.exec(line);
    if (!heading) {
      lines.push(line);
      continue;
    }
    flush();
    const level = heading[1].length;
    const title = heading[2].trim();
    stack.length = Math.min(stack.length, level - 1);
    stack[level - 1] = title.length > 0 ? title : undefined;
    headingPath = stack.filter((part): part is string => typeof part === 'string' && part.length > 0);
  }
  flush();
  return sections;
}

/**
 * 把 `end` 从"刚切进一个代理对"的位置挪开。
 *
 * `String.prototype.slice` 数的是 UTF-16 码元，而 emoji（😀 等）占**两个**码元：
 * 切在 `end` 上、而 `end-1` 是高代理时，两块各留半个字符 —— 落库/送模型时是非法
 * UTF-16（JSON 与编码器会把它变成 U+FFFD），**存下来的正文与原文不再逐字相等**。
 * 所以：往后收一格（收不动时往后**放**一格，保证循环有进展）。
 */
function surrogateSafeEnd(text: string, start: number, end: number): number {
  if (end >= text.length) return end;
  const last = text.charCodeAt(end - 1);
  const isHighSurrogate = last >= 0xd800 && last <= 0xdbff;
  if (!isHighSurrogate) return end;
  return end - 1 > start ? end - 1 : end + 1;
}

/** 把一个段落拆成不超过 `chunkSize` 的原子片段（优先句子边界，兜底字符硬切）。 */
function splitParagraph(paragraph: string, chunkSize: number): string[] {
  if (paragraph.length <= chunkSize) return [paragraph];
  const atoms: string[] = [];
  for (const match of paragraph.match(SENTENCE_PATTERN) ?? []) {
    const sentence = match.trim();
    if (sentence.length === 0) continue;
    if (sentence.length <= chunkSize) {
      atoms.push(sentence);
      continue;
    }
    for (let start = 0; start < sentence.length; ) {
      const end = surrogateSafeEnd(sentence, start, Math.min(sentence.length, start + chunkSize));
      atoms.push(sentence.slice(start, end));
      start = end;
    }
  }
  return atoms;
}

function splitAtoms(body: string, chunkSize: number): string[] {
  const atoms: string[] = [];
  for (const paragraph of body.split(/\n\s*\n/)) {
    const trimmed = paragraph.trim();
    if (trimmed.length === 0) continue;
    atoms.push(...splitParagraph(trimmed, chunkSize));
  }
  return atoms;
}

interface PackedBody {
  body: string;
  overlapChars: number;
}

/** 贪心装箱 + 重叠 + 收尾回并。 */
function packAtoms(
  atoms: readonly string[],
  chunkSize: number,
  chunkOverlap: number,
  minChunkSize: number,
): PackedBody[] {
  const packed: PackedBody[] = [];
  let parts: string[] = [];
  let overlapChars = 0;

  const measure = (): number => parts.reduce((sum, part) => sum + part.length, 0) + Math.max(0, parts.length - 1);

  const flush = (): void => {
    if (parts.length === 0) return;
    const body = parts.join('\n');
    packed.push({ body, overlapChars });
    const tail = chunkOverlap > 0 ? body.slice(-chunkOverlap) : '';
    parts = tail.length > 0 ? [tail] : [];
    overlapChars = tail.length;
  };

  for (const atom of atoms) {
    // 只有当块里**已经有超过重叠部分的内容**时才允许切 —— 否则一块就只装了重叠，
    // 白白产出一条纯重复的切片。
    if (parts.length > 0 && measure() > overlapChars && measure() + 1 + atom.length > chunkSize) flush();
    parts.push(atom);
  }
  flush();

  // 收尾碎块并回上一块：去掉它开头那段重叠（正文已经在上一块结尾里了），只追加新增部分。
  if (packed.length > 1) {
    const last = packed[packed.length - 1];
    if (last.body.length - last.overlapChars < minChunkSize) {
      const previous = packed[packed.length - 2];
      previous.body = `${previous.body}\n${last.body.slice(last.overlapChars)}`;
      packed.pop();
    }
  }
  return packed;
}

/**
 * 把一份资料的正文切成块。
 *
 * ⚠️ **已知边界（刻意保留，等 T6c 的命中率抽查再决定要不要改）：切片不跨小节。**
 *    装箱的边界是"小节"（见 `splitSections`），不是整篇正文，于是：
 *    ① 短于 `chunkSize` 的小节**自己就是一块**，既不会跟相邻小节拼成一块，也拿不到
 *       `chunkOverlap`（重叠只发生在同一小节内）—— 一节一句话的笔记（`# 收入` +
 *       一行正文）会得到很多碎块，每块都带一遍"所属"前缀；
 *    ② 反过来，一节远大于 `chunkSize` 时重叠照常，行为与整篇切一致。
 *    这么做是因为"跨小节合并"会把两节的标题路径糊在一起（`【所属：A › B】` 对合并块
 *    就是错的）。要改的话，得先给合并块定义"它属于哪一节"，不是把边界挪一下就行。
 *    当前行为有测试钉着：`packages/core/test/kb-chunking.test.ts` 里那条
 *    "小节短于块大小时不跨小节（已知边界）"。
 */
export function splitText(text: string, options: KbChunkingOptions = {}): TextChunk[] {
  const chunkSize = Math.max(1, Math.floor(options.chunkSize ?? DEFAULT_CHUNK_SIZE));
  const overlap = Math.max(0, Math.min(Math.floor(options.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP), chunkSize - 1));
  const minChunkSize = Math.max(0, Math.min(Math.floor(options.minChunkSize ?? DEFAULT_MIN_CHUNK_SIZE), chunkSize));

  const chunks: TextChunk[] = [];
  for (const section of splitSections(text)) {
    const prefix = headingPrefix(section.headingPath);
    for (const packed of packAtoms(splitAtoms(section.body, chunkSize), chunkSize, overlap, minChunkSize)) {
      chunks.push({
        ordinal: chunks.length,
        body: packed.body,
        overlapChars: packed.overlapChars,
        headingPath: section.headingPath,
        text: `${prefix}${packed.body}`,
      });
    }
  }
  return chunks;
}

const CJK_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x3040, 0x30ff], // 平假名 / 片假名
  [0x3400, 0x4dbf], // CJK 扩展 A
  [0x4e00, 0x9fff], // CJK 基本区
  [0xf900, 0xfaff], // CJK 兼容
  [0xff00, 0xff60], // 全角
  [0xac00, 0xd7af], // 谚文
];

function isCjk(code: number): boolean {
  return CJK_RANGES.some(([start, end]) => code >= start && code <= end);
}

function isAsciiWordChar(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || code === 0x5f
  );
}

/**
 * 粗略 token 估算：中日韩字符按 1 token/字，拉丁字母/数字按 4 字符 1 token。
 *
 * ⚠️ 这是**花费预览**用的保守估算，不是计费依据 —— T6b 的嵌入计费以 relay 回传的
 *    真实 usage 为准（见设计 §三"纳入定价与记账"）。
 */
export function estimateTokens(text: string): number {
  let tokens = 0;
  let asciiRun = 0;
  const flushRun = (): void => {
    if (asciiRun > 0) {
      tokens += Math.ceil(asciiRun / 4);
      asciiRun = 0;
    }
  };

  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (isCjk(code)) {
      flushRun();
      tokens += 1;
    } else if (isAsciiWordChar(code)) {
      asciiRun += 1;
    } else {
      flushRun();
    }
  }
  flushRun();
  return tokens;
}
