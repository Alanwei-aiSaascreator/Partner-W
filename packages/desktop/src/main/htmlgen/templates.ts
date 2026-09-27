import { HTML_PREVIEW_CSP } from '../preview/html-csp.js';
import { escapeHtml } from '../util/html-escape.js';
import type { HtmlgenRequest, HtmlgenSection, HtmlgenTemplate } from './request.js';

/**
 * **把结构化内容排成一份网页**（htmlgen 的渲染层）。
 *
 * ## 这条通道存在的理由，就是这个文件
 *
 * 用户的原话是现有 PPT"质量好差"，因为那条路是"在坐标上画元素、没有排版引擎"。
 * 网页这条路的全部优势就是**浏览器会替我们排版** —— 所以这份 CSS 必须真的用上它：
 * 字号层级、行高、留白节奏、栅格、卡片、表格、`@media print`、中文字体栈。
 * 排成"白底黑字一列到底"等于把这条路唯一的优势扔了。
 *
 * ## 三条硬约束（不是风格问题）
 *
 *  1. **不能依赖脚本**：`sandbox=""` 的 iframe 里脚本一行都不跑。所以版式全靠 CSS
 *     （栅格、计数器、`break-inside`），没有一行 JS。
 *  2. **不能引用任何外部资源**：CSP 是 `default-src 'none'`，外链字体/图片/样式全会被挡。
 *     所以样式内联、字体用**系统栈**（不内嵌、不外链）、**一个图片都没有**（本轮不接图片）。
 *  3. **助手写的东西逐字转义**：它给的是数据，不是标记。
 *
 * ⚠️ **一个装饰性文字都不放**（没有"来源""负责人""摘要"这类小标题）：它们是**模板自己的**
 *    文字，会跟内容的 `lang` 打架（一份 `lang="en"` 的页面里冒出中文标签）。
 *    版式的差异靠配色、留白、栅格、区块顺序与编号，**不靠文字** ——
 *    这样任何语言的文档都排得对。
 */

/**
 * 产出体积上限。
 *
 * ⚠️ 为什么必须有：产物要能走**富预览**（`iframe sandbox srcdoc`），而那条路的上限是
 *    `MAX_HTML_PREVIEW_BYTES`(4 MiB) —— 超了用户拿到的是一份只能当纯文本看的文件，
 *    等于这条路白做。取 3 MiB 是给 CSP、未来加的版式留余量。
 *
 * ⚠️ 超限**抛**（不是截断）：截断会让用户拿到一份**内容不全**的页面而不知道少了什么，
 *    那比"没生成 + 一句可读原因"糟得多。
 */
export const MAX_HTMLGEN_OUTPUT_BYTES = 3 * 1024 * 1024;

/** 产出超上限。带 `size` 是为了界面能说出"排出来有多大"。 */
export class HtmlgenOutputTooLargeError extends Error {
  readonly size: number;
  readonly maxBytes: number;

  constructor(size: number, maxBytes: number) {
    super('htmlgen output too large');
    this.name = 'HtmlgenOutputTooLargeError';
    this.size = size;
    this.maxBytes = maxBytes;
  }
}

/** 每种版式的视觉身份。 */
interface TemplateStyle {
  /** 主色。**只在这里定**：样式表里其余地方一律引用 `var(--accent)`。 */
  accent: string;
  /** 主色的浅底（用在摘要条、表头、卡片边）。**写成 rgb() 而不是 color-mix()**： */
  /** 后者在老一点的 Chromium/WPS 里不认，而这是要发出去的文件。 */
  wash: string;
  /** 加在 `<body>` 上的类名，用来给这个版式开小灶。 */
  bodyClass: string;
  /** 小节要不要编号（CSS 计数器，不依赖脚本）。 */
  numbered: boolean;
  /** 小节的呈现顺序（同一类内部保持助手给的顺序）。 */
  order: readonly HtmlgenSection['kind'][];
}

/**
 * 五个版式。名字是 ascii 短词（助手照着写、用户照着转述），含义写在技能正文里。
 *
 * ⚠️ 差异必须是**看得见**的：只换个色号不算另一种版式。所以每个版式同时定了
 *    配色、区块顺序、编号、以及**哪一块被放大**（数据页放大指标、项目计划放大行动项、
 *    方案页把行动项排成编号步骤）。
 */
const TEMPLATE_STYLES: Readonly<Record<HtmlgenTemplate, TemplateStyle>> = Object.freeze({
  // 网页报告：结论先行，小节编号，指标/表格/行动项按阅读顺序排下来。
  brief: {
    accent: '#3b5bdb',
    wash: 'rgba(59, 91, 219, 0.08)',
    bodyClass: 'tpl-brief',
    numbered: true,
    order: ['narrative', 'metrics', 'table', 'actions'],
  },
  // 方案页：主张单独成一条 lead，行动项排成编号步骤（"就这样做"的读法）。
  proposal: {
    accent: '#0f766e',
    wash: 'rgba(15, 118, 110, 0.09)',
    bodyClass: 'tpl-proposal',
    numbered: false,
    order: ['narrative', 'actions', 'metrics', 'table'],
  },
  // 调研简报：先把话说清楚，再给数据；不编号（读起来像一篇简报）。
  research: {
    accent: '#334155',
    wash: 'rgba(51, 65, 85, 0.07)',
    bodyClass: 'tpl-research',
    numbered: false,
    order: ['narrative', 'metrics', 'table', 'actions'],
  },
  // 项目计划：**行动项置顶**并放大（谁、什么时候），背景与依据排在后面。
  plan: {
    accent: '#b45309',
    wash: 'rgba(180, 83, 9, 0.09)',
    bodyClass: 'tpl-plan',
    numbered: true,
    order: ['actions', 'narrative', 'metrics', 'table'],
  },
  // 数据页：**指标置顶并放大**，表格紧随其后，文字退到最后。
  data: {
    accent: '#6d28d9',
    wash: 'rgba(109, 40, 217, 0.08)',
    bodyClass: 'tpl-data',
    numbered: false,
    order: ['metrics', 'table', 'narrative'],
  },
});

/**
 * 整套样式。**中文字体走系统栈**：不内嵌（包体 +15~20MB、商用授权另谈）、
 * 不外链（CSP 会挡，而且离线就没了）。四个候选覆盖 Windows / macOS / Linux 的主流安装。
 */
const STYLE = `
*, *::before, *::after { box-sizing: border-box; }
:root {
  --accent: __ACCENT__;
  --wash: __WASH__;
  --ink: #171a21;
  --ink-2: #3f4757;
  --ink-3: #6b7280;
  --line: #e4e7ee;
  --line-soft: #f1f3f8;
  --surface: #ffffff;
  --canvas: #f4f5f8;
  --radius: 14px;
}
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--canvas);
  color: var(--ink);
  font-family: "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC",
               "Source Han Sans SC", "Source Han Sans CN", "WenQuanYi Micro Hei",
               system-ui, -apple-system, "Segoe UI", Arial, sans-serif;
  font-size: 16px;
  line-height: 1.75;
  text-rendering: optimizeLegibility;
}
.page {
  max-width: 56rem;
  margin: 0 auto;
  background: var(--surface);
  box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04), 0 18px 40px -24px rgba(16, 24, 40, 0.22);
}
/* ── 头部 ────────────────────────────────────────────────────────────── */
.hero { padding: 3rem 3rem 2.25rem; border-bottom: 1px solid var(--line); }
.hero-rule { width: 3rem; height: 4px; border-radius: 2px; background: var(--accent); margin: 0 0 1.5rem; }
h1 {
  margin: 0;
  font-size: 2rem;
  line-height: 1.32;
  font-weight: 700;
  letter-spacing: -0.01em;
  /* 长标题（含长英文词）不撑破版心 */
  overflow-wrap: break-word;
}
.summary {
  margin: 1.5rem 0 0;
  padding: 1rem 1.25rem;
  background: var(--wash);
  border-left: 3px solid var(--accent);
  border-radius: 0 10px 10px 0;
  color: var(--ink-2);
  font-size: 1rem;
  white-space: pre-wrap;
}
/* 方案页：主张要像"一句话立场"，不是脚注 */
.tpl-proposal .summary { font-size: 1.0625rem; line-height: 1.7; padding: 1.25rem 1.5rem; }
/* 调研简报：摘要收着一点，让正文更像正文 */
.tpl-research .summary { background: transparent; border-left-width: 2px; padding: 0.25rem 0 0.25rem 1rem; }
/* ── 正文 ────────────────────────────────────────────────────────────── */
main { padding: 2.5rem 3rem 0; display: flex; flex-direction: column; gap: 2.75rem; counter-reset: sec; }
.block > h2 {
  margin: 0 0 1rem;
  font-size: 1.25rem;
  line-height: 1.5;
  font-weight: 700;
  letter-spacing: -0.005em;
  overflow-wrap: break-word;
}
.block-titled > h2 { padding-bottom: 0.625rem; border-bottom: 1px solid var(--line); }
.numbered .block-titled > h2::before {
  counter-increment: sec;
  content: counter(sec) "  ";
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}
.narrative p { margin: 0 0 0.875rem; white-space: pre-wrap; overflow-wrap: break-word; }
.narrative p:last-child { margin-bottom: 0; }
.narrative ul { margin: 1rem 0 0; padding-left: 1.375rem; }
.narrative li { margin: 0.375rem 0; overflow-wrap: break-word; }
.narrative li::marker { color: var(--accent); }
/* ── 指标卡 ──────────────────────────────────────────────────────────── */
.metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); gap: 0.875rem; }
.metric {
  padding: 1rem 1.125rem 1.125rem;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
}
.metric-label { font-size: 0.8125rem; color: var(--ink-3); }
.metric-value {
  margin-top: 0.25rem;
  font-size: 1.75rem;
  font-weight: 700;
  line-height: 1.25;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
  overflow-wrap: break-word;
}
.metric-detail { margin-top: 0.375rem; font-size: 0.8125rem; color: var(--ink-3); }
/* 数据页：指标是主角，再大一档 */
.tpl-data .metrics { grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); }
.tpl-data .metric-value { font-size: 2.25rem; }
.tpl-data .metric { border-left: 3px solid var(--accent); }
/* 项目计划：指标是背景板，退一档 */
.tpl-plan .metric-value { font-size: 1.5rem; }
/* ── 表格 ────────────────────────────────────────────────────────────── */
.table-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: var(--radius); }
table { width: 100%; border-collapse: collapse; font-size: 0.9375rem; }
caption { caption-side: top; text-align: left; padding: 0 0 0.75rem; color: var(--ink-3); font-size: 0.875rem; }
thead th {
  background: var(--line-soft);
  text-align: left;
  font-weight: 600;
  padding: 0.6875rem 0.875rem;
  border-bottom: 1px solid var(--line);
  white-space: nowrap;
}
tbody td {
  padding: 0.6875rem 0.875rem;
  border-bottom: 1px solid var(--line-soft);
  vertical-align: top;
  font-variant-numeric: tabular-nums;
  overflow-wrap: break-word;
}
tbody tr:nth-child(even) { background: #fafbfd; }
tbody tr:last-child td { border-bottom: 0; }
/* 数据页：表格是主角，给它强调色的表头 */
.tpl-data thead th { background: var(--wash); }
/* ── 行动项 ──────────────────────────────────────────────────────────── */
.actions { display: flex; flex-direction: column; gap: 0.75rem; }
.action {
  padding: 1rem 1.25rem 1.125rem;
  border: 1px solid var(--line);
  border-left: 3px solid var(--accent);
  border-radius: 0 var(--radius) var(--radius) 0;
}
.action-title { font-weight: 600; overflow-wrap: break-word; }
.action-detail { margin-top: 0.3125rem; color: var(--ink-2); font-size: 0.9375rem; white-space: pre-wrap; }
.chips { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.75rem; }
.chip {
  font-size: 0.8125rem;
  line-height: 1.6;
  padding: 0.0625rem 0.625rem;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--ink-3);
}
.chip-due { background: var(--line-soft); font-variant-numeric: tabular-nums; }
/* 方案页：行动项是"步骤"，带序号 */
.tpl-proposal .actions { counter-reset: step; gap: 0.875rem; }
.tpl-proposal .action { position: relative; padding-left: 3.25rem; }
.tpl-proposal .action::before {
  counter-increment: step;
  content: counter(step);
  position: absolute;
  left: 1.125rem;
  top: 1rem;
  width: 1.5rem;
  height: 1.5rem;
  border-radius: 50%;
  background: var(--wash);
  color: var(--accent);
  font-size: 0.8125rem;
  font-weight: 700;
  line-height: 1.5rem;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
/* 项目计划：行动项放大（谁、什么时候） */
.tpl-plan .action { border-left-width: 4px; padding: 1.125rem 1.25rem 1.25rem; }
.tpl-plan .action-title { font-size: 1.0625rem; }
/* ── 来源 ────────────────────────────────────────────────────────────── */
.sources {
  margin: 3rem 3rem 2.5rem;
  padding-top: 1.25rem;
  border-top: 1px solid var(--line);
  color: var(--ink-3);
  font-size: 0.8125rem;
}
.sources ul { margin: 0; padding: 0; list-style: none; display: flex; flex-wrap: wrap; gap: 0.375rem 1.5rem; }
.sources li { display: flex; flex-wrap: wrap; gap: 0.375rem; }
.source-note { color: var(--ink-3); opacity: 0.85; }
/* ── 窄屏 ────────────────────────────────────────────────────────────── */
@media (max-width: 720px) {
  .hero { padding: 2rem 1.25rem 1.5rem; }
  h1 { font-size: 1.5rem; }
  main { padding: 1.75rem 1.25rem 0; gap: 2rem; }
  .sources { margin: 2rem 1.25rem 1.75rem; }
  .tpl-proposal .action { padding-left: 1.25rem; }
  .tpl-proposal .action::before { position: static; display: inline-block; margin-bottom: 0.375rem; }
}
/* ── 打印 ────────────────────────────────────────────────────────────── */
@media print {
  @page { size: A4; margin: 16mm 14mm; }
  body { background: #ffffff; font-size: 11pt; line-height: 1.65; }
  .page { max-width: none; margin: 0; box-shadow: none; }
  .hero { padding: 0 0 1.25rem; }
  main { padding: 1.5rem 0 0; gap: 1.75rem; }
  .sources { margin: 2rem 0 0; }
  /* 卡片/小节不跨页断开 —— 断在半张卡上比多一页难读得多 */
  .block, .metric, .action, .table-wrap, .summary, .sources li { break-inside: avoid; }
  /* 长表跨页时表头重复（靠浏览器自己做不到） */
  thead { display: table-header-group; }
  tr { break-inside: avoid; }
  .table-wrap { overflow: visible; }
  h1, h2 { break-after: avoid; }
}
`;

/**
 * 把 `<style>` 里那两个占位符换成这个版式的颜色。
 *
 * ⚠️ 用**替换**而不是字符串拼接：这份 CSS 里有几百个 `{` `}`，拼进去一个模板字符串
 *    就得转义一遍，而出错的样子是"样式整段失效"（页面还能看，只是很丑）——
 *    那种坏法没人会立刻发现。占位符只有两个、而且长得很显眼。
 */
function styleFor(template: HtmlgenTemplate): string {
  const style = TEMPLATE_STYLES[template];
  return STYLE.replace('__ACCENT__', style.accent).replace('__WASH__', style.wash);
}

function renderNarrative(section: Extract<HtmlgenSection, { kind: 'narrative' }>): string {
  const paragraphs = section.paragraphs.map((text) => `<p>${escapeHtml(text)}</p>`).join('');
  const bullets =
    section.bullets.length > 0
      ? `<ul>${section.bullets.map((text) => `<li>${escapeHtml(text)}</li>`).join('')}</ul>`
      : '';
  return `<div class="narrative">${paragraphs}${bullets}</div>`;
}

function renderMetrics(section: Extract<HtmlgenSection, { kind: 'metrics' }>): string {
  const cards = section.items
    .map((item) => {
      const detail = item.detail ? `<div class="metric-detail">${escapeHtml(item.detail)}</div>` : '';
      // ⚠️ 值不解析成数字：`12.4%`、`1.2 万`、`A/B` 都要原样显示，所以它整段是文本。
      return `<div class="metric"><div class="metric-label">${escapeHtml(item.label)}</div><div class="metric-value">${escapeHtml(item.value)}</div>${detail}</div>`;
    })
    .join('');
  return `<div class="metrics">${cards}</div>`;
}

function renderTable(section: Extract<HtmlgenSection, { kind: 'table' }>): string {
  const caption = section.caption ? `<caption>${escapeHtml(section.caption)}</caption>` : '';
  const head = section.columns.map((text) => `<th scope="col">${escapeHtml(text)}</th>`).join('');
  const body = section.rows
    .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`)
    .join('');
  return `<div class="table-wrap"><table>${caption}<thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function renderActions(section: Extract<HtmlgenSection, { kind: 'actions' }>): string {
  const items = section.items
    .map((item) => {
      const detail = item.detail ? `<div class="action-detail">${escapeHtml(item.detail)}</div>` : '';
      // ⚠️ 两个 chip **不带文字标签**（"负责人"/"截止"是模板自己的字，会跟文档的 lang 打架）：
      //    顺序固定为先 owner 后 due，两种样式不同，而助手写的值本身就自解释（"待定"/"本周五"）。
      const chips: string[] = [];
      if (item.owner) chips.push(`<span class="chip">${escapeHtml(item.owner)}</span>`);
      if (item.due) chips.push(`<span class="chip chip-due">${escapeHtml(item.due)}</span>`);
      const chipRow = chips.length > 0 ? `<div class="chips">${chips.join('')}</div>` : '';
      return `<div class="action"><div class="action-title">${escapeHtml(item.title)}</div>${detail}${chipRow}</div>`;
    })
    .join('');
  return `<div class="actions">${items}</div>`;
}

function renderSectionBody(section: HtmlgenSection): string {
  switch (section.kind) {
    case 'narrative':
      return renderNarrative(section);
    case 'metrics':
      return renderMetrics(section);
    case 'table':
      return renderTable(section);
    case 'actions':
      return renderActions(section);
  }
}

function renderSection(section: HtmlgenSection): string {
  const heading = section.heading ? `<h2>${escapeHtml(section.heading)}</h2>` : '';
  const classes = ['block', section.heading ? 'block-titled' : ''].filter(Boolean).join(' ');
  return `<section class="${classes}">${heading}${renderSectionBody(section)}</section>`;
}

/** 按版式的顺序重排小节（同一类内部保持助手给的顺序 —— 稳定排序）。 */
function orderSections(sections: readonly HtmlgenSection[], order: readonly HtmlgenSection['kind'][]): HtmlgenSection[] {
  const rank = new Map(order.map((kind, index) => [kind, index]));
  return sections
    .map((section, index) => ({ section, index }))
    .sort((a, b) => {
      const left = rank.get(a.section.kind) ?? order.length;
      const right = rank.get(b.section.kind) ?? order.length;
      return left === right ? a.index - b.index : left - right;
    })
    .map((entry) => entry.section);
}

function renderSources(request: HtmlgenRequest): string {
  if (request.sources.length === 0) return '';
  const items = request.sources
    .map((source) => {
      const note = source.note ? `<span class="source-note">${escapeHtml(source.note)}</span>` : '';
      return `<li><span class="source-label">${escapeHtml(source.label)}</span>${note}</li>`;
    })
    .join('');
  return `<footer class="sources"><ul>${items}</ul></footer>`;
}

/**
 * 渲染成一份**离线自包含**的 HTML。
 *
 * ⚠️ 自带 CSP（与应用预览时注入的是**同一份**）：用户把文件拷到浏览器里打开时，
 *    那道锁跟着文件走 —— 这份文件里本来就没有脚本，但万一将来模板改坏了，
 *    浏览器那一侧仍然拦得住。
 */
export function buildHtmlgenHtml(request: HtmlgenRequest): string {
  const style = TEMPLATE_STYLES[request.template];
  const summary = request.summary ? `<p class="summary">${escapeHtml(request.summary)}</p>` : '';
  const body = orderSections(request.sections, style.order).map(renderSection).join('');

  const html = `<!doctype html>
<html lang="${request.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}">
<title>${escapeHtml(request.title)}</title>
<style>${styleFor(request.template)}</style>
</head>
<body class="${style.bodyClass}">
<div class="page">
<header class="hero"><div class="hero-rule"></div><h1>${escapeHtml(request.title)}</h1>${summary}</header>
<main${style.numbered ? ' class="numbered"' : ''}>${body}</main>
${renderSources(request)}
</div>
</body>
</html>
`;

  const size = Buffer.byteLength(html, 'utf8');
  if (size > MAX_HTMLGEN_OUTPUT_BYTES) throw new HtmlgenOutputTooLargeError(size, MAX_HTMLGEN_OUTPUT_BYTES);
  return html;
}

/** 渲染入口：与 `docgen` 的四个渲染器同形（`Promise<Buffer>`）—— 落盘那条路不关心格式。 */
export async function renderHtmlgenDocument(request: HtmlgenRequest): Promise<Buffer> {
  return Buffer.from(buildHtmlgenHtml(request), 'utf8');
}
