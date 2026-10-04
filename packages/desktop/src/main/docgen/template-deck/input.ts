import { TemplateDeckError, type SlotTable, type TemplateDeckContent, type TemplateChartData } from './types.js';

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
  for (const page of catalog.filter((item) => Object.hasOwn(content, String(item.slide_number)))) {
    try {
      const number = result.size + 1;
      const raw = content[String(page.slide_number)];
      if (!raw) fail('page-content-missing', 'page required', number);
      const supplied: unknown = Array.isArray(raw) ? raw : raw.texts;
      const slots = page.text_slots.filter((slot) => slot.editable);
      if (!Array.isArray(supplied) || supplied.length !== slots.length)
        fail('slot-content-count', `expected ${slots.length}`, number);
      const ids = new Set<string>(),
        addresses = new Set<string>();
      const texts = slots.map((slot, index) => {
        const address = JSON.stringify(slot.address);
        if (ids.has(slot.slot_id) || addresses.has(address))
          fail('slot-table-invalid', 'duplicate slot', number, slot.slot_id);
        ids.add(slot.slot_id);
        addresses.add(address);
        const limits = [slot.max_chars, slot.chars_per_line, slot.max_lines, slot.font_size_pt];
        if (limits.some((value) => !Number.isInteger(value) || value < 1))
          fail('slot-table-invalid', 'invalid text limits', number, slot.slot_id);
        const text = requireText(supplied[index], number, slot.slot_id);
        const lines = text.split('\n');
        if (codepoints(lines.join('')) > slot.max_chars)
          fail('text-overflow', `maximum ${slot.max_chars} codepoints`, number, slot.slot_id);
        const wrappedLines = lines.reduce(
          (sum, line) => sum + Math.max(1, Math.ceil(codepoints(line) / slot.chars_per_line)),
          0,
        );
        if (wrappedLines > slot.max_lines)
          fail('line-overflow', `estimated ${wrappedLines}, maximum ${slot.max_lines}`, number, slot.slot_id);
        return text;
      });
      const data = Array.isArray(raw) ? undefined : raw.chart;
      if (page.chart) {
        if (!data) fail('chart-data-missing', 'native chart data required', number);
        if (typeof data.title !== 'string' || !data.title.trim())
          fail('chart-title-missing', 'native chart title required', number);
        requireText(data.title, number);
        if (
          !Array.isArray(data.categories) ||
          !data.categories.length ||
          data.categories.length > page.chart.categories_max ||
          !Array.isArray(data.series) ||
          !data.series.length ||
          data.series.length > page.chart.series_max
        )
          fail('chart-data-invalid', 'category or series count outside contract', number);
        data.categories.forEach((category) => requireText(category, number, undefined, false));
        for (const series of data.series) {
          requireText(series.name, number, undefined, false);
          if (series.name.trim() === '\u7cfb\u5217\u4e00') fail('placeholder-text', series.name, number);
          if (
            !Array.isArray(series.values) ||
            series.values.length !== data.categories.length ||
            series.values.some((value) => typeof value !== 'number' || !Number.isFinite(value))
          )
            fail('chart-data-invalid', 'finite numeric value required for every category', number);
        }
      } else if (data) fail('chart-data-unexpected', 'page has no native chart', number);
      result.set(page.slide_number, { texts, chart: data, outputPage: number });
    } catch (error) {
      if (error instanceof TemplateDeckError)
        throw new TemplateDeckError(
          error.diagnostics.map((item) => ({
            ...item,
            detail: `layout ${page.slide_number}: ${item.detail}`,
          })),
        );
      throw error;
    }
  }
  return result;
}
