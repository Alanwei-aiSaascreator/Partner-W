/**
 * **富预览**的形状：`.docx` / `.xlsx` / `.pptx` / `.pdf` 读出来给界面渲染。
 *
 * 为什么要有它：我们自己就产这些格式（docgen），而预览只认图片 / Markdown / 代码
 * ⇒ **用户做完一份东西，在应用里看不见它**，只能导出去用 Office 开。
 *
 * ⚠️ 定义在 shared 是**故意的**：这个形状要跨主进程 → IPC → 渲染层三道边界，
 *    每层各写一遍必然漂移（`RuntimeBootstrapStatus` 那次就是这么收进来的）。
 * ⚠️ `truncated` **必须如实透出**：截断了却装作完整，用户会以为"我的表就这么点内容"。
 */

/** 一页表格。 */
export interface SheetPreview {
  name: string;
  rows: string[][];
}

/** 一页幻灯片。`index` 从 1 开始，**按真实页序**（不是文件名字典序）。 */
export interface PptxSlidePreview {
  index: number;
  lines: string[];
}

export type ArtifactPreview =
  | { kind: 'sheet'; sheets: SheetPreview[]; truncated: boolean }
  | { kind: 'docx'; paragraphs: string[]; truncated: boolean }
  | { kind: 'pptx'; slides: PptxSlidePreview[]; truncated: boolean }
  /** PDF：字节交给渲染层，由 Chromium 自带的阅读器渲染（已实测：不会触发下载）。 */
  | { kind: 'pdf'; dataBase64: string }
  /** 认不出/不支持：界面照旧给"用系统程序打开"。 */
  | { kind: 'unsupported' };
