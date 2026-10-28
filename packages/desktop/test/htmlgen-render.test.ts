/**
 * `htmlgen` 的**渲染层**（2026-09-27）。
 *
 * ## 这个文件在测什么
 *
 * 这个通道存在的理由是"网页有**浏览器排版引擎**"（用户对现有 PPT 的原话是"质量好差"，
 * 因为那条路是"在坐标上画元素"）。所以判据分三组：
 *
 *  1. **安全**：产出的页面里没有脚本、没有任何外部引用、助手写的内容逐字转义 ——
 *     因为这份 HTML 要进 `sandbox=""` 的 iframe，且 CSP 是 `default-src 'none'`；
 *  2. **能用**：产出必须落在富预览的体积预算内（否则用户拿到的是纯文本视图）；
 *  3. **好看**：真的用了排版引擎（字号层级 / 栅格 / 卡片 / 表格 / `@media print` /
 *     中文字体栈），五个版式之间有**看得见**的差异 —— 不是"白底黑字一列到底"。
 */
import { describe, expect, it } from 'vitest';
import type { HtmlgenTemplate } from '@clawwork/shared';
import { MAX_HTML_PREVIEW_BYTES } from '../src/main/preview/build-preview.js';
import { HTML_PREVIEW_CSP } from '../src/main/preview/html-csp.js';
import { HTMLGEN_LIMITS, parseHtmlgenRequest } from '../src/main/htmlgen/request.js';
import {
  HtmlgenOutputTooLargeError,
  MAX_HTMLGEN_OUTPUT_BYTES,
  buildHtmlgenHtml,
  renderHtmlgenDocument,
} from '../src/main/htmlgen/templates.js';

/** 一份内容齐全的合法请求（直接构造，绕开解析器 —— 解析层由另一个文件负责）。 */
function request(template: HtmlgenTemplate, overrides: Record<string, unknown> = {}) {
  return {
    kind: 'html' as const,
    title: '九月经营简报',
    lang: 'zh-CN' as const,
    template,
    summary: '本月最重要的结论。',
    sections: [
      { kind: 'narrative' as const, heading: '核心判断', paragraphs: ['增长来自复购。'], bullets: ['老客贡献七成'] },
      {
        kind: 'metrics' as const,
        heading: '关键指标',
        items: [{ label: '转化率', value: '12.4%', detail: '较上月 +1.8pp' }],
      },
      {
        kind: 'table' as const,
        heading: '渠道表现',
        caption: '近 30 天',
        columns: ['渠道', '线索', '成交'],
        rows: [['私域', '120', '18']],
      },
      {
        kind: 'actions' as const,
        heading: '下一步',
        items: [{ title: '本周动作', detail: '把复购券发出去', owner: '待定', due: '本周五' }],
      },
    ],
    sources: [{ label: '内部经营数据', note: '统计口径截至 2026-09-27' }],
    ...overrides,
  };
}

const ALL_TEMPLATES: HtmlgenTemplate[] = ['brief', 'proposal', 'research', 'plan', 'data'];

describe('htmlgen 渲染：五个版式都排得出来', () => {
  it('每种版式都产出完整文档（doctype / lang / 标题 / 正文 / 样式）', () => {
    for (const template of ALL_TEMPLATES) {
      const html = buildHtmlgenHtml(request(template));

      expect(html.startsWith('<!doctype html>'), template).toBe(true);
      expect(html).toContain('<html lang="zh-CN">');
      // ⚠️ 编码与视口是**这份文件能不能被浏览器正确读出来**的前提，不是可选装饰：
      //    少了 charset，中文在某些阅读器里就是乱码；少了 viewport，手机上是一屏缩到底。
      //    渲染器里一直有，但**此前没有任何断言提到它们**（全文件 0 处）——
      //    谁哪天顺手删掉一行，不会有任何东西变红。补上。
      expect(html, template).toContain('<meta charset="utf-8">');
      expect(html, template).toContain('<meta name="viewport"');
      expect(html).toContain('<title>九月经营简报</title>');
      expect(html, template).toMatch(/<main[ >]/);
      expect(html).toContain('<style>');
      expect(html).toContain('</html>');
      // 内容真进了页面（不是只生成个壳）
      expect(html, template).toContain('增长来自复购。');
      expect(html, template).toContain('12.4%');
      expect(html, template).toContain('私域');
      expect(html, template).toContain('本周动作');
      expect(html, template).toContain('内部经营数据');
    }
  });

  it('`lang` 原样写进 `<html lang>`（读屏与断行都看它）', () => {
    expect(buildHtmlgenHtml(request('brief', { lang: 'en' }))).toContain('<html lang="en">');
    expect(buildHtmlgenHtml(request('brief', { lang: 'ja' }))).toContain('<html lang="ja">');
  });

  it('摘要 / 来源是可省的：没有就不留空壳', () => {
    const html = buildHtmlgenHtml(request('brief', { summary: undefined, sources: [] }));

    expect(html).not.toContain('class="summary"');
    expect(html).not.toContain('class="sources"');
  });

  it('⭐ 版式的差异是**看得见**的（不是只换个名字）', () => {
    const brief = buildHtmlgenHtml(request('brief'));
    const data = buildHtmlgenHtml(request('data'));
    const plan = buildHtmlgenHtml(request('plan'));

    // 配色不同（每个版式一个主色，样式表里其余地方一律引用 var(--accent)）
    expect(brief).toContain('--accent: #3b5bdb');
    expect(data).toContain('--accent: #6d28d9');
    expect(plan).toContain('--accent: #b45309');

    // ⭐ 区块顺序不同：项目计划把**行动项置顶**、数据页把**指标置顶**
    const positions = (html: string) => ({
      actions: html.indexOf('class="actions"'),
      metrics: html.indexOf('class="metrics"'),
      narrative: html.indexOf('class="narrative"'),
    });
    expect(positions(plan).actions).toBeLessThan(positions(plan).narrative);
    expect(positions(data).metrics).toBeLessThan(positions(data).narrative);
    expect(positions(brief).narrative).toBeLessThan(positions(brief).actions);

    // 方案页的行动项排成编号步骤；网页报告的小节带编号
    expect(buildHtmlgenHtml(request('proposal'))).toContain('counter-increment: step');
    // ⚠️ 计数器的**规则**在每份产出里都在（同一张样式表），所以判据是**有没有启用**：
    //    `.numbered` 挂在 `<main>` 上才真的编号。
    expect(brief).toContain('<main class="numbered">');
    expect(data).toContain('<main>');
    expect(data).not.toContain('<main class="numbered">');
  });

  it('同一类小节之间保持助手给的顺序（稳定排序，不是字典序）', () => {
    const html = buildHtmlgenHtml(
      request('brief', {
        sections: [
          { kind: 'narrative', heading: '甲', paragraphs: ['A'], bullets: [] },
          { kind: 'narrative', heading: '乙', paragraphs: ['B'], bullets: [] },
          { kind: 'narrative', heading: '丙', paragraphs: ['C'], bullets: [] },
        ],
      }),
    );

    expect(html.indexOf('甲')).toBeLessThan(html.indexOf('乙'));
    expect(html.indexOf('乙')).toBeLessThan(html.indexOf('丙'));
  });
});

/**
 * ⭐⭐ **安全**：这份 HTML 会被画在应用自己的界面里（`iframe sandbox=""` + 注入的 CSP），
 * 也会被用户拷到浏览器里打开。判据是"内容是不是数据"。
 */
describe('htmlgen 渲染：不含脚本、不引外部资源', () => {
  it('⭐ 一个 `<script>` 都没有（大小写混写也没有）', () => {
    for (const template of ALL_TEMPLATES) {
      const html = buildHtmlgenHtml(request(template));
      expect(html, template).not.toMatch(/<script/i);
      expect(html, template).not.toMatch(/<\/script/i);
    }
  });

  it('⭐ 没有任何外部引用（http/https/协议相对/外链标签/内联 url()）', () => {
    for (const template of ALL_TEMPLATES) {
      const html = buildHtmlgenHtml(request(template));

      expect(html, template).not.toMatch(/https?:\/\//i);
      expect(html, template).not.toMatch(/\/\//); // 协议相对与注释里的 `//` 一并禁掉
      expect(html, template).not.toMatch(/<link\b/i);
      expect(html, template).not.toMatch(/<img\b/i);
      expect(html, template).not.toMatch(/<iframe\b/i);
      expect(html, template).not.toMatch(/\bsrc\s*=/i);
      expect(html, template).not.toMatch(/\bhref\s*=/i);
      expect(html, template).not.toMatch(/@import/i);
      expect(html, template).not.toMatch(/\burl\(/i);
      expect(html, template).not.toMatch(/@font-face/i);
      expect(html, template).not.toMatch(/fonts\.googleapis/i);
    }
  });

  it('⭐ 没有内联事件处理器（`onclick=` 这类）', () => {
    const html = buildHtmlgenHtml(
      request('brief', { title: 'x', summary: 'y', sections: [{ kind: 'narrative', paragraphs: ['z'], bullets: [] }] }),
    );

    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
  });

  it('⭐ 助手写的内容**逐字转义** —— 标记在页面上是可见的文字', () => {
    const html = buildHtmlgenHtml(
      request('brief', {
        title: '<img src=x onerror=alert(1)>',
        summary: '<b>加粗</b>',
        sections: [
          {
            kind: 'narrative',
            heading: '<script>alert(1)</script>',
            paragraphs: ['a & b'],
            bullets: ['<div>块</div>'],
          },
          {
            kind: 'metrics',
            heading: 'x',
            items: [{ label: '<i>斜</i>', value: '<u>下划线</u>', detail: '<p>段</p>' }],
          },
          { kind: 'table', caption: '<caption>', columns: ['<th>'], rows: [['<td>']] },
          {
            kind: 'actions',
            items: [{ title: '<a href="#">链接</a>', detail: '<hr>', owner: '<b>我</b>', due: '<i>周五</i>' }],
          },
        ],
        sources: [{ label: '<script>src</script>', note: '<em>口径</em>' }],
      }),
    );

    // 一个真标记都不许留下（`<p>` `</p>` 这类**我们自己的**标签除外）
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>');
    expect(html).not.toContain('<i>');
    expect(html).not.toContain('<u>');
    expect(html).not.toContain('<em>');
    expect(html).not.toContain('<hr>');
    expect(html).not.toContain('<caption><');
    expect(html).not.toContain('<a href');
    expect(html).not.toMatch(/alert\(1\)<\/script>/);

    // 转义后的样子在
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('a &amp; b');
    expect(html).toContain('&lt;td&gt;');
    expect(html).toContain('&lt;a href=&quot;#&quot;&gt;链接&lt;/a&gt;');
  });

  it('⭐ 属性上下文也转义（双引号进不去 `<title>`）', () => {
    const html = buildHtmlgenHtml(
      request('brief', {
        title: '"><script>alert(1)</script>',
        sections: [{ kind: 'narrative', paragraphs: ['x'], bullets: [] }],
      }),
    );

    expect(html).toContain('<title>&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;</title>');
    expect(html).not.toContain('<script');
  });

  it('⭐ 产出**自带**与应用预览同一份 CSP（文件被拷出去那道锁也跟着走）', () => {
    const html = buildHtmlgenHtml(request('brief'));

    expect(html).toContain(`content="${HTML_PREVIEW_CSP}"`);
    expect(HTML_PREVIEW_CSP).toContain("default-src 'none'");
    expect(HTML_PREVIEW_CSP).not.toContain('unsafe-eval');
    // CSP 必须在 `<head>` 里、且在样式与正文之前（meta 形式的 CSP 只对**之后**的内容生效）
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<style>'));
  });
});

/**
 * ⭐ **好看**：这是这个通道存在的理由。判据是"真的用了排版引擎"，
 * 不是"有几个 CSS 属性"——所以每一条都对着一个具体的排版能力。
 */
describe('htmlgen 渲染：真的用了浏览器的排版能力', () => {
  const html = buildHtmlgenHtml(request('brief'));

  it('中文字体走**系统栈**（不外链、不内嵌 —— 离线与授权两头都安全）', () => {
    expect(html).toContain('Microsoft YaHei');
    expect(html).toContain('PingFang SC');
    expect(html).toContain('Noto Sans CJK SC');
    expect(html).not.toContain('@font-face');
  });

  it('有字号层级（不是一档到底）：标题 / 小节 / 正文 / 说明各有各的大小', () => {
    const sizes = [...html.matchAll(/font-size:\s*([\d.]+)rem/g)].map((m) => m[1]);
    const unique = new Set(sizes);

    expect(unique.size, `只有这些字号：${[...unique].join(', ')}`).toBeGreaterThanOrEqual(5);
    // 最大的字号必须明显大于正文（否则"层级"是假的）
    expect(Math.max(...sizes.map(Number))).toBeGreaterThanOrEqual(2);
  });

  it('用栅格排指标卡（不是一行一个堆下来）', () => {
    expect(html).toMatch(/\.metrics\s*\{[^}]*display:\s*grid/);
    expect(html).toMatch(/grid-template-columns:\s*repeat\(auto-fit/);
  });

  it('表格有表头底色、斑马行、以及不换行的表头', () => {
    expect(html).toMatch(/thead th\s*\{[^}]*background:/);
    expect(html).toContain('tbody tr:nth-child(even)');
    expect(html).toMatch(/thead th\s*\{[^}]*white-space:\s*nowrap/);
  });

  it('有留白节奏（内外边距成套出现，不是 0）', () => {
    const spacing = [...html.matchAll(/(?:padding|margin|gap):\s*([\d.]+)rem/g)].map((m) => Number(m[1]));
    expect(spacing.length).toBeGreaterThan(20);
    expect(Math.max(...spacing)).toBeGreaterThanOrEqual(2);
  });

  it('⭐ 有打印样式：A4 页边距、避免卡片断页、长表表头重复', () => {
    expect(html).toContain('@media print');
    expect(html).toMatch(/@page\s*\{[^}]*size:\s*A4/);
    expect(html).toMatch(/@page\s*\{[^}]*margin:/);
    expect(html).toContain('break-inside: avoid');
    expect(html).toContain('display: table-header-group');
    expect(html).toContain('break-after: avoid');
  });

  it('窄屏有响应式（手机上不是硬撑一版）', () => {
    expect(html).toMatch(/@media\s*\(max-width:\s*720px\)/);
  });

  it('数字用等宽数字（表格与指标对齐）', () => {
    expect(html).toContain('font-variant-numeric: tabular-nums');
  });

  it('长标题/长英文词不撑破版心', () => {
    expect(html).toContain('overflow-wrap: break-word');
  });
});

describe('htmlgen 渲染：结构', () => {
  it('表格有表头、每个单元格一个 `<td>`、列数对齐', () => {
    const html = buildHtmlgenHtml(
      request('brief', {
        sections: [
          {
            kind: 'table',
            caption: '两个渠道',
            columns: ['甲', '乙'],
            rows: [
              ['1', '2'],
              ['3', '4'],
            ],
          },
        ],
      }),
    );

    expect(html).toContain('<th scope="col">甲</th>');
    expect(html).toContain('<th scope="col">乙</th>');
    expect((html.match(/<td>/g) ?? []).length).toBe(4);
    expect(html).toContain('<caption>');
  });

  it('行动项的 owner / due 排成两个 chip（**不带文字标签**，免得跟文档语言打架）', () => {
    const html = buildHtmlgenHtml(
      request('plan', {
        sections: [{ kind: 'actions', items: [{ title: '发版', owner: '我', due: '本周五' }] }],
      }),
    );

    expect(html).toContain('<span class="chip">我</span>');
    expect(html).toContain('<span class="chip chip-due">本周五</span>');
    // 顺序固定：先 owner 后 due（没有文字标签时，靠顺序和样式区分）
    expect(html.indexOf('<span class="chip">')).toBeLessThan(html.indexOf('<span class="chip chip-due">'));
  });

  it('没有小标题的小节不加标题栏（不留空 `<h2>`）', () => {
    const html = buildHtmlgenHtml(
      request('brief', { sections: [{ kind: 'narrative', paragraphs: ['没有小标题'], bullets: [] }] }),
    );

    expect(html).not.toContain('<h2></h2>');
    expect(html).toContain('<section class="block">');
  });

  it('CSS 里的两个颜色占位符必须**都被换掉**（漏一个整段样式就失效）', () => {
    for (const template of ALL_TEMPLATES) {
      const html = buildHtmlgenHtml(request(template));
      expect(html, template).not.toContain('__ACCENT__');
      expect(html, template).not.toContain('__WASH__');
    }
  });

  it('`renderHtmlgenDocument` 交出来的是 UTF-8 字节（中文不乱码）', async () => {
    const buffer = await renderHtmlgenDocument(request('brief', { title: 'Partner-W' }));

    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.toString('utf8')).toContain('<title>Partner-W</title>');
    // 中文按 UTF-8 是 3 字节：长度按字节算才对得上（预算那几条正是按字节判的）
    expect(buffer.byteLength).toBe(Buffer.byteLength(buffer.toString('utf8'), 'utf8'));
  });
});

/**
 * ⭐⭐ **体积预算**：产出必须能走富预览（`MAX_HTML_PREVIEW_BYTES`）。
 *
 * 这是"内容上限"与"预览上限"之间的那座桥 —— 上限改大了而没人重算，症状是
 * "助手照技能写了、文件也生成了、用户打开却是一堆源码"。
 *
 * ⚠️ 判据分两层，别混起来：
 *   - **真实的重页面**（用户真会要的那种）必须舒服地落在预算里；
 *   - **合成极值**（每个格子都顶格写满）**允许**撞上守卫 —— 那时得到的是
 *     "没生成 + 一句可读原因"，而不是一份打不开像样的文件。
 *     算一下就明白了：表格是平方级膨胀的那一项，中文在 UTF-8 里是 **3 字节/字**，
 *     20 个小节 × 80 行 × 10 列 × 150 字 ≈ 240 万字 ≈ 7 MB —— 这个量级的正文
 *     没有哪个模型一次能吐出来（那是几十万 token），所以守卫是**兜底**而不是日常路径。
 */
describe('htmlgen 渲染：体积预算', () => {
  const L = HTMLGEN_LIMITS;

  /** 一份**真实的重页面**：小节数、表格行数、卡片数都取用户会要的上限附近。 */
  function heavyRealisticRequest() {
    return request('brief', {
      title: '第三季度经营复盘与下一步安排（含渠道明细）',
      summary: '三季度整体达成，但渠道结构在变化。'.repeat(8),
      sections: [
        {
          kind: 'narrative',
          heading: '核心判断',
          paragraphs: ['增长主要来自老客复购。'.repeat(20)],
          bullets: Array.from({ length: 12 }, () => '要点'.repeat(20)),
        },
        {
          kind: 'metrics',
          heading: '关键指标',
          items: Array.from({ length: 12 }, (_, i) => ({
            label: `指标${i}`,
            value: '12.4%',
            detail: '较上月 +1.8pp',
          })),
        },
        {
          kind: 'table',
          heading: '渠道明细',
          caption: '近 30 天，按线索量排序',
          columns: ['渠道', '线索', '成交', '转化率', '备注'],
          rows: Array.from({ length: 40 }, (_, r) => [`渠道${r}`, '120', '18', '15.0%', '备注'.repeat(10)]),
        },
        {
          kind: 'actions',
          heading: '下一步',
          items: Array.from({ length: 8 }, (_, i) => ({
            title: `动作${i}`,
            detail: '把复购券发出去。'.repeat(6),
            owner: '待定',
            due: '本周五',
          })),
        },
      ],
      sources: Array.from({ length: 6 }, (_, i) => ({ label: `来源${i}`, note: '统计口径截至 2026-09-27' })),
    });
  }

  /** 合成极值：每个小节都是满行满列的表格，每个格子都顶格。 */
  function maxedRequest() {
    const columns = Array.from({ length: L.maxTableColumns }, (_, c) => `列${c}${'题'.repeat(30)}`);
    const row = Array.from({ length: L.maxTableColumns }, () => '值'.repeat(L.maxTableCellChars));
    return request('brief', {
      title: '标'.repeat(L.maxTitleChars),
      summary: '摘'.repeat(L.maxSummaryChars),
      sections: Array.from({ length: L.maxSections }, (_, i) => ({
        kind: 'table',
        heading: `第 ${i} 节${'题'.repeat(30)}`,
        caption: '说'.repeat(L.maxCaptionChars),
        columns,
        rows: Array.from({ length: L.maxTableRows }, () => row),
      })),
      sources: Array.from({ length: L.maxSources }, () => ({
        label: '源'.repeat(L.maxSourceLabelChars),
        note: '注'.repeat(L.maxSourceNoteChars),
      })),
    });
  }

  it('⭐ 真实的重页面：**远低于**预算，一定能走富预览', () => {
    const size = Buffer.byteLength(buildHtmlgenHtml(heavyRealisticRequest()), 'utf8');

    expect(size).toBeLessThan(MAX_HTMLGEN_OUTPUT_BYTES);
    // 留出足够余量：真实内容不该贴着上限走（贴着走意味着稍多一行就掉进守卫）
    expect(size).toBeLessThan(MAX_HTMLGEN_OUTPUT_BYTES / 4);
    expect(size).toBeLessThan(MAX_HTML_PREVIEW_BYTES / 4);
  });

  it('⭐ 合成极值：要么在预算内，要么**抛**（绝不产出一份看不了的文件）', () => {
    let size: number;
    try {
      size = Buffer.byteLength(buildHtmlgenHtml(maxedRequest()), 'utf8');
    } catch (error) {
      expect(error).toBeInstanceOf(HtmlgenOutputTooLargeError);
      // 抛出来的那个错必须如实带上"排了多大"与"上限多少"（文案里那两个数是真的）
      const tooLarge = error as HtmlgenOutputTooLargeError;
      expect(tooLarge.size).toBeGreaterThan(MAX_HTMLGEN_OUTPUT_BYTES);
      expect(tooLarge.maxBytes).toBe(MAX_HTMLGEN_OUTPUT_BYTES);
      return;
    }
    expect(size).toBeLessThanOrEqual(MAX_HTMLGEN_OUTPUT_BYTES);
  });

  it('⭐ 转义膨胀也拦得住（`&` 一个字符变五个，最省事的"撑爆"输入）', () => {
    const spam = '&'.repeat(4000);
    const huge = request('brief', {
      sections: Array.from({ length: L.maxSections }, () => ({
        kind: 'narrative',
        paragraphs: Array.from({ length: L.maxParagraphs }, () => spam),
        bullets: [],
      })),
    });

    expect(() => buildHtmlgenHtml(huge)).toThrow(HtmlgenOutputTooLargeError);
    try {
      buildHtmlgenHtml(huge);
    } catch (error) {
      const tooLarge = error as HtmlgenOutputTooLargeError;
      expect(tooLarge.size).toBeGreaterThan(MAX_HTMLGEN_OUTPUT_BYTES);
      expect(tooLarge.maxBytes).toBe(MAX_HTMLGEN_OUTPUT_BYTES);
    }
  });

  it('上限本身钉住：产出预算 3 MiB、富预览 4 MiB，且前者必须更小', () => {
    expect(MAX_HTMLGEN_OUTPUT_BYTES).toBe(3 * 1024 * 1024);
    expect(MAX_HTML_PREVIEW_BYTES).toBe(4 * 1024 * 1024);
    // 两个上限的关系本身也要对：产出预算必须比预览上限小（否则"保富预览"是句空话）
    expect(MAX_HTMLGEN_OUTPUT_BYTES).toBeLessThan(MAX_HTML_PREVIEW_BYTES);
  });
});

/**
 * 端到端一寸：**解析 + 渲染**接起来。
 *
 * ⚠️ 这一条是"契约改了而渲染层没跟上"的哨兵 —— 两个文件各测各的时候，
 *    `parseHtmlgenRequest` 的产物形状变了、`buildHtmlgenHtml` 读旧字段，
 *    两边都绿，而线上是空的。
 */
describe('htmlgen：解析 → 渲染 接得上', () => {
  it('用户给的那份示例（九月经营简报）能一路排出来', () => {
    const parsed = parseHtmlgenRequest({
      kind: 'html',
      title: '九月经营简报',
      lang: 'zh-CN',
      template: 'brief',
      summary: '本月最重要的结论。',
      sections: [
        { kind: 'narrative', heading: '核心判断', paragraphs: ['……'], bullets: ['……'] },
        { kind: 'metrics', items: [{ label: '转化率', value: '12.4%', detail: '较上月 +1.8pp' }] },
        { kind: 'table', caption: '渠道表现', columns: ['渠道', '线索', '成交'], rows: [['私域', '120', '18']] },
        { kind: 'actions', items: [{ title: '本周动作', detail: '……', owner: '待定', due: '本周五' }] },
      ],
      sources: [{ label: '内部经营数据', note: '统计口径截至 2026-09-27' }],
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const html = buildHtmlgenHtml(parsed.request);

    expect(html).toContain('九月经营简报');
    expect(html).toContain('转化率');
    expect(html).toContain('12.4%');
    expect(html).toContain('私域');
    expect(html).toContain('本周动作');
    expect(html).toContain('待定');
    expect(html).toContain('内部经营数据');
  });
});

/**
 * 🔴 2026-09-28：**打印 / 存 PDF 时会把设计整个丢掉。**
 *
 * `@media print` 早就写了（A4、页边距、卡片不跨页断开），但**漏了 `print-color-adjust`**。
 * 浏览器的默认是 `economy` —— 打印时**背景色和底色一律不印**：
 *
 * - 摘要那张卡片的浅底色 → 没了
 * - 表格表头行的深底 → 没了（只剩一行黑字，跟数据行分不开）
 * - 指标卡片的底 → 没了
 * - 各种 chip / 品牌色块 → 全没了
 *
 * ⇒ 印出来正好是这份文件开头明确说要避免的形状：「白底黑字一列到底」。
 *   这条路存在的理由就是"网页有排版引擎"，而**打印是报告最常见的去向**（用户点"打印"）。
 *
 * ⚠️ 两个前缀都要：`-webkit-print-color-adjust` 给 WebKit/Chromium（我们的预览与打印都走它），
 *    无前缀的 `print-color-adjust` 是标准写法。少任何一个在某个引擎上就是白印。
 */
describe('打印保真：颜色必须跟着印出来', () => {
  const html = (() => {
    const parsed = parseHtmlgenRequest({
      kind: 'html',
      title: '九月经营简报',
      lang: 'zh-CN',
      template: 'brief',
      summary: '本月最重要的结论。',
      sections: [
        { kind: 'metrics', heading: '关键指标', items: [{ label: '转化率', value: '12.4%' }] },
        { kind: 'table', heading: '分渠道', columns: ['渠道', '营收'], rows: [['老客', '¥130 万']] },
      ],
      sources: [{ label: '内部经营数据' }],
    });
    expect(parsed.ok, '样本本身不合契约').toBe(true);
    return parsed.ok ? buildHtmlgenHtml(parsed.request) : '';
  })();

  it('⭐ 写了 `print-color-adjust: exact`（否则表头底 / 卡片底 / 品牌色全不印）', () => {
    expect(html, '漏了它 ⇒ 印出来是"白底黑字一列到底"（这份文件开头明确说要避免的形状）').toMatch(
      /print-color-adjust:\s*exact/,
    );
  });

  it('⭐ `-webkit-` 前缀也在（Chromium 是预览与打印的引擎）', () => {
    expect(html).toMatch(/-webkit-print-color-adjust:\s*exact/);
  });

  it('打印块还在（别为了保色把 A4 / 页边距弄丢）', () => {
    expect(html).toMatch(/@media\s+print/);
    expect(html).toMatch(/@page/);
  });
});
