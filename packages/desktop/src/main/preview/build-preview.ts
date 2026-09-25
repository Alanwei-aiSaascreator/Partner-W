/**
 * 按扩展名把一份产物读成"界面能直接渲染"的形状。
 *
 * ⚠️ **按扩展名分派**，不按 MIME：产物的 `mimeType` 是写库那一刻定下的，历史数据里五花八门
 *    （甚至是空的），而扩展名是用户看得见的那个。
 */

import type { ArtifactPreview } from '@clawwork/shared';
import { readDocxOutline, readPptxOutline } from './office-outline.js';
import { readSheetPreview } from './sheet-preview.js';

export type ArtifactPreviewKind = 'sheet' | 'docx' | 'pptx' | 'pdf';

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
  return null;
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
  return { kind: 'unsupported' };
}
