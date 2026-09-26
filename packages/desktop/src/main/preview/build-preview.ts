/**
 * 按扩展名把一份产物读成"界面能直接渲染"的形状。
 *
 * ⚠️ **按扩展名分派**，不按 MIME：产物的 `mimeType` 是写库那一刻定下的，历史数据里五花八门
 *    （甚至是空的），而扩展名是用户看得见的那个。
 */

import type { ArtifactPreview } from '@clawwork/shared';
import { readDocxOutline, readPptxOutline } from './office-outline.js';
import { readSheetPreview } from './sheet-preview.js';

export type ArtifactPreviewKind = 'sheet' | 'docx' | 'pptx' | 'pdf' | 'html';

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/**
 * 这个文件**能不能富预览**，能的话是哪一种。认不出返回 `null`。
 *
 * ⚠️ 这是**唯一真源**：主进程（决定要不要读）与渲染层（决定要不要走这条路）都问它，
 *    不许各自再写一份扩展名清单 —— 两份清单迟早只改一处，
 *    而症状是"这个功能对某种格式**静默不生效**"（这一版第一稿就是这么错的：
 *    渲染层用的是大写扩展名、清单写的是小写，功能整个不生效而没有任何报错）。
 */
export function previewKindFor(name: string): ArtifactPreviewKind | null {
  const ext = extensionOf(name);
  if (ext === 'xlsx' || ext === 'xlsm') return 'sheet';
  if (ext === 'docx') return 'docx';
  if (ext === 'pptx') return 'pptx';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'html' || ext === 'htm') return 'html';
  return null;
}

/**
 * HTML 预览的上限（**比别的格式小得多**）。
 *
 * 这不是存储限制，是**传输与渲染**的限制：整份 HTML 要走 IPC 变成字符串、再进 iframe，
 * 几十兆的页面（常见的打包产物）会让界面卡住。超限就回 `unsupported` ⇒ 退化成文本视图，
 * 用户仍然看得到源码，不会得到一个空白的框。
 */
export const MAX_HTML_PREVIEW_BYTES = 4 * 1024 * 1024;

/**
 * 给 HTML 预览注入的 CSP。**`default-src 'none'` 一句话禁掉了脚本、外链、表单、框架** ——
 * 只放行内联样式与 `data:` 图片（够看排版，不够把用户的浏览器变成跳板）。
 *
 * ⚠️ 为什么这一道不能省（渲染层已经给了 `sandbox`）：sandbox 是**容器**层的锁，
 *    CSP 是**内容**层的锁。哪天有人为了"让图表动起来"把 `allow-scripts` 松掉，
 *    还有这一道拦着外联；反过来哪天 CSP 被改坏，sandbox 仍然挡住脚本。
 */
const HTML_PREVIEW_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'";

/**
 * 把 CSP 塞进 `<head>` 的**最前面**。
 *
 * ⚠️ 必须在 `<head>` 里、且在其它内容之前：`<meta http-equiv>` 形式的 CSP 只对它**之后**
 *    解析到的内容生效（放在 body 里等于没放）。
 * ⚠️ 不改写文档结构：没有 `<head>` 的裸片段（助手常产出这种）就把 meta 贴在最前面 ——
 *    浏览器会把后面的内容补成 body，meta 仍然先行生效。
 */
function injectHtmlCsp(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}">`;
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (tag) => tag + meta) : meta + html;
}

/**
 * 读。**只在这里读一次**（调用方先问 `previewKindFor`，认不出就不读 —— 见 IPC handler）。
 *
 * ⚠️ 解析失败**要抛**（由调用方转成 `{ok:false, error}`），**不许**静默降级成 `unsupported`：
 *    前者界面会说"这个文件读不了"，后者会让用户以为"这种格式本来就不支持"——
 *    两句不一样的话，指向两个不一样的下一步。
 */
export async function buildArtifactPreview(name: string, buffer: Buffer): Promise<ArtifactPreview> {
  const kind = previewKindFor(name);
  if (kind === 'sheet') {
    const { sheets, truncated } = await readSheetPreview(buffer);
    return { kind: 'sheet', sheets, truncated };
  }
  if (kind === 'docx') {
    const { paragraphs, truncated } = await readDocxOutline(buffer);
    return { kind: 'docx', paragraphs, truncated };
  }
  if (kind === 'pptx') {
    const { slides, truncated } = await readPptxOutline(buffer);
    return { kind: 'pptx', slides, truncated };
  }
  if (kind === 'pdf') {
    return { kind: 'pdf', dataBase64: buffer.toString('base64') };
  }
  if (kind === 'html') {
    // ⚠️ 超限**不当错误抛**：这不是坏文件，只是太大 ⇒ 回 unsupported 走文本视图
    if (buffer.byteLength > MAX_HTML_PREVIEW_BYTES) return { kind: 'unsupported' };
    return { kind: 'html', html: injectHtmlCsp(buffer.toString('utf8')) };
  }
  return { kind: 'unsupported' };
}
