export interface SlotAddress {
  shape_id: number;
  paragraph: number;
  cell?: [number, number];
}

export interface Slot {
  slot_id: string;
  address: SlotAddress;
  role: string;
  editable: boolean;
  kind: 'text' | 'table_cell';
  max_chars: number;
  chars_per_line: number;
  max_lines: number;
  font_size_pt: number;
}

export interface ChartMeta {
  chart_id: string;
  shape_id: number;
  kind: 'bar' | 'line';
  title: string;
  categories_max: number;
  series_max: number;
  font_size_pt: number;
  value_range?: [number, number];
}

export interface SlotTable {
  slide_count: number;
  slide_size_emu?: [number, number];
  fonts: string[];
  type_scale: Record<string, number>;
  pages: { slide_number: number; layout: string; text_slots: Slot[]; chart?: ChartMeta }[];
}

export interface TemplateChartData {
  title: string;
  categories: string[];
  series: { name: string; values: number[] }[];
}

export type TemplateDeckContent = Record<string, string[] | { texts: string[]; chart?: TemplateChartData }>;

export interface TemplateDeckDiagnostic {
  code: string;
  page?: number;
  slotId?: string;
  detail: string;
}

export class TemplateDeckError extends Error {
  constructor(public readonly diagnostics: TemplateDeckDiagnostic[]) {
    super(diagnostics.map((item) => `${item.code}:${item.page ?? ''}:${item.slotId ?? ''}:${item.detail}`).join('; '));
    this.name = 'TemplateDeckError';
  }
}

export interface TemplateDeckVerification {
  status: 'passed';
  pages: number;
  slots: number;
  tableCells: number;
  charts: number;
  fonts: string[];
}
