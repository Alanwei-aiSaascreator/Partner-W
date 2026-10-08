import type { DocgenFailure } from '@clawwork/shared';

export const CONTROLLED_TEMPLATE_ID = 'business-deck-v5';
export const CONTROLLED_TEMPLATE_FILE = 'business-deck-v5.pptx';
export const CONTROLLED_LAYOUTS = ['cover', 'insight', 'metrics', 'closing'];

export interface NativeBarChart {
  type: 'bar';
  unit: string;
  data: Array<{ name: string; labels: string[]; values: number[] }>;
}

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  value.length <= max &&
  Array.from(value).every((char) => char.charCodeAt(0) >= 32);

export function parseNativeChart(value: unknown): NativeBarChart | null {
  if (
    !object(value) ||
    Object.keys(value).some((key) => !['type', 'unit', 'data'].includes(key)) ||
    value.type !== 'bar' ||
    !text(value.unit, 16) ||
    !Array.isArray(value.data) ||
    value.data.length < 1 ||
    value.data.length > 2
  )
    return null;
  const data: NativeBarChart['data'] = [];
  for (const series of value.data) {
    if (
      !object(series) ||
      Object.keys(series).some((key) => !['name', 'labels', 'values'].includes(key)) ||
      !text(series.name, 8) ||
      !Array.isArray(series.labels) ||
      !Array.isArray(series.values) ||
      series.labels.length < 1 ||
      series.labels.length > 4 ||
      series.values.length !== series.labels.length ||
      !series.labels.every((label) => text(label, 8)) ||
      new Set(series.labels).size !== series.labels.length ||
      !series.values.every(
        (number) => typeof number === 'number' && Number.isFinite(number) && Math.abs(number) <= 1e12,
      )
    )
      return null;
    if (data.length && JSON.stringify(series.labels) !== JSON.stringify(data[0].labels)) return null;
    if (data.some((existing) => existing.name === series.name)) return null;
    data.push({ name: series.name, labels: [...series.labels], values: [...series.values] });
  }
  return { type: 'bar', unit: value.unit, data };
}

export function controlledCapacityFailure(
  templateId: string,
  data: Readonly<Record<string, string>>,
  page: number,
  hasChart = false,
): DocgenFailure | undefined {
  if (hasChart) {
    for (let metric = 1; metric <= 3; metric++) {
      const size = ['label', 'value', 'note'].reduce(
        (sum, name) => sum + Array.from(data[`${name}_${metric}`] ?? '').length,
        0,
      );
      if (size > 40)
        return {
          code: 'template-field-too-long',
          format: 'pptx',
          templateId,
          field: `metric_${metric}`,
          page,
          maxChars: 40,
        };
    }
  }
  for (const [field, value] of Object.entries(data)) {
    const maxChars = /(?:cover|slide|closing)_title/.test(field)
      ? 36
      : field.startsWith('evidence_')
        ? data.takeaway
          ? 65
          : 110
        : field === 'takeaway' || field === 'closing_message'
          ? 120
          : field === 'source_or_note'
            ? 80
            : /^(?:label_|note_)/.test(field)
              ? 24
              : undefined;
    if (maxChars !== undefined && Array.from(value).length > maxChars)
      return { code: 'template-field-too-long', format: 'pptx', templateId, field, page, maxChars };
  }
  if (
    templateId === 'insight' &&
    !Object.entries(data).some(([field, value]) => field !== 'slide_title' && field !== 'slide_subtitle' && value)
  )
    return { code: 'template-field-missing', format: 'pptx', templateId, field: 'evidence_1', page };
  return undefined;
}
