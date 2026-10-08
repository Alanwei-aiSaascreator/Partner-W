import {
  TemplateDeckError,
  type SlotTable,
  type TemplateDeckContent,
  type TemplateChartData,
  type TemplateDeckDiagnostic,
} from './types.js';

export function fail(code: string, detail: string, page?: number, slotId?: string): never {
  throw new TemplateDeckError([{ code, detail, page, slotId }]);
}

export const normalizeText = (value: string) => value.replace(/\r\n?/g, '\n');
export const codepoints = (value: string) => Array.from(value).length;

const placeholders = new Set([
  '\u9875\u9762\u6807\u9898',
  '\u5361\u7247\u6807\u9898',
  '\u5361\u7247\u6b63\u6587',
  '\u5e95\u90e8\u7ed3\u8bba',
  '\u6b65\u9aa4\u540d',
  '\u6b65\u9aa4\u8bf4\u660e',
  '\u8865\u5145\u8bf4\u660e',
  '\u5de6\u8868\u5934',
  '\u53f3\u8868\u5934',
  '\u5de6\u5217\u6b63\u6587',
  '\u53f3\u5217\u6b63\u6587',
  '\u7ef4\u5ea6',
  '\u5bf9\u6bd4\u7ef4\u5ea6',
  '\u65b9\u68481',
  '\u65b9\u68482',
  '\u65b9\u68483',
  '\u4e3b\u6807\u9898',
  '\u526f\u6807\u9898',
  '\u5bfc\u8bed',
  '\u843d\u6b3e',
  '\u9875\u811a',
  '\u5e8f\u53f7',
  '\u76ee\u5f55\u9879',
  '\u7ae0\u8282\u540d\u79f0',
  '\u7ae0\u8282\u6807\u9898',
  '\u7ae0\u8282\u8bf4\u660e',
  '\u65f6\u95f4\u7ebf\u8282\u70b9',
  '\u65f6\u95f4\u7ebf\u8bf4\u660e',
  '\u5e74\u4efd',
  '\u8981\u70b9\u6807\u9898',
  '\u8981\u70b9\u8bf4\u660e',
  '\u7ed3\u8bba\u6807\u9898',
  '\u7ed3\u8bba\u8bf4\u660e',
  '\u6307\u6807\u540d\u79f0',
  '\u53e3\u5f84\u8bf4\u660e',
  '\u89e3\u8bfb\u6807\u9898',
  '\u89e3\u8bfb\u6b63\u6587',
  '\u5c42\u7ea7\u540d\u79f0',
  '\u5c42\u7ea7\u8bf4\u660e',
  '\u6e05\u5355\u6761\u76ee',
  '\u7ed3\u5c3e\u4e3b\u6807',
  '\u7ed3\u5c3e\u526f\u6807',
  '\u8054\u7cfb\u65b9\u5f0f',
  '\u5355\u5143\u683c',
  '\u5185\u5bb9',
  '\u9879\u76ee1',
  '\u9879\u76ee2',
  '\u9879\u76ee3',
  '\u9879\u76ee4',
  '\u9879\u76ee5',
  '\u8868\u59341',
  '\u8868\u59342',
  '\u8868\u59343',
  '\u8868\u59344',
  '\u56fe\u8868\u6807\u9898',
  '\u7cfb\u5217\u4e00',
  '\u672c\u671f',
  '\u540c\u671f',
]);

export function requireText(value: unknown, page: number, slotId?: string, rejectPlaceholder = true): string {
  if (typeof value !== 'string' || !value.trim()) fail('text-invalid', 'nonempty string required', page, slotId);
  const text = normalizeText(value);
  if (
    Array.from(text).some((char) => {
      const point = char.codePointAt(0)!;
      return (
        point <= 8 ||
        point === 11 ||
        point === 12 ||
        (point >= 14 && point <= 31) ||
        point === 65534 ||
        point === 65535 ||
        (point >= 55296 && point <= 57343)
      );
    })
  )
    fail('text-invalid', 'invalid XML characters', page, slotId);
  if (rejectPlaceholder && placeholders.has(text.trim())) fail('placeholder-text', text, page, slotId);
  return text;
}

export interface PageInput {
  texts: string[];
  chart?: TemplateChartData;
  outputPage: number;
}

export function validateContent(table: SlotTable, content: TemplateDeckContent): Map<number, PageInput> {
  if (
    !table ||
    !Array.isArray(table.pages) ||
    table.pages.length !== table.slide_count ||
    !Array.isArray(table.fonts) ||
    !table.fonts.length
  )
    fail('slot-table-invalid', 'invalid page count or fonts');
  if (!content || typeof content !== 'object' || Array.isArray(content))
    fail('content-invalid', 'page mapping required');
  // The supplied full-catalog example already contains this explanatory string.
  const keys = Object.keys(content).filter((key) => key !== '_说明' || typeof content[key] !== 'string');
  if (!keys.length) fail('content-invalid', 'nonempty page selection required');
  for (const key of keys)
    if (!/^[1-9]\d*$/.test(key) || Number(key) > table.slide_count) fail('page-content-unexpected', key);
  // Validate the whole catalog even when a damaged layout is not selected.
  const catalog = [...table.pages].sort((a, b) => a.slide_number - b.slide_number);
  catalog.forEach((page, index) => {
    if (page.slide_number !== index + 1 || !Array.isArray(page.text_slots))
      fail('slot-table-invalid', 'invalid or duplicate page', page.slide_number);
    const ids = new Set<string>(),
      addresses = new Set<string>();
    for (const slot of page.text_slots.filter((item) => item.editable)) {
      const address = slot.address;
      if (
        !address ||
        !Number.isInteger(address.shape_id) ||
        address.shape_id < 1 ||
        !Number.isInteger(address.paragraph) ||
        address.paragraph < 0 ||
        (slot.kind === 'table_cell' &&
          (!Array.isArray(address.cell) ||
            address.cell.length !== 2 ||
            address.cell.some((value) => !Number.isInteger(value) || value < 0))) ||
        (slot.kind === 'text' && address.cell !== undefined) ||
        !['text', 'table_cell'].includes(slot.kind) ||
        !slot.slot_id ||
        ids.has(slot.slot_id) ||
        addresses.has(JSON.stringify(address)) ||
        [slot.max_chars, slot.chars_per_line, slot.max_lines, slot.font_size_pt].some(
          (value) => !Number.isInteger(value) || value < 1,
        )
      )
        fail('slot-table-invalid', 'invalid slot address, duplicate or limits', page.slide_number, slot.slot_id);
      ids.add(slot.slot_id);
      addresses.add(JSON.stringify(address));
    }
    if (
      page.chart &&
      (!['bar', 'line'].includes(page.chart.kind) ||
        [page.chart.shape_id, page.chart.categories_max, page.chart.series_max, page.chart.font_size_pt].some(
          (value) => !Number.isInteger(value) || value < 1,
        ))
    )
      fail('slot-table-invalid', 'invalid chart metadata', page.slide_number);
  });
  const result = new Map<number, PageInput>();
  /**
   * \u2b50 BUG-046 \u2461\uff082026-10-08 \u771f\u673a 41 \u6b21\u6e90\u6587\u4ef6\u5199\u5165\u7684\u6839\u56e0\u4e4b\u4e00\uff09\uff1a\u65e7\u7684 per-page
   * try/catch \u4e00\u6b21\u53ea\u629b\u4e00\u6761\u8bca\u65ad\uff08"expected 12"\u2192\u4fee\u2192"expected 14"\u2192\u4fee\u2192"expected 21"\uff09\uff0c
   * \u6a21\u578b\u88ab\u8feb"\u4fee\u4e00\u4e2a\u2192\u518d\u8dd1\u2192\u518d\u649e\u4e0b\u4e00\u4e2a"\u3002\u73b0\u5728**\u4e00\u6b21\u6821\u9a8c\u6536\u96c6\u5168\u90e8**\u53ef\u6536\u96c6\u7684 layout/schema
   * \u95ee\u9898\uff0c\u6700\u540e\u4e00\u6b21\u6027\u629b\u51fa\uff08bounded repair \u7531\u4e0a\u5c42 `auto_count<2` \u9650\u6b7b\uff0c\u7981\u6b62\u65e0\u9650 retry\uff09\uff1b
   * \u53ea\u6709\u8868\u7ed3\u6784\u574f\uff08slot-table-invalid / content-invalid \u7b49**\u4e0d\u53ef\u6062\u590d**\u9879\uff09\u624d fail-fast\u3002
   */
  const issues: TemplateDeckDiagnostic[] = [];
  // BUG-053①：输出页序按「选中序列的位次」计，与成败无关。
  // 旧写法 `result.size + 1` 只在成功页上递增——失败页不 set，其后每页都重复同一个号
  // （[3,3,3]），把"这页本该是输出第几页"这件事报成噪音。页序对模型修复无用，
  // layout 身份始终由 detail 前缀 `layout <n>` 承载；这里保持页序字段自洽即可。
  const selected = catalog.filter((item) => Object.hasOwn(content, String(item.slide_number)));
  for (const [selectedIndex, page] of selected.entries()) {
    const number = selectedIndex + 1;
    const label = (detail: string) => `layout ${page.slide_number}: ${detail}`;
    try {
      const raw = content[String(page.slide_number)];
      if (!raw) {
        issues.push({ code: 'page-content-missing', page: number, detail: label('page required') });
        continue;
      }
      const supplied: unknown = Array.isArray(raw) ? raw : raw.texts;
      const slots = page.text_slots.filter((slot) => slot.editable);
      if (!Array.isArray(supplied) || supplied.length !== slots.length) {
        issues.push({
          code: 'slot-content-count',
          page: number,
          detail: label(
            `expected ${slots.length} (${slots.map((slot) => slot.role).join(',')}), got ${
              Array.isArray(supplied) ? supplied.length : 'non-array'
            }`,
          ),
        });
        continue; // \u8ba1\u6570\u5bf9\u4e0d\u4e0a\u6ca1\u6cd5\u9010\u69fd\u6821\u9a8c\u2014\u2014\u6574\u9875\u8df3\u8fc7\uff0c\u5176\u4f59\u9875\u7167\u5e38\u6536\u96c6\u3002
      }
      const ids = new Set<string>(),
        addresses = new Set<string>();
      const texts: string[] = [];
      let pageBroken = false;
      for (const [index, slot] of slots.entries()) {
        const address = JSON.stringify(slot.address);
        if (ids.has(slot.slot_id) || addresses.has(address)) {
          issues.push({
            code: 'slot-table-invalid',
            page: number,
            slotId: slot.slot_id,
            detail: label('duplicate slot'),
          });
          pageBroken = true;
          break; // \u8868\u574f = \u4e0d\u53ef\u6062\u590d\uff1a\u8fd9\u9875\u5230\u6b64\u4e3a\u6b62\uff0c\u522b\u7684\u9875\u7ee7\u7eed\u3002
        }
        ids.add(slot.slot_id);
        addresses.add(address);
        const limits = [slot.max_chars, slot.chars_per_line, slot.max_lines, slot.font_size_pt];
        if (limits.some((value) => !Number.isInteger(value) || value < 1)) {
          issues.push({
            code: 'slot-table-invalid',
            page: number,
            slotId: slot.slot_id,
            detail: label('invalid text limits'),
          });
          pageBroken = true;
          break;
        }
        const value = supplied[index];
        if (typeof value !== 'string' || !value.trim()) {
          issues.push({ code: 'text-invalid', page: number, slotId: slot.slot_id, detail: 'nonempty string required' });
          pageBroken = true;
          continue;
        }
        const text = normalizeText(value);
        if (
          Array.from(text).some((char) => {
            const point = char.codePointAt(0)!;
            return (
              point <= 8 ||
              point === 11 ||
              point === 12 ||
              (point >= 14 && point <= 31) ||
              point === 65534 ||
              point === 65535 ||
              (point >= 55296 && point <= 57343)
            );
          })
        ) {
          issues.push({ code: 'text-invalid', page: number, slotId: slot.slot_id, detail: 'invalid XML characters' });
          pageBroken = true;
          continue;
        }
        if (placeholders.has(text.trim())) {
          issues.push({ code: 'placeholder-text', page: number, slotId: slot.slot_id, detail: text });
          pageBroken = true;
          continue;
        }
        const lines = text.split('\n');
        if (codepoints(lines.join('')) > slot.max_chars) {
          issues.push({
            code: 'text-overflow',
            page: number,
            slotId: slot.slot_id,
            detail: `maximum ${slot.max_chars} codepoints`,
          });
          pageBroken = true;
          continue;
        }
        const wrappedLines = lines.reduce(
          (sum, line) => sum + Math.max(1, Math.ceil(codepoints(line) / slot.chars_per_line)),
          0,
        );
        if (wrappedLines > slot.max_lines) {
          issues.push({
            code: 'line-overflow',
            page: number,
            slotId: slot.slot_id,
            detail: `estimated ${wrappedLines}, maximum ${slot.max_lines}`,
          });
          pageBroken = true;
          continue;
        }
        texts.push(text);
      }
      if (pageBroken) continue;
      const data = Array.isArray(raw) ? undefined : raw.chart;
      if (page.chart) {
        if (!data) {
          issues.push({ code: 'chart-data-missing', page: number, detail: 'native chart data required' });
          continue;
        }
        if (typeof data.title !== 'string' || !data.title.trim()) {
          issues.push({ code: 'chart-title-missing', page: number, detail: 'native chart title required' });
          continue;
        }
        try {
          requireText(data.title, number);
        } catch (error) {
          issues.push(...recoverDiagnostics(error));
          continue;
        }
        if (
          !Array.isArray(data.categories) ||
          !data.categories.length ||
          data.categories.length > page.chart.categories_max ||
          !Array.isArray(data.series) ||
          !data.series.length ||
          data.series.length > page.chart.series_max
        ) {
          issues.push({
            code: 'chart-data-invalid',
            page: number,
            detail: 'category or series count outside contract',
          });
          continue;
        }
        let chartBroken = false;
        data.categories.forEach((category) => {
          try {
            requireText(category, number, undefined, false);
          } catch (error) {
            issues.push(...recoverDiagnostics(error));
            chartBroken = true;
          }
        });
        for (const series of data.series) {
          try {
            requireText(series.name, number, undefined, false);
          } catch (error) {
            issues.push(...recoverDiagnostics(error));
            chartBroken = true;
          }
          if (series.name.trim() === '\u7cfb\u5217\u4e00') {
            issues.push({ code: 'placeholder-text', page: number, detail: series.name });
            chartBroken = true;
          }
          if (
            !Array.isArray(series.values) ||
            series.values.length !== data.categories.length ||
            series.values.some((value) => typeof value !== 'number' || !Number.isFinite(value))
          ) {
            issues.push({
              code: 'chart-data-invalid',
              page: number,
              detail: 'finite numeric value required for every category',
            });
            chartBroken = true;
          }
        }
        if (chartBroken) continue;
      } else if (data) {
        issues.push({ code: 'chart-data-unexpected', page: number, detail: 'page has no native chart' });
        continue;
      }
      result.set(page.slide_number, { texts, chart: data, outputPage: number });
    } catch (error) {
      if (error instanceof TemplateDeckError) issues.push(...recoverDiagnostics(error));
      else throw error;
    }
  }
  if (issues.length) throw new TemplateDeckError(issues);
  return result;
}

/** \u628a fail() \u629b\u51fa\u7684\u5355\u6761\u8bca\u65ad\u6536\u8fdb\u805a\u5408\u5217\u8868\uff08\u9875\u9762\u524d\u7f00\u7531\u5916\u5c42 label \u7edf\u4e00\u5904\u7406\u8fc7\uff09\u3002 */
function recoverDiagnostics(error: unknown): TemplateDeckDiagnostic[] {
  return error instanceof TemplateDeckError ? error.diagnostics : [];
}
