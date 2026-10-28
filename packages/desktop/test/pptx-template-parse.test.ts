import { describe, expect, it } from 'vitest';
import { findPptxTemplate } from '../src/main/docgen/pptx-template/catalog';
import { parseTemplateDeck } from '../src/main/docgen/pptx-template/parse';

/**
 * 校验层：模型能提交什么、不能提交什么。
 *
 * 这一层的价值不在于"挡住了坏输入"，而在于**挡住的方式**：
 * 四类拒绝各有各的码，而且都把模型写的那个名字原样带回去 ——
 * 只说"模板不对"它没法改；说"我不认识 `tmeline`"，它一眼就看出自己拼错了。
 */

const COVER = { templateId: 'cover', data: { cover_title: '九月经营简报' } };

describe('parseTemplateDeck —— 合法输入', () => {
  it('最小合法输入：一页封面', () => {
    const result = parseTemplateDeck({ slides: [COVER] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.deck.slides).toHaveLength(1);
    expect(result.deck.slides[0].templateId).toBe('cover');
    expect(result.deck.slides[0].data.cover_title).toBe('九月经营简报');
  });

  it('可选的 template 字段：写对了接受', () => {
    expect(parseTemplateDeck({ template: 'business-deck-v4', slides: [COVER] }).ok).toBe(true);
  });

  it('没给的可选字段被补成空串（必须清掉模板里的 {{占位符}}）', () => {
    const result = parseTemplateDeck({ slides: [COVER] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const spec = findPptxTemplate('cover');
    // 目录里声明了几个 token，归一化后就该有几个键 —— 一个都不能少
    expect(Object.keys(result.deck.slides[0].data).sort()).toEqual(Object.keys(spec!.tokens).sort());
    expect(result.deck.slides[0].data.date).toBe('');
    expect(result.deck.slides[0].data.author).toBe('');
  });

  it('数字值被接受并转成字符串（指标字段的自然写法，不是"猜数"）', () => {
    const result = parseTemplateDeck({
      slides: [{ templateId: 'metrics', data: { slide_title: '指标', value_1: 12.4, label_1: '转化率' } }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.deck.slides[0].data.value_1).toBe('12.4');
  });

  it('值前后的空白与换行被压平成单行（模板的框按单行估过宽）', () => {
    const result = parseTemplateDeck({ slides: [{ templateId: 'cover', data: { cover_title: '  两\n行  ' } }] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.deck.slides[0].data.cover_title).toBe('两 行');
  });
});

describe('parseTemplateDeck —— 四种拒绝', () => {
  it('未知的 templateId ⇒ template-page-unknown，且把那个名字带回去', () => {
    const result = parseTemplateDeck({ slides: [{ templateId: 'tmeline', data: {} }] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toEqual({ code: 'template-page-unknown', format: 'pptx', page: 1, templateId: 'tmeline' });
  });

  it('未知字段 ⇒ template-field-unknown（不静默忽略：忽略了模型会以为写进去了）', () => {
    const result = parseTemplateDeck({ slides: [{ templateId: 'cover', data: { cover_titel: 'x' } }] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toEqual({
      code: 'template-field-unknown',
      format: 'pptx',
      page: 1,
      templateId: 'cover',
      field: 'cover_titel',
    });
  });

  it('拼错字段时先报"不认识"而不是"缺字段"（否则模型会去补一个不需要的）', () => {
    // cover_title 是必填；这里写成了 cover_titel ⇒ 两个问题同时成立
    const result = parseTemplateDeck({ slides: [{ templateId: 'cover', data: { cover_titel: 'x' } }] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('template-field-unknown');
  });

  it('必填字段缺了 ⇒ template-field-missing', () => {
    const result = parseTemplateDeck({ slides: [{ templateId: 'cover', data: { cover_subtitle: '只有副标题' } }] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toEqual({
      code: 'template-field-missing',
      format: 'pptx',
      page: 1,
      templateId: 'cover',
      field: 'cover_title',
    });
  });

  it('必填字段只给了空白 ⇒ 也算缺（不是"给了个空字符串就算有"）', () => {
    const result = parseTemplateDeck({ slides: [{ templateId: 'cover', data: { cover_title: '   ' } }] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('template-field-missing');
  });

  it('超长 ⇒ template-field-too-long，且带上真正的上限（提示里那个数字必须是真的）', () => {
    const spec = findPptxTemplate('cover')!;
    const limit = spec.tokens.cover_title.maxLength;
    const result = parseTemplateDeck({
      slides: [{ templateId: 'cover', data: { cover_title: '字'.repeat(limit + 1) } }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toEqual({
      code: 'template-field-too-long',
      format: 'pptx',
      page: 1,
      templateId: 'cover',
      field: 'cover_title',
      maxChars: limit,
    });
  });

  it('刚好到上限是允许的（边界不能差一）', () => {
    const spec = findPptxTemplate('cover')!;
    const atLimit = '字'.repeat(spec.tokens.cover_title.maxLength);
    expect(parseTemplateDeck({ slides: [{ templateId: 'cover', data: { cover_title: atLimit } }] }).ok).toBe(true);
  });

  it('⭐ 真机团队背景 47 字能放进章节上下文，不因沿用短标签上限整份拒绝', () => {
    const sectionContext = '核心团队平均从业经验8年以上，曾在头部餐饮集团/互联网平台担任管理职位，具备从0到1的创业经验';
    expect(sectionContext.length).toBe(47);
    expect(
      parseTemplateDeck({
        slides: [{ templateId: 'section', data: { section_title: '团队介绍', section_context: sectionContext } }],
      }).ok,
    ).toBe(true);
  });

  it('页码按 slides 数组从 1 数（助手手里就是那个数组，不用自己减一）', () => {
    const result = parseTemplateDeck({ slides: [COVER, { templateId: 'nope', data: {} }] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toMatchObject({ code: 'template-page-unknown', page: 2 });
  });
});

describe('parseTemplateDeck —— 形状不对的输入', () => {
  it.each([
    ['null', null],
    ['数组', []],
    ['没有 slides', { template: 'business-deck-v4' }],
    ['slides 是空的', { slides: [] }],
    ['slides 不是数组', { slides: 'cover' }],
    ['某一页不是对象', { slides: ['cover'] }],
    ['data 是数组', { slides: [{ templateId: 'cover', data: [] }] }],
    ['template 名字不认识', { template: 'someone-elses-deck', slides: [COVER] }],
  ])('%s ⇒ request-invalid', (_name, input) => {
    const result = parseTemplateDeck(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toEqual({ code: 'request-invalid' });
  });

  it.each([
    ['对象', { a: 1 }],
    ['数组', [1, 2]],
    ['布尔', true],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('字段值是 %s ⇒ 拒绝（只认字符串和有限数字）', (_name, value) => {
    const result = parseTemplateDeck({ slides: [{ templateId: 'cover', data: { cover_title: value } }] });
    expect(result.ok).toBe(false);
  });
});

/**
 * **结构上不可能**提交的东西。
 *
 * 这几条不是"我们检查了一下有没有越界"，而是**协议里根本没有这些字段**：
 * `data` 的值只能是字符串或有限数字，别的形状一律拒。
 * 所以样式/坐标/XML 这些**没有地方可以写**。
 */
describe('协议里没有样式、坐标、XML 的位置', () => {
  it.each([
    ['坐标', { x: 1, y: 2, w: 3, h: 4 }],
    ['颜色', { color: '#ff0000' }],
    ['字体', { font: 'Arial' }],
    ['图片', { image: 'data:image/png;base64,AAAA' }],
    ['本地路径', { path: 'C:\\Windows\\win.ini' }],
  ])('%s 写进 data 只会被判成"未知字段"，不会变成样式', (_name, extra) => {
    const result = parseTemplateDeck({ slides: [{ templateId: 'cover', data: { cover_title: 'x', ...extra } }] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // 报的是"这个键我不认识"，而不是"这个键的值不合法" ——
    // 因为从协议上看它就是多余的，不是格式不对。
    expect(result.failure.code).toBe('template-field-unknown');
  });
});
