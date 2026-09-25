/**
 * 把一份 `.xlsx` 读成**能直接渲染**的行列。
 *
 * 为什么在**主进程**里读：`exceljs` 本来就在这里跑（P2 的文档生成），
 * 打包态那套传递依赖的坑也是在这里修好的（见 `pnpm-flattening-drops-nested-deps`）。
 * 渲染进程再引一遍等于把那套坑在新位置重踩一次，而且会把库塞进渲染包。
 *
 * ⚠️ **只读**、只读这一个文件，不落任何临时文件。
 */

import ExcelJS from 'exceljs';

export interface SheetPreview {
  name: string;
  rows: string[][];
}

export interface SheetPreviewResult {
  sheets: SheetPreview[];
  /** 有没有因为太大被截断（截了就要在界面上说，不许装作完整）。 */
  truncated: boolean;
}

/** 上限：几十万行直接塞给界面会卡死。 */
const DEFAULT_MAX_ROWS = 200;
const DEFAULT_MAX_COLS = 30;
const DEFAULT_MAX_SHEETS = 5;

/**
 * 洗掉控制字符。
 *
 * ⚠️ 用**码点判断**而不是字符类正则：把控制字符写进 `[...]` 会在源码里落成**真字节**
 *    （这个文件第一版就是这么坏的，grep 直接把它当二进制）。按码点判断没有转义层，也就没有这个坑。
 * ⚠️ 换成**空格**而不是删掉：删掉会把两个词粘成一个（`第一行第二行`）。
 */
export function cleanCellText(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? ' ' : ch;
  }
  return out.replace(/ +/g, ' ').trim();
}

/**
 * 单元格 → 人能读的一段文字。
 *
 * ⚠️ exceljs 的 `cell.value` 有七八种形状（富文本 / 公式 / 超链接 / 日期 / 错误值…），
 *    直接 `String()` 会得到 `[object Object]` —— 那就是"表能打开但内容全废"。
 */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return cleanCellText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    // 公式：给**算好的结果**，不给公式本身
    if ('result' in v) return cellText(v.result);
    if ('error' in v) return cleanCellText(String(v.error));
    // 富文本：拼成一段
    if (Array.isArray(v.richText)) {
      return cleanCellText(v.richText.map((part) => String((part as { text?: unknown }).text ?? '')).join(''));
    }
    // 超链接：给显示文字
    if ('text' in v) return cellText(v.text);
    if ('hyperlink' in v) return cleanCellText(String(v.hyperlink));
  }
  return '';
}

export async function readSheetPreview(
  buffer: Buffer,
  limits?: { maxRows?: number; maxCols?: number; maxSheets?: number },
): Promise<SheetPreviewResult> {
  const maxRows = limits?.maxRows ?? DEFAULT_MAX_ROWS;
  const maxCols = limits?.maxCols ?? DEFAULT_MAX_COLS;
  const maxSheets = limits?.maxSheets ?? DEFAULT_MAX_SHEETS;

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(new Uint8Array(buffer));
  } catch (err) {
    // ⚠️ 抛**我们自己的**错（带一句人话），别把 exceljs 的原话透出去 ——
    //    那里面可能带文件路径，而这句话要上界面。
    throw new Error(`not a readable xlsx: ${err instanceof Error ? err.name : 'unknown'}`);
  }

  const sheets: SheetPreview[] = [];
  let truncated = false;

  for (const worksheet of workbook.worksheets) {
    if (sheets.length >= maxSheets) {
      truncated = true;
      break;
    }
    const rows: string[][] = [];
    const rowCount = worksheet.actualRowCount ?? worksheet.rowCount ?? 0;
    const colCount = worksheet.actualColumnCount ?? worksheet.columnCount ?? 0;
    if (rowCount > maxRows || colCount > maxCols) truncated = true;

    for (let r = 1; r <= Math.min(rowCount, maxRows); r += 1) {
      const row = worksheet.getRow(r);
      const cells: string[] = [];
      for (let c = 1; c <= Math.min(colCount, maxCols); c += 1) {
        cells.push(cellText(row.getCell(c).value));
      }
      rows.push(cells);
    }
    sheets.push({ name: cleanCellText(worksheet.name) || 'Sheet', rows });
  }

  return { sheets, truncated };
}
