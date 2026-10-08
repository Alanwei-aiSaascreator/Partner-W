/**
 * 模板演示文稿的**解析与校验**。
 *
 * 助手提交的形状（```` ```docgen ```` 块里那个 JSON 的一部分）：
 *
 * ```json
 * {
 *   "kind": "pptx",
 *   "slides": [
 *     { "templateId": "cover",   "data": { "cover_title": "九月经营简报", "date": "2026-09-27" } },
 *     { "templateId": "metrics", "data": { "slide_title": "关键指标", "value_1": "12.4%", "label_1": "转化率" } }
 *   ]
 * }
 * ```
 *
 * ⚠️ **模型不提交样式，也没有地方提交样式。** 它给的是"哪一页模板 + 每个占位符写什么"，
 *    颜色、字体、坐标全在模板文件里，我们一个字节都不改。
 *    这不是"我们检查了一下有没有越界"，是**这些字段在协议里根本不存在** ——
 *    下面每一层校验都只认字符串值。
 *
 * ⚠️ 四类拒绝各有各的码（`DocgenFailure`），**都要把模型写的那个名字原样带回去**：
 *    只说"模板不对"它没法改，说"我不认识 `tmeline`"它才知道自己拼错了。
 */

import type { DocgenFailure } from '@clawwork/shared';
import { findPptxTemplate, PPTX_TEMPLATE_SET_ID, type PptxTemplateSpec } from './catalog.js';
import {
  CONTROLLED_LAYOUTS,
  CONTROLLED_TEMPLATE_ID,
  controlledCapacityFailure,
  parseNativeChart,
  type NativeBarChart,
} from './controlled.js';

/** 一页：用哪个模板 + 每个占位符写什么（已归一化，**含全部占位符**，缺的补空串）。 */
export interface TemplateSlideSpec {
  templateId: string;
  data: Readonly<Record<string, string>>;
  chart?: NativeBarChart;
}

export interface TemplateDeckSpec {
  slides: readonly TemplateSlideSpec[];
  controlledNative?: true;
}

export type ParseTemplateDeckResult = { ok: true; deck: TemplateDeckSpec } | { ok: false; failure: DocgenFailure };

/**
 * 值只允许是**字符串或有限数字**。
 *
 * 收数字是为了指标那类字段：模型写 `"value_1": 12.4` 比写 `"12.4"` 自然，
 * 而这不是"从自然语言猜数"—— 它就是一个结构化字段，我们只做类型放宽。
 * ⚠️ `NaN` / `Infinity` **不收**：它们渲染出来是 `NaN`，是一句假话。
 */
function coerceValue(raw: unknown): string | null {
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  return null;
}

/** 占位符值里的换行由 `\n` 表达；模板里的文本框是**按单行估过宽的**，所以这里压平。 */
function flatten(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\n/g, ' ').trim();
}

function failureFor(
  spec: PptxTemplateSpec,
  page: number,
  field: string,
  kind: 'unknown' | 'too-long' | 'missing',
  maxChars?: number,
): DocgenFailure {
  const base = { format: 'pptx' as const, page, templateId: spec.id, field };
  if (kind === 'unknown') return { code: 'template-field-unknown', ...base };
  if (kind === 'missing') return { code: 'template-field-missing', ...base };
  return { code: 'template-field-too-long', ...base, maxChars: maxChars ?? 0 };
}

/**
 * 校验一页。
 *
 * 顺序是刻意的：**先查"有没有多余的东西"（未知字段），再查"该有的有没有"（缺失），
 * 最后查长度**。理由：模型拼错一个键名时，它同时会"少一个必需字段"——
 * 如果先报缺失，它会以为要补一个，而真正的问题是那个拼错的键。
 * 先报未知键，它一眼就看到自己写错了什么。
 */
function parseSlide(
  raw: unknown,
  page: number,
  controlledNative = false,
): { ok: true; slide: TemplateSlideSpec } | { ok: false; failure: DocgenFailure } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, failure: { code: 'request-invalid' } };
  }
  const record = raw as Record<string, unknown>;
  const templateId = typeof record.templateId === 'string' ? record.templateId : '';
  const spec = findPptxTemplate(templateId);
  if (!spec || (controlledNative && !CONTROLLED_LAYOUTS.includes(templateId))) {
    return { ok: false, failure: { code: 'template-page-unknown', format: 'pptx', page, templateId } };
  }

  const rawData = record.data;
  if (rawData !== undefined && (rawData === null || typeof rawData !== 'object' || Array.isArray(rawData))) {
    return { ok: false, failure: { code: 'request-invalid' } };
  }
  const data = (rawData ?? {}) as Record<string, unknown>;

  // ① 未知占位符：一律拒绝，绝不静默忽略 —— 忽略掉的话模型会以为写进去了。
  for (const key of Object.keys(data)) {
    if (!Object.prototype.hasOwnProperty.call(spec.tokens, key)) {
      return { ok: false, failure: failureFor(spec, page, key, 'unknown') };
    }
  }

  const normalized: Record<string, string> = {};
  for (const [name, tokenSpec] of Object.entries(spec.tokens)) {
    const provided = data[name];
    const coerced = provided === undefined ? '' : coerceValue(provided);
    if (coerced === null) {
      // 给了但不是字符串/有限数字（对象、数组、布尔、NaN）—— 当作未知字段报，
      // 因为"这个键的形状不对"与"这个键不存在"对模型是同一个动作：别写它。
      return { ok: false, failure: failureFor(spec, page, name, 'unknown') };
    }
    const value = flatten(coerced);
    if (value.length === 0) {
      if (tokenSpec.required) return { ok: false, failure: failureFor(spec, page, name, 'missing') };
      // 可选且没给 ⇒ **写成空串**，把模板里的 {{占位符}} 清掉。
      // 不能"留着不管"：那样成品上会挂着一个 {{xxx}}，是给用户看的假字。
      normalized[name] = '';
      continue;
    }
    if (value.length > tokenSpec.maxLength) {
      return { ok: false, failure: failureFor(spec, page, name, 'too-long', tokenSpec.maxLength) };
    }
    normalized[name] = value;
  }

  if (controlledNative) {
    if (Object.keys(record).some((key) => !['templateId', 'data', 'chart'].includes(key)))
      return { ok: false, failure: { code: 'request-invalid' } };
    const failure = controlledCapacityFailure(spec.id, normalized, page, record.chart !== undefined);
    if (failure) return { ok: false, failure };
  }
  let chart: NativeBarChart | undefined;
  if (controlledNative && record.chart !== undefined) {
    const parsedChart = controlledNative && spec.id === 'metrics' ? parseNativeChart(record.chart) : null;
    if (!parsedChart) return { ok: false, failure: failureFor(spec, page, 'chart', 'unknown') };
    chart = parsedChart;
  }
  return { ok: true, slide: { templateId: spec.id, data: normalized, ...(chart ? { chart } : {}) } };
}

/**
 * 解析整份演示文稿。
 *
 * ⚠️ `template` 字段是**可选**的，且只有一个合法值。做成可选是因为"用哪套模板文件"
 *    是实现细节（这一版只有一套）；模型只需要挑**每一页的版式**。
 *    真给了又不认识 ⇒ 明说 `request-invalid`，不假装没看见。
 */
export function parseTemplateDeck(
  input: unknown,
  options: { controlledNative?: boolean } = {},
): ParseTemplateDeckResult {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, failure: { code: 'request-invalid' } };
  }
  const record = input as Record<string, unknown>;

  const controlledNative = options.controlledNative === true && record.template === CONTROLLED_TEMPLATE_ID;
  if (record.template !== undefined && record.template !== PPTX_TEMPLATE_SET_ID && !controlledNative) {
    return { ok: false, failure: { code: 'request-invalid' } };
  }

  const rawSlides = record.slides;
  if (!Array.isArray(rawSlides) || rawSlides.length === 0 || (controlledNative && rawSlides.length > 60)) {
    return { ok: false, failure: { code: 'request-invalid' } };
  }

  const slides: TemplateSlideSpec[] = [];
  for (let i = 0; i < rawSlides.length; i++) {
    const parsed = parseSlide(rawSlides[i], i + 1, controlledNative);
    if (!parsed.ok) return { ok: false, failure: parsed.failure };
    slides.push(parsed.slide);
  }

  return { ok: true, deck: { slides, ...(controlledNative ? { controlledNative: true as const } : {}) } };
}
