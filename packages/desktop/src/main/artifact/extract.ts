import { createHash } from 'crypto';
import { extname } from 'node:path';

const LANG_EXT: Record<string, string> = {
  typescript: 'ts',
  javascript: 'js',
  python: 'py',
  rust: 'rs',
  go: 'go',
  java: 'java',
  css: 'css',
  html: 'html',
  json: 'json',
  yaml: 'yml',
  yml: 'yml',
  toml: 'toml',
  sql: 'sql',
  sh: 'sh',
  bash: 'sh',
  shell: 'sh',
  ruby: 'rb',
  tsx: 'tsx',
  jsx: 'jsx',
  markdown: 'md',
  md: 'md',
};

interface ExtractedImage {
  src: string;
  alt: string;
  isRemote: boolean;
}

interface ExtractedCodeBlock {
  language: string;
  content: string;
  fileName: string;
  lineCount: number;
}

function sanitizeExtractedFileName(raw: string): string {
  if (!raw || raw === '.' || raw === '..') throw new Error('invalid code block filename');
  if (raw.includes('/') || raw.includes('\\')) throw new Error('invalid code block filename');
  if (raw.includes('..')) throw new Error('invalid code block filename');
  return raw;
}

export function isIntermediateArtifactName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.endsWith('.native-ppt.json') ||
    lower.startsWith('.royin-ppt-receipt-') ||
    name.startsWith('~$') ||
    lower.endsWith('.tmp') ||
    lower.endsWith('.part') ||
    lower.endsWith('.partial') ||
    lower.endsWith('.lock') ||
    lower.endsWith('~')
  );
}

/**
 * 二进制文档扩展名：**文本围栏永远变不出其中的任何一个**。
 *
 * 围栏块的正文经过这里时**已经是纯文本**（`Buffer.from(content, 'utf-8')`），
 * 把它命名成 `.docx` / `.xlsx` / `.pdf` 存下来，得到的必然是一份
 * 「扩展名是 Word/Excel/PDF、内容是文本」的假文件 —— 用户点开就是
 * "打不开 / 乱码"（真机反馈 #9：*重新生成 docx：桌面出现 js 文件；
 * 新 docx 打不开/乱码* —— 模型把围栏标成 `报告.docx` 这类文件名时即命中）。
 *
 * 本产品里**真文档只有一条路**：`docgen` 围栏（pptx/docx/xlsx/pdf）由
 * `renderDocument` 渲染成真文件。文本围栏标了这些扩展名 ⇒ 直接不产出文件
 * （正文仍留在聊天里），与上面 `isIntermediateArtifactName` 的中间文件同一处置。
 */
const BINARY_DOCUMENT_EXTENSIONS = new Set(['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.pdf']);

/** 围栏标记（```name.ext 形态）指着二进制文档 ⇒ 不是可保存的内容。 */
function namesBinaryDocument(lang: string): boolean {
  return BINARY_DOCUMENT_EXTENSIONS.has(extname(lang).toLowerCase());
}

/**
 * **不是代码**的围栏语言：它们是"生成文件"的请求（`docgen` → Office 文件、`htmlgen` → 网页），
 * 由各自的渲染器变成真文件后单独落盘。列在一处是为了"加第三条通道时只改一行"。
 */
const GENERATOR_FENCES = new Set(['docgen', 'htmlgen', 'slidegen']);

export function extractImagesFromMarkdown(content: string): ExtractedImage[] {
  return [...content.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)].map(([, alt, src]) => ({
    src,
    alt,
    isRemote: /^https?:\/\//.test(src),
  }));
}

export function extractCodeBlocksFromMarkdown(content: string): ExtractedCodeBlock[] {
  return (
    [...content.matchAll(/^```(\S*)\n([\s\S]*?)\n```/gm)]
      // ⚠️ `docgen` / `htmlgen` / `slidegen` 块**不是**代码产物：它们是生成文件的请求，
      //    由 `main/docgen/`、`main/htmlgen/` 渲染成真文件后**单独**走 `saveArtifactFromBuffer` 存。
      //    不排除的话，用户在产物里会同时看到那份文件**和**一段 JSON 噪音。
      //    ⚠️ 这三个名字要与各生成器 `blocks.ts` 的围栏正则**一致** ——
      //    漏一个的症状是"网页生成出来了，旁边还多一份它的 JSON 源码"。
      .filter(([, lang]) => !GENERATOR_FENCES.has(lang.trim().toLowerCase()))
      .map(([, lang, body]) => {
        const lineCount = body.split('\n').length;
        const hasDot = lang.includes('.');
        if (lineCount <= 10 && !hasDot) return null;
        if (hasDot && namesBinaryDocument(lang)) return null;
        const fileName = hasDot
          ? sanitizeExtractedFileName(lang)
          : `snippet-${createHash('sha1').update(body).digest('hex').slice(0, 6)}.${LANG_EXT[lang.toLowerCase()] ?? 'txt'}`;
        if (isIntermediateArtifactName(fileName)) return null;
        return { language: lang, content: body, fileName, lineCount };
      })
      .filter((b): b is ExtractedCodeBlock => b !== null)
  );
}
