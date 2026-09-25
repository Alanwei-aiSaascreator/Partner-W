/**
 * `docx` / `pptx` 的**文字大纲**：把文件里写了什么读出来给界面看。
 *
 * 为什么是"大纲"而不是像素级还原：像素级要引渲染库，而这个仓库**加依赖有前科**
 * （打包态压平 pnpm 树会丢嵌套依赖，见 [[pnpm-flattening-drops-nested-deps]]）。
 * 用户真正缺的是"我刚做出来的那份东西里写了什么" —— 逐页/逐段的文字就够。
 * ⚠️ 界面上必须**如实说这是文字版**，不许装成完整还原。
 *
 * 依赖：只用 `node:zlib`（经由 `zip-entry`），零新依赖。
 */

import { listZipEntries, readZipEntry } from './zip-entry.js';

/** 上限：一份几十页的文档全铺出来会卡。 */
const MAX_PARAGRAPHS = 400;
const MAX_SLIDES = 60;
const MAX_LINES_PER_SLIDE = 40;
/** 单条文字的长度上限（防一行几万字把布局撑爆）。 */
const MAX_LINE_CHARS = 500;

/** XML 实体解回来。⚠️ `&amp;` 不解会把用户的原话原样变成转义码。 */
export function decodeXmlEntities(text: string): string {
  return (
    text
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
      .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
      // &amp; 放最后：先解它会把 `&amp;lt;` 变成 `<`（那是不对的，它本来就该显示 `&lt;`）
      .replace(/&amp;/g, '&')
  );
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 从一段 XML 里抓出所有 `<prefix:t>` 的文字，按出现顺序拼成若干"行"。
 *
 * ⚠️ 前缀不写死（`w:t` / `a:t` / 干脆 `t`）：不同产出方前缀不同，
 *    写死会在换一个来源时**静默读成空**（那比报错更难发现）。
 */
function extractTexts(xml: string, prefix: string): string[] {
  const re = new RegExp(`<${prefix}t(?:\\s[^>]*)?>([\\s\\S]*?)</${prefix}t>`, 'g');
  const out: string[] = [];
  for (const match of xml.matchAll(re)) out.push(decodeXmlEntities(match[1]));
  return out;
}

/** 段落切分：按 `</w:p>` 切，每段里的 run 拼起来。 */
function splitParagraphs(xml: string): string[] {
  const chunks = xml.split(new RegExp(`</${'w'}:p>`));
  const paragraphs: string[] = [];
  for (const chunk of chunks) {
    const text = extractTexts(chunk, 'w:').join('').trim();
    if (text) paragraphs.push(text.slice(0, MAX_LINE_CHARS));
  }
  return paragraphs;
}

export interface DocxOutline {
  paragraphs: string[];
  truncated: boolean;
}

export async function readDocxOutline(buffer: Buffer): Promise<DocxOutline> {
  const xml = readZipEntry(buffer, 'word/document.xml');
  if (!xml) throw new Error('not a readable docx: word/document.xml missing');

  const all = splitParagraphs(xml.toString('utf8'));
  return {
    paragraphs: all.slice(0, MAX_PARAGRAPHS),
    truncated: all.length > MAX_PARAGRAPHS,
  };
}

export interface PptxSlide {
  /** **页码从 1 开始**，按文件的真实页序（不是文件名字典序）。 */
  index: number;
  lines: string[];
}

export interface PptxOutline {
  slides: PptxSlide[];
  truncated: boolean;
}

export async function readPptxOutline(buffer: Buffer): Promise<PptxOutline> {
  const names = listZipEntries(buffer).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  if (names.length === 0) throw new Error('not a readable pptx: no slides found');

  // ⭐ **按数字排**：`slide10.xml` 的字典序排在 `slide2.xml` 前面，照字典序会给用户一沓乱页。
  const ordered = names
    .map((name) => ({ name, n: Number(/slide(\d+)\.xml$/.exec(name)?.[1] ?? 0) }))
    .sort((a, b) => a.n - b.n);

  const slides: PptxSlide[] = [];
  for (const { name, n } of ordered.slice(0, MAX_SLIDES)) {
    const xml = readZipEntry(buffer, name);
    if (!xml) continue;
    // ⚠️ 空白页也要占位：少一页会让后面**所有页码错位**
    const lines = extractTexts(xml.toString('utf8'), 'a:')
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
      .slice(0, MAX_LINES_PER_SLIDE)
      .map((t) => t.slice(0, MAX_LINE_CHARS));
    slides.push({ index: n, lines });
  }

  return { slides, truncated: ordered.length > MAX_SLIDES };
}
