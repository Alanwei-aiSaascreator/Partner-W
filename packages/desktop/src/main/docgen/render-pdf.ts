/**
 * `kind: 'pdf'` 的渲染器（2026-09-26）。
 *
 * **为什么用 Chromium 的打印管线，而不是引一个 PDF 库**：
 *   中文 PDF 的难点从来不是排版，是**字体**。引库就得内嵌一份 CJK 字体
 *   （包体 +15~20 MB，商用授权还要单独谈），不内嵌就是别人机器上的方块字。
 *   而 Electron 自带 `printToPDF` —— 和用户自己用浏览器"打印成 PDF"同一条路，
 *   中文靠**系统字体**天然可用，零新依赖、零字体分发、不碰授权。
 *
 * ⚠️ 这条路唯一的风险面：**把助手写的内容当 HTML 塞进一个窗口**。三道封堵：
 *   1. `buildPdfHtml` 把内容**逐字转义**（`<` `>` `&`），助手写的 `<script>` 只是一个尖括号；
 *   2. 打印窗口 `javascript: false` + `sandbox: true` + `contextIsolation: true` + **无 preload**
 *      —— 窗口里连脚本引擎都不开；
 *   3. 我们生成的 HTML **没有任何外部引用**（内联样式、系统字体），打印过程不联网。
 *
 * ⚠️ 内容走 `data:` URL 而不是落一个临时文件：**不写任何临时文件**就没有清理与残留问题
 *    （红线：只落工作区/临时目录 —— 这里干脆一个字节都不落）。
 */
import { BrowserWindow } from 'electron';
import { escapeHtml } from '../util/html-escape.js';
import type { DocgenPdfRequest } from './request.js';
/**
 * 把请求渲染成一份**自带全部样式、不引用任何外部资源**的 HTML。
 *
 * 字体用系统栈：`Microsoft YaHei`（Windows 中文首选）→ `PingFang SC`（macOS）→
 * `Noto Sans CJK SC`（Linux）→ 兜底 sans-serif。**不内嵌、不外链**。
 */
export function buildPdfHtml(request: DocgenPdfRequest): string {
  const sections = request.sections
    .map((section) => {
      const heading = section.heading ? `<h2>${escapeHtml(section.heading)}</h2>` : '';
      const paragraphs = section.paragraphs.map((text) => `<p>${escapeHtml(text)}</p>`).join('');
      const bullets =
        section.bullets.length > 0
          ? `<ul>${section.bullets.map((text) => `<li>${escapeHtml(text)}</li>`).join('')}</ul>`
          : '';
      return `<section>${heading}${paragraphs}${bullets}</section>`;
    })
    .join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${escapeHtml(request.title)}</title>
<style>
  @page { size: A4; margin: 20mm 18mm; }
  body { font-family: "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "Source Han Sans SC", sans-serif;
         color: #1a1a1a; font-size: 12pt; line-height: 1.75; }
  h1 { font-size: 20pt; margin: 0 0 18pt; padding-bottom: 8pt; border-bottom: 1px solid #d0d0d0; }
  h2 { font-size: 14pt; margin: 16pt 0 6pt; }
  p { margin: 0 0 8pt; white-space: pre-wrap; }
  ul { margin: 0 0 10pt; padding-left: 18pt; }
  li { margin: 0 0 4pt; }
  section { break-inside: avoid; }
</style>
</head>
<body>
<h1>${escapeHtml(request.title)}</h1>
${sections}
</body>
</html>`;
}

/** 打印器：把一份 HTML 变成 PDF 字节。抽成类型是为了单测能注一个假的。 */
export type PdfPrinter = (html: string) => Promise<Buffer>;

/**
 * 真实打印器：隐藏窗口 + `printToPDF`。
 *
 * ⚠️ 窗口**必须**关掉脚本（`javascript: false`）：内容是我们转义过的，但这道开关是
 *    防"将来哪天模板改了、漏了一处转义"的第二层保险。窗口没有任何 preload
 *    ⇒ 即使有脚本也摸不到应用的任何东西。
 * ⚠️ `show: false`：用户不该看到一闪而过的窗口。
 */
export async function printHtmlToPdf(html: string): Promise<Buffer> {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      javascript: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      images: true,
    },
  });
  try {
    await win.loadURL(`data:text/html;charset=utf-8;base64,${Buffer.from(html, 'utf8').toString('base64')}`);
    return await win.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      margins: { marginType: 'default' },
    });
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

/** 渲染入口：与另外三个渲染器同形（`Promise<Buffer>`）。 */
export async function renderPdf(request: DocgenPdfRequest, print: PdfPrinter = printHtmlToPdf): Promise<Buffer> {
  return print(buildPdfHtml(request));
}
