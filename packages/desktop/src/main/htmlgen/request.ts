import { HTMLGEN_SECTION_KINDS, HTMLGEN_TEMPLATES, type HtmlgenFailure, type HtmlgenTemplate } from '@clawwork/shared';

/**
 * **网页生成（htmlgen）的请求契约**（助手写、客户端读）。
 *
 * ## 与 `docgen` 的分工是同一条，只有出口不同
 *
 * docgen 那条是"助手想内容、客户端排文件（pptx/docx/xlsx/pdf）"。这条一样，
 * 只是出口是**一份能直接看的网页**：好处是**浏览器排版引擎** ——
 * 字号层级、留白、栅格、卡片、表格样式、`@media print` 全都真的生效，
 * 而 pptx 那条是"在坐标上画元素"，没有排版引擎，内容一多就只能整份拒掉。
 *
 * ## ⭐ 这一条最重要的性质：**助手写不出 HTML**
 *
 * 它交上来的是一份**结构化内容**。协议里**没有**任何承载标记/样式/坐标的字段：
 *
 * | 它想写的 | 协议里有没有 | 会怎样 |
 * | -------- | ------------ | ------ |
 * | `<div style="...">` | 没有 | 当**文本**逐字转义，页面上原样看到这串字符 |
 * | `"style"` / `"color"` / `"font"` | 没有 | **整份拒**：`htmlgen-unsupported-field` |
 * | `"html"` / `"raw"` / `"content"` | 没有 | 同上 |
 * | `"src"` / `"url"` / `"href"` / `"image"` | 没有 | 同上（本轮**不接任何图片**） |
 * | `"x"` / `"y"` / 任意本地路径 | 没有 | 同上 |
 *
 * ⚠️ "整份拒"和"当文本"是**两种不同的结果**，这很重要：前者是"你写错字段了"，
 *    后者是"你写的是内容，那就当内容看" —— 后者才是对的默认，前者是**明确拒绝未知**。
 *
 * ⚠️ 这个文件只做**解析与校验**，不碰文件系统、不拼 HTML ——
 *    于是它可以被穷举测试，而"排版"那部分坏掉时能被立刻定位到另一层（`templates.ts`）。
 */

export type { HtmlgenTemplate };

/**
 * `kind` **必须**正好是 `"html"`。
 *
 * ⚠️ 看着像废话（围栏语言已经是 `htmlgen` 了），但它挡的是**贴错块**：
 *    把一份 `docgen` 的请求贴进 `htmlgen` 围栏时，没有这道检查就会一路走到
 *    "字段对不上"的模糊报错；有了它，拒绝的原因直指"这不是本协议的块"（进日志）。
 */
export const HTMLGEN_KIND = 'html';

/** 文档语言白名单：给的是 `lang` 属性（读屏、断行、字体回退都看它）。 */
export const HTMLGEN_LANGS = ['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'de', 'es', 'fr', 'pt'] as const;
export type HtmlgenLang = (typeof HTMLGEN_LANGS)[number];
export const HTMLGEN_DEFAULT_LANG: HtmlgenLang = 'zh-CN';

export interface HtmlgenMetric {
  /** 指标名，例如"转化率"。 */
  label: string;
  /** 指标值，例如"12.4%"。**当文本**：`"1.2 万"`、`"A/B"` 都要原样显示，所以不收数字。 */
  value: string;
  /** 补充说明，例如"较上月 +1.8pp"。可空。 */
  detail?: string;
}

export interface HtmlgenAction {
  /** 要做的事，一句话。 */
  title: string;
  /** 补充说明。可空。 */
  detail?: string;
  /** 谁来做。可空（用户原话里就常是"待定"）。 */
  owner?: string;
  /** 什么时候。**当文本**（"本周五" / "2026-10-08" 都行）。 */
  due?: string;
}

/** 一个小节。四种类型各有一组字段，**不通用**（`metrics` 带 `columns` 会被整份拒）。 */
export type HtmlgenSection =
  | { kind: 'narrative'; heading?: string; paragraphs: string[]; bullets: string[] }
  | { kind: 'metrics'; heading?: string; items: HtmlgenMetric[] }
  | { kind: 'table'; heading?: string; caption?: string; columns: string[]; rows: string[][] }
  | { kind: 'actions'; heading?: string; items: HtmlgenAction[] };

export interface HtmlgenSource {
  /** 来源名，例如"内部经营数据"。 */
  label: string;
  /** 口径/日期之类的补充，例如"统计口径截至 2026-09-27"。可空。 */
  note?: string;
}

export interface HtmlgenRequest {
  kind: 'html';
  /** 页面标题。同时是**文件名**的主名。 */
  title: string;
  /** 文档语言。 */
  lang: HtmlgenLang;
  /** 版式。 */
  template: HtmlgenTemplate;
  /** 开篇摘要（模板把它排成"最重要的一句话"）。 */
  summary?: string;
  sections: HtmlgenSection[];
  sources: HtmlgenSource[];
}

/**
 * 版式契约。
 *
 * `requires` 是**这个版式至少要给出的那一类内容**（任一即可）。它不是洁癖：
 * "数据页"里一个数据都没有、或"项目计划"里没有行动项，产出的是一份**看着像成品、
 * 其实是空壳**的页面 —— 那比不生成更糟，因为用户会以为我们就会做这种东西。
 *
 * `allows` 是**这个版式接受的小节类型**。多数版式收全部四种，
 * 但 `data` 明确不收 `actions`（一页数据里夹一张待办卡，读者会不知道这页在说什么）。
 */
interface HtmlgenTemplateSpec {
  requires: readonly (typeof HTMLGEN_SECTION_KINDS)[number][];
  allows: readonly (typeof HTMLGEN_SECTION_KINDS)[number][];
}

const ALL_SECTIONS = HTMLGEN_SECTION_KINDS;

export const HTMLGEN_TEMPLATE_SPECS: Readonly<Record<HtmlgenTemplate, HtmlgenTemplateSpec>> = Object.freeze({
  brief: { requires: ['narrative', 'metrics', 'table'], allows: ALL_SECTIONS },
  proposal: { requires: ['narrative', 'actions'], allows: ALL_SECTIONS },
  research: { requires: ['narrative'], allows: ALL_SECTIONS },
  plan: { requires: ['actions'], allows: ALL_SECTIONS },
  data: { requires: ['metrics', 'table'], allows: ['narrative', 'metrics', 'table'] },
});

export type HtmlgenParseResult =
  | { ok: true; request: HtmlgenRequest }
  | {
      ok: false;
      /** 给界面用的结构化原因（界面按九种语言各翻一份）。 */
      failure: HtmlgenFailure;
      /** 给日志看的英文细节（**不上屏**：那是内部话，用户看不懂，助手也拿不到）。 */
      detail: string;
    };

/**
 * 上限：既是防手滑，也是防"助手把整篇东西塞进一个字段"。
 *
 * ⚠️ 这些数**不只是防滥用**，还是"产出必定能被富预览"的计算依据：
 *    每处都顶格写（20 个小节全是满行满列的表格）时，渲染出来的 HTML 必须仍在
 *    `MAX_HTMLGEN_OUTPUT_BYTES`(3 MiB) 以内，那又必须在 `MAX_HTML_PREVIEW_BYTES`(4 MiB) 以内，
 *    否则用户拿到的是一份只能当纯文本看的大文件 —— 等于这条路白做。
 *    这个不变量由 `test/htmlgen-render.test.ts` 里"顶格写满仍在预算内"那一条钉住，
 *    **改这里的任何一个数之前先去跑它**（它会直接把算出来的字节数报出来）。
 */
export const HTMLGEN_LIMITS = Object.freeze({
  maxTitleChars: 120,
  maxSummaryChars: 600,
  maxSections: 20,
  maxSources: 12,
  maxSourceLabelChars: 80,
  maxSourceNoteChars: 300,
  maxHeadingChars: 120,
  // ── narrative ────────────────────────────────────────────────────────
  maxParagraphs: 20,
  maxParagraphChars: 1000,
  maxBullets: 20,
  maxBulletChars: 300,
  // ── metrics ──────────────────────────────────────────────────────────
  maxMetricItems: 12,
  maxMetricLabelChars: 40,
  maxMetricValueChars: 24,
  maxMetricDetailChars: 120,
  // ── table ────────────────────────────────────────────────────────────
  // 表格是唯一会平方级膨胀的小节（行 × 列 × 格长），所以它是上面那条预算的**约束项**。
  maxTableColumns: 10,
  maxTableRows: 80,
  maxTableCellChars: 150,
  maxCaptionChars: 120,
  // ── actions ──────────────────────────────────────────────────────────
  maxActionItems: 20,
  maxActionTitleChars: 120,
  maxActionDetailChars: 600,
  maxActionOwnerChars: 40,
  maxActionDueChars: 40,
});

/** 根上允许出现的键。**多一个就是整份拒**（见 `unsupported-field`）。 */
const ROOT_KEYS = ['kind', 'title', 'lang', 'template', 'summary', 'sections', 'sources'] as const;

/** 每种小节类型**真正**允许的键 —— 不在这张表里的写法一律整份拒。 */
const SECTION_KEYS_BY_KIND: Readonly<Record<string, readonly string[]>> = Object.freeze({
  narrative: ['kind', 'heading', 'paragraphs', 'bullets'],
  metrics: ['kind', 'heading', 'items'],
  table: ['kind', 'heading', 'caption', 'columns', 'rows'],
  actions: ['kind', 'heading', 'items'],
});

const METRIC_KEYS = ['label', 'value', 'detail'] as const;
const ACTION_KEYS = ['title', 'detail', 'owner', 'due'] as const;
const SOURCE_KEYS = ['label', 'note'] as const;

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 内部助手函数的失败形状 —— **就是 `HtmlgenParseResult` 失败的那一半**。
 *
 * ⚠️ 刻意**不另起一个形状**（比如"细节字符串 + 一个可选的字段名"）：那样上层要
 *    把细节重新拼成码，而拼错/漏字段时**没有任何编译期信号**（实测踩过：
 *    "未知字段"的路径只写进了 `failure`，外层却去读另一个同名的顶层属性，
 *    于是整类安全失败悄悄降级成了通用的"格式不对"，而 `detail` 里明明写着是哪个字段）。
 *    现在助手函数**直接产出最终形状**，上层原样上交，中间没有可丢东西的地方。
 */
type Bad = Extract<HtmlgenParseResult, { ok: false }>;

function invalid(detail: string): Bad {
  return { ok: false, failure: { code: 'htmlgen-block-invalid' }, detail };
}

/** 未知字段的拒绝：`field` 是**字段路径**（`sections[1].style`），排错要有落点。 */
function badField(field: string): Bad {
  return { ok: false, failure: { code: 'htmlgen-unsupported-field', field }, detail: `unsupported field at ${field}` };
}

/**
 * 未知键检查。**返回第一个多出来的键的路径**。
 *
 * ⚠️ 用 `Object.keys`（**自有可枚举键**）而不是 `in`：`in` 会沿原型链找，
 *    于是 `"toString"` 这种名字会被当成"已知字段"。JSON.parse 出来的正是自有键，
 *    用 `Object.keys` 恰好对上"助手实际写了什么"。
 */
function firstUnknownKey(value: Record<string, unknown>, allowed: readonly string[], where: string): string | null {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) return where ? `${where}.${key}` : key;
  }
  return null;
}

interface StringListOptions {
  where: string;
  noun: string;
  maxItems: number;
  maxChars: number;
}

/**
 * 一串文本（自然段 / 要点）：**空串丢掉、超量或超长整份拒**。
 *
 * ⚠️ 数量按**原样条数**算（含空串）—— 与 `docgen/request.ts` 逐字同一条规则。
 *    两条通道对"同样的写法"给出不同判定，是最难向用户解释的一类不一致。
 */
function parseStringList(
  raw: unknown,
  options: StringListOptions,
): { ok: true; items: string[] } | { ok: false; detail: string } {
  if (raw === undefined || raw === null) return { ok: true, items: [] };
  if (!Array.isArray(raw)) return { ok: false, detail: `${options.where} must be an array` };
  if (raw.length > options.maxItems) return { ok: false, detail: `${options.where} exceeds ${options.maxItems}` };
  const kept: string[] = [];
  for (const item of raw) {
    const text = asTrimmedString(item);
    if (!text) continue;
    if (text.length > options.maxChars) {
      return { ok: false, detail: `${options.where} has a ${options.noun} longer than ${options.maxChars} characters` };
    }
    kept.push(text);
  }
  return { ok: true, items: kept };
}

/** 可选文本字段：给就校验长度，不给（或给空串）就是 `undefined`。 */
function parseOptionalText(
  raw: unknown,
  where: string,
  maxChars: number,
): { ok: true; text: string | undefined } | { ok: false; detail: string } {
  if (raw === undefined || raw === null) return { ok: true, text: undefined };
  const text = asTrimmedString(raw);
  if (text && text.length > maxChars) return { ok: false, detail: `${where} exceeds ${maxChars} characters` };
  return { ok: true, text: text ?? undefined };
}

function parseMetricsSection(
  section: Record<string, unknown>,
  heading: string | undefined,
  where: string,
): { ok: true; section: HtmlgenSection } | Bad {
  const raw = section.items;
  if (raw === undefined || raw === null) return { ok: true, section: { kind: 'metrics', heading, items: [] } };
  if (!Array.isArray(raw)) return invalid(`${where}.items must be an array`);
  if (raw.length > HTMLGEN_LIMITS.maxMetricItems) {
    return invalid(`${where}.items exceeds ${HTMLGEN_LIMITS.maxMetricItems}`);
  }

  const items: HtmlgenMetric[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const itemWhere = `${where}.items[${i}]`;
    if (!isPlainObject(raw[i])) return invalid(`${itemWhere} must be an object`);
    const item = raw[i] as Record<string, unknown>;
    const unknown = firstUnknownKey(item, METRIC_KEYS, itemWhere);
    if (unknown) return badField(unknown);

    const label = asTrimmedString(item.label);
    if (!label) return invalid(`${itemWhere}.label is required`);
    if (label.length > HTMLGEN_LIMITS.maxMetricLabelChars) {
      return invalid(`${itemWhere}.label exceeds ${HTMLGEN_LIMITS.maxMetricLabelChars}`);
    }
    const value = asTrimmedString(item.value);
    if (!value) return invalid(`${itemWhere}.value is required`);
    if (value.length > HTMLGEN_LIMITS.maxMetricValueChars) {
      return invalid(`${itemWhere}.value exceeds ${HTMLGEN_LIMITS.maxMetricValueChars}`);
    }
    const detail = parseOptionalText(item.detail, `${itemWhere}.detail`, HTMLGEN_LIMITS.maxMetricDetailChars);
    if (!detail.ok) return invalid(detail.detail);
    items.push(detail.text ? { label, value, detail: detail.text } : { label, value });
  }
  return { ok: true, section: { kind: 'metrics', heading, items } };
}

function parseActionsSection(
  section: Record<string, unknown>,
  heading: string | undefined,
  where: string,
): { ok: true; section: HtmlgenSection } | Bad {
  const raw = section.items;
  if (raw === undefined || raw === null) return { ok: true, section: { kind: 'actions', heading, items: [] } };
  if (!Array.isArray(raw)) return invalid(`${where}.items must be an array`);
  if (raw.length > HTMLGEN_LIMITS.maxActionItems) {
    return invalid(`${where}.items exceeds ${HTMLGEN_LIMITS.maxActionItems}`);
  }

  const items: HtmlgenAction[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const itemWhere = `${where}.items[${i}]`;
    if (!isPlainObject(raw[i])) return invalid(`${itemWhere} must be an object`);
    const item = raw[i] as Record<string, unknown>;
    const unknown = firstUnknownKey(item, ACTION_KEYS, itemWhere);
    if (unknown) return badField(unknown);

    const title = asTrimmedString(item.title);
    if (!title) return invalid(`${itemWhere}.title is required`);
    if (title.length > HTMLGEN_LIMITS.maxActionTitleChars) {
      return invalid(`${itemWhere}.title exceeds ${HTMLGEN_LIMITS.maxActionTitleChars}`);
    }
    const detail = parseOptionalText(item.detail, `${itemWhere}.detail`, HTMLGEN_LIMITS.maxActionDetailChars);
    if (!detail.ok) return invalid(detail.detail);
    const owner = parseOptionalText(item.owner, `${itemWhere}.owner`, HTMLGEN_LIMITS.maxActionOwnerChars);
    if (!owner.ok) return invalid(owner.detail);
    const due = parseOptionalText(item.due, `${itemWhere}.due`, HTMLGEN_LIMITS.maxActionDueChars);
    if (!due.ok) return invalid(due.detail);

    const action: HtmlgenAction = { title };
    if (detail.text) action.detail = detail.text;
    if (owner.text) action.owner = owner.text;
    if (due.text) action.due = due.text;
    items.push(action);
  }
  return { ok: true, section: { kind: 'actions', heading, items } };
}

function parseTableSection(
  section: Record<string, unknown>,
  heading: string | undefined,
  where: string,
): { ok: true; section: HtmlgenSection } | Bad {
  const rawColumns = section.columns;
  if (!Array.isArray(rawColumns)) return invalid(`${where}.columns must be an array`);
  if (rawColumns.length === 0) return invalid(`${where}.columns must not be empty`);
  if (rawColumns.length > HTMLGEN_LIMITS.maxTableColumns) {
    return invalid(`${where}.columns exceeds ${HTMLGEN_LIMITS.maxTableColumns}`);
  }
  const columns: string[] = [];
  for (let c = 0; c < rawColumns.length; c += 1) {
    const text = asTrimmedString(rawColumns[c]);
    if (!text) return invalid(`${where}.columns[${c}] is required`);
    if (text.length > HTMLGEN_LIMITS.maxTableCellChars) {
      return invalid(`${where}.columns[${c}] exceeds ${HTMLGEN_LIMITS.maxTableCellChars}`);
    }
    columns.push(text);
  }

  const caption = parseOptionalText(section.caption, `${where}.caption`, HTMLGEN_LIMITS.maxCaptionChars);
  if (!caption.ok) return invalid(caption.detail);

  const build = (rows: string[][]): { ok: true; section: HtmlgenSection } => {
    const result: HtmlgenSection = { kind: 'table', columns, rows };
    if (heading) result.heading = heading;
    if (caption.text) result.caption = caption.text;
    return { ok: true, section: result };
  };

  const rawRows = section.rows;
  if (rawRows === undefined || rawRows === null) return build([]);
  if (!Array.isArray(rawRows)) return invalid(`${where}.rows must be an array`);
  if (rawRows.length > HTMLGEN_LIMITS.maxTableRows) {
    return invalid(`${where}.rows exceeds ${HTMLGEN_LIMITS.maxTableRows}`);
  }

  const rows: string[][] = [];
  for (let r = 0; r < rawRows.length; r += 1) {
    const rawRow = rawRows[r];
    if (!Array.isArray(rawRow)) return invalid(`${where}.rows[${r}] must be an array`);
    // ⚠️ 多出来的格子**拒**而不是丢：丢掉会让用户拿到一张**少了信息**的表，而他不知道。
    if (rawRow.length > columns.length) {
      return invalid(`${where}.rows[${r}] has more cells than columns`);
    }
    const cells: string[] = [];
    let empty = true;
    for (let c = 0; c < rawRow.length; c += 1) {
      const cell = rawRow[c];
      // 单元格只收字符串与有限数字：数字原样变文本（页面不是电子表格，不求和不排序）。
      const text = typeof cell === 'number' && Number.isFinite(cell) ? String(cell) : (asTrimmedString(cell) ?? '');
      if (text.length > HTMLGEN_LIMITS.maxTableCellChars) {
        return invalid(`${where}.rows[${r}][${c}] exceeds ${HTMLGEN_LIMITS.maxTableCellChars}`);
      }
      if (text !== '') empty = false;
      cells.push(text);
    }
    // 补齐到列数（最后几格没值是合法的），整行空的丢掉。
    while (cells.length < columns.length) cells.push('');
    if (empty) continue;
    rows.push(cells);
  }
  return build(rows);
}

function parseSection(raw: unknown, index: number): { ok: true; section: HtmlgenSection } | Bad {
  const where = `sections[${index}]`;
  if (!isPlainObject(raw)) return invalid(`${where} must be an object`);
  const section = raw as Record<string, unknown>;

  const kind = asTrimmedString(section.kind);
  if (!kind) return invalid(`${where}.kind is required`);
  if (!(HTMLGEN_SECTION_KINDS as readonly string[]).includes(kind)) {
    return invalid(`${where}.kind is unknown: ${kind}`);
  }
  // 类型内的键白名单（`metrics` 带 `columns` 在这一步被挡下）。
  const unknownForKind = firstUnknownKey(section, SECTION_KEYS_BY_KIND[kind], where);
  if (unknownForKind) return badField(unknownForKind);

  const heading = parseOptionalText(section.heading, `${where}.heading`, HTMLGEN_LIMITS.maxHeadingChars);
  if (!heading.ok) return invalid(heading.detail);

  switch (kind) {
    case 'metrics':
      return parseMetricsSection(section, heading.text, where);
    case 'actions':
      return parseActionsSection(section, heading.text, where);
    case 'table':
      return parseTableSection(section, heading.text, where);
    default: {
      const paragraphs = parseStringList(section.paragraphs, {
        where: `${where}.paragraphs`,
        noun: 'paragraph',
        maxItems: HTMLGEN_LIMITS.maxParagraphs,
        maxChars: HTMLGEN_LIMITS.maxParagraphChars,
      });
      if (!paragraphs.ok) return invalid(paragraphs.detail);
      const bullets = parseStringList(section.bullets, {
        where: `${where}.bullets`,
        noun: 'bullet',
        maxItems: HTMLGEN_LIMITS.maxBullets,
        maxChars: HTMLGEN_LIMITS.maxBulletChars,
      });
      if (!bullets.ok) return invalid(bullets.detail);
      const narrative: HtmlgenSection = { kind: 'narrative', paragraphs: paragraphs.items, bullets: bullets.items };
      if (heading.text) narrative.heading = heading.text;
      return { ok: true, section: narrative };
    }
  }
}

/** 这一小节有没有"实质内容"（**只有标题也算** —— 与 `docgen/request.ts` 同一条口径）。 */
function sectionHasContent(section: HtmlgenSection): boolean {
  if (section.heading) return true;
  switch (section.kind) {
    case 'narrative':
      return section.paragraphs.length > 0 || section.bullets.length > 0;
    case 'metrics':
    case 'actions':
      return section.items.length > 0;
    case 'table':
      return section.rows.length > 0;
  }
}

/**
 * 解析并校验请求。
 *
 * 认不出来一律**拒**（并说清是哪一类），不猜：这个函数的下游是要写进用户工作区的文件，
 * "猜一个能跑的形状"会让用户拿到一份内容不对的页面 —— 比不生成更糟，
 * 因为他会以为助手本来就是这么写给他的。
 */
export function parseHtmlgenRequest(raw: unknown): HtmlgenParseResult {
  if (!isPlainObject(raw)) return invalid('request must be a JSON object');
  const input = raw as Record<string, unknown>;

  const unknownRoot = firstUnknownKey(input, ROOT_KEYS, '');
  if (unknownRoot) return badField(unknownRoot);

  const kind = asTrimmedString(input.kind);
  if (kind !== HTMLGEN_KIND) return invalid(`kind must be "${HTMLGEN_KIND}"`);

  const title = asTrimmedString(input.title);
  if (!title) return invalid('title is required');
  if (title.length > HTMLGEN_LIMITS.maxTitleChars) {
    return invalid(`title exceeds ${HTMLGEN_LIMITS.maxTitleChars} characters`);
  }

  const rawTemplate = asTrimmedString(input.template);
  if (!rawTemplate) return invalid('template is required');
  if (!(HTMLGEN_TEMPLATES as readonly string[]).includes(rawTemplate)) {
    // ⚠️ 回显**助手原样写的那串**（截断一下，免得一屏都是它）。
    return {
      ok: false,
      failure: { code: 'htmlgen-unknown-template', template: rawTemplate.slice(0, 40) },
      detail: `unknown template "${rawTemplate}" (only: ${HTMLGEN_TEMPLATES.join(', ')})`,
    };
  }
  const template = rawTemplate as HtmlgenTemplate;

  let lang: HtmlgenLang = HTMLGEN_DEFAULT_LANG;
  if (input.lang !== undefined && input.lang !== null) {
    const rawLang = asTrimmedString(input.lang);
    if (!rawLang || !(HTMLGEN_LANGS as readonly string[]).includes(rawLang)) {
      return invalid(`lang must be one of: ${HTMLGEN_LANGS.join(', ')}`);
    }
    lang = rawLang as HtmlgenLang;
  }

  const summary = parseOptionalText(input.summary, 'summary', HTMLGEN_LIMITS.maxSummaryChars);
  if (!summary.ok) return invalid(summary.detail);

  const rawSections = input.sections;
  if (!Array.isArray(rawSections)) return invalid('sections must be an array');
  if (rawSections.length === 0) return invalid('sections must not be empty');
  if (rawSections.length > HTMLGEN_LIMITS.maxSections) {
    return invalid(`sections exceeds ${HTMLGEN_LIMITS.maxSections}`);
  }

  const spec = HTMLGEN_TEMPLATE_SPECS[template];
  const sections: HtmlgenSection[] = [];
  const presentKinds = new Set<string>();
  for (let i = 0; i < rawSections.length; i += 1) {
    // ⚠️ **只有完全空的 `{}`** 当空壳丢掉（模型偶尔补一个占位，为它整份失败不值得）。
    //    写了任何键却没写 `kind` 的一律拒 —— 那种情况下静默丢掉等于**把用户的内容吃掉**，
    //    而且没人会知道（`{"paragraphs":["……"]}` 看着就像"我给了正文"）。
    if (isPlainObject(rawSections[i]) && Object.keys(rawSections[i] as object).length === 0) continue;
    const parsed = parseSection(rawSections[i], i);
    if (!parsed.ok) return parsed;
    // 有 `kind` 但一点内容都没有的（`{kind:'metrics', items:[]}`）同样丢掉。
    if (!sectionHasContent(parsed.section)) continue;
    if (!spec.allows.includes(parsed.section.kind)) {
      return invalid(`template "${template}" does not allow a "${parsed.section.kind}" section`);
    }
    presentKinds.add(parsed.section.kind);
    sections.push(parsed.section);
  }

  const rawSources = input.sources;
  const sources: HtmlgenSource[] = [];
  if (rawSources !== undefined && rawSources !== null) {
    if (!Array.isArray(rawSources)) return invalid('sources must be an array');
    if (rawSources.length > HTMLGEN_LIMITS.maxSources) {
      return invalid(`sources exceeds ${HTMLGEN_LIMITS.maxSources}`);
    }
    for (let i = 0; i < rawSources.length; i += 1) {
      const where = `sources[${i}]`;
      if (!isPlainObject(rawSources[i])) return invalid(`${where} must be an object`);
      const entry = rawSources[i] as Record<string, unknown>;
      const unknown = firstUnknownKey(entry, SOURCE_KEYS, where);
      if (unknown) return badField(unknown);
      const label = asTrimmedString(entry.label);
      if (!label) return invalid(`${where}.label is required`);
      if (label.length > HTMLGEN_LIMITS.maxSourceLabelChars) {
        return invalid(`${where}.label exceeds ${HTMLGEN_LIMITS.maxSourceLabelChars}`);
      }
      const note = parseOptionalText(entry.note, `${where}.note`, HTMLGEN_LIMITS.maxSourceNoteChars);
      if (!note.ok) return invalid(note.detail);
      sources.push(note.text ? { label, note: note.text } : { label });
    }
  }

  // 整份一个字都没有 ⇒ 会渲染出一页只有标题的空白。宁可整份失败（日志里有原因、助手能重发）。
  if (sections.length === 0) {
    return {
      ok: false,
      failure: { code: 'htmlgen-content-too-thin', template, needs: spec.requires },
      detail: 'sections have no content',
    };
  }

  // 版式要的那一类内容没给（数据页没有数据、项目计划没有行动项……）。
  if (spec.requires.every((needed) => !presentKinds.has(needed))) {
    return {
      ok: false,
      failure: { code: 'htmlgen-content-too-thin', template, needs: spec.requires },
      detail: `template "${template}" needs one of: ${spec.requires.join(', ')}`,
    };
  }

  const request: HtmlgenRequest = { kind: HTMLGEN_KIND, title, lang, template, sections, sources };
  if (summary.text) request.summary = summary.text;
  return { ok: true, request };
}
