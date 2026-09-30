/**
 * PPTX 模板目录 —— **白名单的唯一真源**。
 *
 * 为什么要有这么一份东西：模板填充这条路要能放心让模型驱动，
 * 就必须让"模型能碰什么"是一个**闭集**。模型提交的是
 * `{ templateId, data }`，而 `templateId` 与 `data` 的每一个键都要在这里查得到 ——
 * 查不到就是拒绝，不是"忽略掉继续做"。
 *
 * 于是这条链上**结构上不可能**出现的东西（不需要我们额外检查）：
 *   · x/y/宽高   —— 协议里没有坐标字段，`data` 的值只能是字符串或有限数字
 *   · 颜色/字体  —— 同上，模板里的样式我们一个字节都不改
 *   · XML        —— 值只经 `textContent` 写入，见 fill.ts 的说明
 *   · 本地路径 / 远程 URL / Base64 图片 —— 没有图片字段，本轮也**不做图片**
 *
 * ⚠️ `shape` 是模板 pptx 里那个形状的 **`cNvPr name`，大小写敏感、一字不差**。
 *    它**不等于** token 名：token 是 `value_1`，形状是 `METRIC_1_VALUE`。
 *    这层映射没法靠大小写规则推出来，所以只能写死 ——
 *    而写死就会漂移，于是 `test/pptx-template-catalog.test.ts` 会**打开真实的模板文件**
 *    逐页断言："这个形状在那一页存在，且它里面的文字正好是 `{{这个 token}}`"。
 *    改模板、改这里、忘了改另一边，测试当场红。
 *
 * ⚠️ `slide` 是模板文件里的**页序号（1-based）**，同样由那个测试对着真文件钉住。
 *
 * 模板来源：`荣盈魔方-商务PPT模板库-v4.pptx`（自制，随包分发）。
 */

/** 模板集 id —— 可选的 `template` 字段唯一合法值。 */
export const PPTX_TEMPLATE_SET_ID = 'business-deck-v4';

/** 模板文件名（`<resources>/pptx-templates/` 下）。ASCII 名，避免跨平台大小写/编码的坑。 */
export const PPTX_TEMPLATE_FILE = 'business-deck-v4.pptx';

/**
 * **零页**根模板：只有母版 / 版式 / 主题，一页幻灯片都没有。
 *
 * 为什么需要它（两条都是实测踩出来的，见 fill.ts 的注释）：
 *  · 拿模板集本身当根，就得靠 `removeExistingSlides` 清掉它那 8 页，
 *    而那个开关只删 `p:sldIdLst` 条目、**部件留在包里** ⇒ 成品里 8 页带
 *    `{{占位符}}` 的孤儿；
 *  · 它同时把 `presentation.xml` 的根元素换成声明齐全的那一份，
 *    绕开"追加的 `p:sldId` 用了没声明的 `xmlns:r` ⇒ WPS 判 0 页"那个坑。
 *
 * 由 `resources/pptx-templates/README.md` 记的三步常态化产出。
 */
export const PPTX_BLANK_ROOT_FILE = 'blank-root.pptx';

export interface PptxTemplateTokenSpec {
  /** 模板里那个形状的名字（`cNvPr name`），大小写敏感。 */
  shape: string;
  /**
   * 该占位符允许的最大字符数。
   * 定它是为了**在填充前就拦住"一句话塞满一页"**，而不是等渲出来才发现溢出 ——
   * 模板的文本框是设计师定死的位置，装不下就是不装：我们不缩放、不裁切、不自动改字号。
   */
  maxLength: number;
  /** 缺省即"可以不给"：不给就写成空串（占位符必须被清掉，见 parse.ts）。 */
  required?: boolean;
  keepTemplateTextWhenEmpty?: boolean;
}

export interface PptxTemplateSpec {
  /** 模板页 id —— 模型在 `slides[].templateId` 里提交的就是它。 */
  id: string;
  /** 在模板文件里的页序号（**1-based**）。 */
  slide: number;
  /** 给人看的用途说明（进交付报告与技能文档）。 */
  purpose: string;
  /** 该页允许写的占位符：token 名 → 规格。 */
  tokens: Record<string, PptxTemplateTokenSpec>;
}

/** 正文类文本框的字符上限。 */
const BODY = 240;
/** 标题类文本框的字符上限 —— 模板里标题字号大、框窄，所以要短。 */
const TITLE = 60;
/** 一句话类（副标题、标签、负责人、日期）的字符上限。 */
const LABEL = 40;
/** 数字/指标值 —— 模板里字号最大，必须极短。 */
const VALUE = 16;

/** 反复出现的三件套（`slide_title` / `slide_subtitle` 在所有内页都一样）。 */
const SLIDE_HEAD = {
  slide_title: { shape: 'SLIDE_TITLE', maxLength: TITLE, required: true },
  slide_subtitle: { shape: 'SLIDE_SUBTITLE', maxLength: TITLE },
} satisfies Record<string, PptxTemplateTokenSpec>;

export const PPTX_TEMPLATES: Readonly<Record<string, PptxTemplateSpec>> = Object.freeze({
  cover: {
    id: 'cover',
    slide: 1,
    purpose: '封面：整份演示的第一页',
    tokens: {
      cover_title: { shape: 'COVER_TITLE', maxLength: TITLE, required: true },
      cover_subtitle: { shape: 'COVER_SUBTITLE', maxLength: TITLE },
      date: { shape: 'COVER_DATE', maxLength: LABEL },
      author: { shape: 'COVER_AUTHOR', maxLength: LABEL },
    },
  },
  section: {
    id: 'section',
    slide: 2,
    purpose: '章节页：给一段内容起头，交代这一节讲什么',
    tokens: {
      section_title: { shape: 'SECTION_TITLE', maxLength: TITLE, required: true },
      section_summary: { shape: 'SECTION_SUMMARY', maxLength: BODY },
      // 这格在模板里是两行上下文，不是负责人/日期那种单行短标签。
      // 真机投资路演的 47 字团队背景会自然落在这里；沿用 LABEL=40 会让整份 PPT
      // 在渲染前被拒。60 与同页标题上限一致，仍保留明确边界，避免塞入小作文。
      section_context: { shape: 'SECTION_CONTEXT', maxLength: TITLE },
    },
  },
  insight: {
    id: 'insight',
    slide: 3,
    purpose: '观点页：一个主结论 + 三条支撑证据',
    tokens: {
      ...SLIDE_HEAD,
      takeaway: { shape: 'TAKEAWAY', maxLength: BODY },
      evidence_1: { shape: 'EVIDENCE_1', maxLength: BODY },
      evidence_2: { shape: 'EVIDENCE_2', maxLength: BODY },
      evidence_3: { shape: 'EVIDENCE_3', maxLength: BODY },
    },
  },
  comparison: {
    id: 'comparison',
    slide: 4,
    purpose: '对比页：左右两栏对照（方案 A/B、改前/改后、我们/竞品）',
    tokens: {
      ...SLIDE_HEAD,
      left_title: { shape: 'LEFT_TITLE', maxLength: LABEL },
      right_title: { shape: 'RIGHT_TITLE', maxLength: LABEL },
      left_item_1: { shape: 'LEFT_ITEM_1', maxLength: BODY },
      right_item_1: { shape: 'RIGHT_ITEM_1', maxLength: BODY },
      left_item_2: { shape: 'LEFT_ITEM_2', maxLength: BODY },
      right_item_2: { shape: 'RIGHT_ITEM_2', maxLength: BODY },
      left_item_3: { shape: 'LEFT_ITEM_3', maxLength: BODY },
      right_item_3: { shape: 'RIGHT_ITEM_3', maxLength: BODY },
    },
  },
  metrics: {
    id: 'metrics',
    slide: 5,
    purpose: '数据页：三个关键指标 + 各自的标签与注脚',
    tokens: {
      ...SLIDE_HEAD,
      value_1: { shape: 'METRIC_1_VALUE', maxLength: VALUE, required: true },
      label_1: { shape: 'METRIC_1_LABEL', maxLength: LABEL, required: true },
      note_1: { shape: 'METRIC_1_NOTE', maxLength: LABEL },
      value_2: { shape: 'METRIC_2_VALUE', maxLength: VALUE },
      label_2: { shape: 'METRIC_2_LABEL', maxLength: LABEL },
      note_2: { shape: 'METRIC_2_NOTE', maxLength: LABEL },
      value_3: { shape: 'METRIC_3_VALUE', maxLength: VALUE },
      label_3: { shape: 'METRIC_3_LABEL', maxLength: LABEL },
      note_3: { shape: 'METRIC_3_NOTE', maxLength: LABEL },
      source_or_note: { shape: 'METRIC_SOURCE', maxLength: BODY },
    },
  },
  timeline: {
    id: 'timeline',
    slide: 6,
    purpose: '时间线页：最多五步的推进过程',
    tokens: {
      ...SLIDE_HEAD,
      step_1_title: { shape: 'STEP_1_TITLE', maxLength: LABEL, required: true },
      step_1_desc: { shape: 'STEP_1_DESC', maxLength: BODY },
      step_2_title: { shape: 'STEP_2_TITLE', maxLength: LABEL },
      step_2_desc: { shape: 'STEP_2_DESC', maxLength: BODY },
      step_3_title: { shape: 'STEP_3_TITLE', maxLength: LABEL },
      step_3_desc: { shape: 'STEP_3_DESC', maxLength: BODY },
      step_4_title: { shape: 'STEP_4_TITLE', maxLength: LABEL },
      step_4_desc: { shape: 'STEP_4_DESC', maxLength: BODY },
      step_5_title: { shape: 'STEP_5_TITLE', maxLength: LABEL },
      step_5_desc: { shape: 'STEP_5_DESC', maxLength: BODY },
    },
  },
  actions: {
    id: 'actions',
    slide: 7,
    purpose: '行动页：谁、在什么时候、做什么（最多四条）',
    tokens: {
      ...SLIDE_HEAD,
      action_header: { shape: 'ACTION_HEADER', maxLength: LABEL, keepTemplateTextWhenEmpty: true },
      owner_header: { shape: 'OWNER_HEADER', maxLength: LABEL, keepTemplateTextWhenEmpty: true },
      due_header: { shape: 'DUE_HEADER', maxLength: LABEL, keepTemplateTextWhenEmpty: true },
      action_1: { shape: 'ACTION_1', maxLength: BODY, required: true },
      owner_1: { shape: 'OWNER_1', maxLength: LABEL },
      due_1: { shape: 'DUE_1', maxLength: LABEL },
      action_2: { shape: 'ACTION_2', maxLength: BODY },
      owner_2: { shape: 'OWNER_2', maxLength: LABEL },
      due_2: { shape: 'DUE_2', maxLength: LABEL },
      action_3: { shape: 'ACTION_3', maxLength: BODY },
      owner_3: { shape: 'OWNER_3', maxLength: LABEL },
      due_3: { shape: 'DUE_3', maxLength: LABEL },
      action_4: { shape: 'ACTION_4', maxLength: BODY },
      owner_4: { shape: 'OWNER_4', maxLength: LABEL },
      due_4: { shape: 'DUE_4', maxLength: LABEL },
    },
  },
  closing: {
    id: 'closing',
    slide: 8,
    purpose: '结尾页：收束与下一步',
    tokens: {
      closing_title: { shape: 'CLOSING_TITLE', maxLength: TITLE, required: true },
      closing_message: { shape: 'CLOSING_MESSAGE', maxLength: BODY },
      contact_or_next_step: { shape: 'CLOSING_CONTACT', maxLength: LABEL },
    },
  },
});

/** 模板页 id 的闭集，**按模板文件里的页序**排列（报告与技能文档都按这个顺序列）。 */
export const PPTX_TEMPLATE_IDS: readonly string[] = Object.freeze(
  Object.values(PPTX_TEMPLATES)
    .slice()
    .sort((a, b) => a.slide - b.slide)
    .map((t) => t.id),
);

export function findPptxTemplate(id: string): PptxTemplateSpec | undefined {
  return Object.prototype.hasOwnProperty.call(PPTX_TEMPLATES, id) ? PPTX_TEMPLATES[id] : undefined;
}

/**
 * 页脚页码那个形状。
 *
 * ⚠️ **刻意不进 `tokens`**：页码不是内容，是**版式的一部分**。
 *    模板里那些 `FOOTER_PAGE_6 = "06"` 是死的 —— 它们记的是"我在模板文件里排第几"，
 *    而不是"我在你这副 deck 里排第几"。直接沿用会出现这种成品：
 *    一副 3 页的汇报（封面 + 时间线 + 行动），页脚印着 **01 / 06 / 07**。
 *    （这是靠 WPS 渲图审出来的，不是想出来的。）
 * ⇒ 由 `fill.ts` 按**输出位置**写，模型没有地方能碰它。
 */
const PAGE_NUMBER_SHAPE: Readonly<Record<string, string>> = Object.freeze({
  cover: 'COVER_INDEX',
  section: 'FOOTER_PAGE_2',
  insight: 'FOOTER_PAGE_3',
  comparison: 'FOOTER_PAGE_4',
  metrics: 'FOOTER_PAGE_5',
  timeline: 'FOOTER_PAGE_6',
  actions: 'FOOTER_PAGE_7',
  closing: 'CLOSING_INDEX',
});

export function pageNumberShapeFor(templateId: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(PAGE_NUMBER_SHAPE, templateId)
    ? PAGE_NUMBER_SHAPE[templateId]
    : undefined;
}
