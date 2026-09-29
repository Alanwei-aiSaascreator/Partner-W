import type { DocgenPptxRequest, DocgenSlide } from '../request.js';
import { parseTemplateDeck, type TemplateSlideSpec } from './parse.js';

const MAX_FALLBACK_BULLET_CHARS = 56;
const MAX_FALLBACK_BULLETS_PER_PAGE = 5;
// 模板请求最多 60 页；单页最宽的 comparison 在每个 BODY 字段都取上限、
// 且又恰好在句读处提前断行时，会拆成约 11 页。900 不是任意放宽，而是对现有
// 目录上限的封顶：保证“已经合法的模板输入”不会因保底页数反而零产物。
const MAX_FALLBACK_PAGES = 900;

const FALLBACK_PAGE_TITLES: Readonly<Record<string, string>> = Object.freeze({
  cover: '封面信息',
  section: '章节概要',
  insight: '核心观点',
  comparison: '方案对比',
  metrics: '关键指标',
  timeline: '推进计划',
  actions: '执行事项',
  closing: '结语与下一步',
});

function text(slide: TemplateSlideSpec, key: string): string {
  return slide.data[key]?.trim() ?? '';
}

function pageTitle(slide: TemplateSlideSpec): string {
  return FALLBACK_PAGE_TITLES[slide.templateId] ?? '演示内容';
}

/** 保底版不再依赖模板坐标，但用中文标签保留原字段的语义。 */
function tokenLabel(token: string): string {
  const exact: Readonly<Record<string, string>> = {
    cover_title: '封面标题',
    cover_subtitle: '封面副标题',
    date: '日期',
    author: '作者',
    section_title: '章节标题',
    section_summary: '章节摘要',
    section_context: '章节背景',
    slide_title: '页标题',
    slide_subtitle: '页副标题',
    takeaway: '核心结论',
    source_or_note: '数据来源或备注',
    closing_title: '结语标题',
    closing_message: '结语',
    contact_or_next_step: '联系方式或下一步',
    left_title: '左侧标题',
    right_title: '右侧标题',
  };
  if (exact[token]) return exact[token];

  const numbered = token.match(/^(evidence|left_item|right_item|value|label|note|action|owner|due)_(\d+)$/);
  if (numbered) {
    const names: Readonly<Record<string, string>> = {
      evidence: '支撑依据',
      left_item: '左侧要点',
      right_item: '右侧要点',
      value: '指标值',
      label: '指标名',
      note: '指标备注',
      action: '行动',
      owner: '负责人',
      due: '时间',
    };
    return `${names[numbered[1]] ?? numbered[1]} ${numbered[2]}`;
  }

  const step = token.match(/^step_(\d+)_(title|desc)$/);
  if (step) return `第 ${step[1]} 步${step[2] === 'title' ? '标题' : '说明'}`;
  return token;
}

function pageLines(slide: TemplateSlideSpec): string[] {
  // 解析层已按 catalog 顺序归一化并补齐了所有键。这里逐键遍历，比手写“哪些字段属于
  // 哪种页”更可靠：目录日后加占位符时，保底版不会静默吞字。
  return Object.entries(slide.data)
    .filter(([, value]) => value.trim().length > 0)
    .map(([token, value]) => `${tokenLabel(token)}：${value.trim()}`);
}

function splitReadable(textValue: string): string[] {
  const chars = Array.from(textValue.trim());
  if (chars.length <= MAX_FALLBACK_BULLET_CHARS) return chars.length > 0 ? [chars.join('')] : [];

  const out: string[] = [];
  let rest = chars;
  while (rest.length > MAX_FALLBACK_BULLET_CHARS) {
    let cut = MAX_FALLBACK_BULLET_CHARS;
    const floor = Math.floor(MAX_FALLBACK_BULLET_CHARS * 0.55);
    for (let index = MAX_FALLBACK_BULLET_CHARS; index >= floor; index -= 1) {
      if (/[，。；、：,.!?！？]/u.test(rest[index - 1] ?? '')) {
        cut = index;
        break;
      }
    }
    out.push(rest.slice(0, cut).join('').trim());
    rest = rest.slice(cut);
  }
  const tail = rest.join('').trim();
  if (tail) out.push(tail);
  return out.filter(Boolean);
}

function slidesFor(source: TemplateSlideSpec): DocgenSlide[] {
  const title = pageTitle(source);
  const bullets = pageLines(source).flatMap(splitReadable);
  if (bullets.length === 0) return [{ title, bullets: [] }];

  const slides: DocgenSlide[] = [];
  for (let offset = 0; offset < bullets.length; offset += MAX_FALLBACK_BULLETS_PER_PAGE) {
    const continuation = offset === 0 ? '' : `（续 ${Math.floor(offset / MAX_FALLBACK_BULLETS_PER_PAGE) + 1}）`;
    slides.push({
      title: `${title}${continuation}`,
      bullets: bullets.slice(offset, offset + MAX_FALLBACK_BULLETS_PER_PAGE),
    });
  }
  return slides;
}

/**
 * 模板引擎自身失败时的**保底转换**。
 *
 * 只接收已经能通过模板目录校验的数据；字段名、必填项或长度本身有问题时仍返回 `null`，
 * 不把内容错误伪装成模板故障。保底仍由 `renderPptx` 做版面检查，绝不产出溢出的坏文件。
 */
export function templateDeckFallbackRequest(title: string, raw: unknown): DocgenPptxRequest | null {
  const parsed = parseTemplateDeck(raw);
  if (!parsed.ok) return null;

  const cover = parsed.deck.slides.find((slide) => slide.templateId === 'cover');
  const slides = parsed.deck.slides.flatMap(slidesFor);
  if (slides.length > MAX_FALLBACK_PAGES) return null;

  // 模板允许 60 个全角字的封面标题，而现画版的大字封面不能容纳这么多。
  // 封面仅显示一个可读的短标题，完整原文已在上面的“封面信息”页逐字保留。
  const fullCoverTitle = cover ? text(cover, 'cover_title') : title;
  // A legal template title may contain explicit newlines.  PptxGenJS treats
  // those as real line breaks, so a short string can still overflow the large
  // one-line fallback cover.  Flatten whitespace only for the cover display;
  // the complete original value remains in the labelled content slide.
  const flatCoverTitle = (fullCoverTitle || title).replace(/\s+/gu, ' ').trim();
  const coverChars = Array.from(flatCoverTitle);
  const safeCoverTitle =
    coverChars.length > 18 ? `${coverChars.slice(0, 18).join('')}…` : coverChars.join('') || '演示文稿';

  return {
    kind: 'pptx',
    title: safeCoverTitle,
    subtitle: '可编辑兼容版',
    slides,
  };
}
