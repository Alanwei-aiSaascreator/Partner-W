/**
 * `htmlgen` 的**请求契约**（2026-09-27）。
 *
 * 这条通道与 `docgen` 的分工相同（助手想内容、客户端排版），但有两件事必须钉死：
 *
 *  1. **助手写不出 HTML**：协议里没有任何承载标记/样式/坐标/路径/远程地址的字段。
 *     这里逐条证明"它想写也写不了" —— 要么整份拒、要么被当成文本。
 *  2. **每种版式都有"至少要给的那一类内容"**：数据页没有数据、项目计划没有行动项，
 *     产出的是"看着像成品、其实是空壳"的页面，比不生成更糟。
 */
import { describe, expect, it } from 'vitest';
import { HTMLGEN_SECTION_KINDS, HTMLGEN_TEMPLATES } from '@clawwork/shared';
import {
  HTMLGEN_LANGS,
  HTMLGEN_LIMITS,
  HTMLGEN_TEMPLATE_SPECS,
  parseHtmlgenRequest,
} from '../src/main/htmlgen/request.js';

/** 一份**合法**的基准请求（覆盖全部四种小节）—— 各条测试在它上面改一处。 */
function validRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'html',
    title: '九月经营简报',
    lang: 'zh-CN',
    template: 'brief',
    summary: '本月最重要的结论。',
    sections: [
      { kind: 'narrative', heading: '核心判断', paragraphs: ['增长来自复购。'], bullets: ['老客贡献七成'] },
      { kind: 'metrics', items: [{ label: '转化率', value: '12.4%', detail: '较上月 +1.8pp' }] },
      { kind: 'table', caption: '渠道表现', columns: ['渠道', '线索', '成交'], rows: [['私域', '120', '18']] },
      { kind: 'actions', items: [{ title: '本周动作', detail: '……', owner: '待定', due: '本周五' }] },
    ],
    sources: [{ label: '内部经营数据', note: '统计口径截至 2026-09-27' }],
    ...overrides,
  };
}

/** 每个版式各自"够用"的一份请求（`data` 不收 actions，所以不能共用基准）。 */
const PER_TEMPLATE_VALID: Record<string, Record<string, unknown>> = {
  brief: validRequest(),
  proposal: validRequest({ template: 'proposal' }),
  research: validRequest({ template: 'research' }),
  plan: validRequest({
    template: 'plan',
    sections: [{ kind: 'actions', items: [{ title: '发版', owner: '我', due: '本周五' }] }],
  }),
  data: validRequest({
    template: 'data',
    sections: [{ kind: 'metrics', items: [{ label: '转化率', value: '12.4%' }] }],
  }),
};

describe('htmlgen 契约：版式集合', () => {
  it('五个版式都能解析出一份请求（合法输入）', () => {
    for (const template of HTMLGEN_TEMPLATES) {
      const result = parseHtmlgenRequest(PER_TEMPLATE_VALID[template]);
      expect(result.ok, `${template} 的合法输入被拒了`).toBe(true);
      if (result.ok) {
        expect(result.request.template).toBe(template);
        expect(result.request.kind).toBe('html');
        expect(result.request.title).toBe('九月经营简报');
      }
    }
  });

  it('⭐ `kind` 必须是 `"html"`（挡住"把 docgen 的块贴进 htmlgen 围栏"）', () => {
    // 拿一份形状几乎正确的 docgen 请求：字段名对不上、kind 也不对 ⇒ 必须先死在 kind 上
    const result = parseHtmlgenRequest({
      kind: 'docx',
      title: 'x',
      sections: [{ heading: '一', paragraphs: ['正文'], bullets: [] }],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain('kind');
  });

  it('未知版式名 ⇒ `htmlgen-unknown-template`，并**原样回显**助手写的那串', () => {
    const result = parseHtmlgenRequest(validRequest({ template: 'dashboard' }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toEqual({ code: 'htmlgen-unknown-template', template: 'dashboard' });
    // 日志里要说清有哪些可用的（这一句不上屏）
    expect(result.detail).toContain('brief');
  });

  it('版式名超长时回显要截断（别把一屏都塞进 toast）', () => {
    const result = parseHtmlgenRequest(validRequest({ template: 'x'.repeat(200) }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('htmlgen-unknown-template');
    if (result.failure.code === 'htmlgen-unknown-template') {
      expect(result.failure.template.length).toBeLessThanOrEqual(40);
    }
  });

  it('缺 `template` ⇒ 整份拒（没有默认版式：默认一个等于替用户选了他没选的版式）', () => {
    const raw = validRequest();
    delete raw.template;
    const result = parseHtmlgenRequest(raw);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('htmlgen-block-invalid');
  });

  it('`requires` 与 `allows` 只引用已知的小节类型（版式表不许写出协议外的名字）', () => {
    for (const template of HTMLGEN_TEMPLATES) {
      const spec = HTMLGEN_TEMPLATE_SPECS[template];
      expect(spec.requires.length, `${template} 没有 requires 就等于没有质量门槛`).toBeGreaterThan(0);
      for (const kind of [...spec.requires, ...spec.allows]) {
        expect(HTMLGEN_SECTION_KINDS as readonly string[]).toContain(kind);
      }
      // requires 必须是 allows 的子集，否则"必须给的那类"会被自己拒掉（永远生成不出来）
      for (const kind of spec.requires) expect(spec.allows).toContain(kind);
    }
  });
});

/**
 * 每种版式的"至少要给的那一类内容"（`htmlgen-content-too-thin`）。
 *
 * ⚠️ 这条测的是**产品判断**，不是类型：判据是"少给这一类就整份拒"。
 */
describe('htmlgen 契约：版式的必备内容', () => {
  it('⭐ 每种版式少给"它要的那一类" ⇒ 拒，且原因是 content-too-thin（带上还缺什么）', () => {
    // 只给 narrative 一种：`plan` 要 actions、`data` 要 metrics/table ⇒ 这两者必须被拒
    const onlyNarrative = validRequest({ sections: [{ kind: 'narrative', paragraphs: ['正文'] }] });

    for (const template of ['brief', 'proposal', 'research']) {
      const result = parseHtmlgenRequest({ ...onlyNarrative, template });
      expect(result.ok, `${template} 只该在给 narrative 时通过`).toBe(true);
    }
    for (const template of ['plan', 'data'] as const) {
      const result = parseHtmlgenRequest({ ...onlyNarrative, template });
      expect(result.ok, `${template} 少了它要的那类内容却没被拒`).toBe(false);
      if (result.ok) continue;
      expect(result.failure.code).toBe('htmlgen-content-too-thin');
      if (result.failure.code === 'htmlgen-content-too-thin') {
        expect(result.failure.template).toBe(template);
        expect(result.failure.needs).toEqual(HTMLGEN_TEMPLATE_SPECS[template].requires);
      }
    }
  });

  it('⭐ `data` 版式不收 actions（一页数据里夹一张待办卡，读者会不知道这页在说什么）', () => {
    const result = parseHtmlgenRequest(
      validRequest({
        template: 'data',
        sections: [
          { kind: 'metrics', items: [{ label: '转化率', value: '12.4%' }] },
          { kind: 'actions', items: [{ title: '顺便做一件事' }] },
        ],
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('htmlgen-block-invalid');
      expect(result.detail).toContain('actions');
    }
  });

  it('空内容：`sections` 空 / 全是空壳 / 只有空串 ⇒ 一律拒', () => {
    expect(parseHtmlgenRequest(validRequest({ sections: [] })).ok).toBe(false);
    expect(parseHtmlgenRequest(validRequest({ sections: [{}] })).ok).toBe(false);
    expect(
      parseHtmlgenRequest(validRequest({ sections: [{ kind: 'narrative', paragraphs: [], bullets: [] }] })).ok,
    ).toBe(false);
    expect(parseHtmlgenRequest(validRequest({ sections: [{ kind: 'narrative', paragraphs: ['', '  '] }] })).ok).toBe(
      false,
    );
  });

  it('空壳小节被丢掉、其余照常（模型爱留空行，为此整份失败不值得）', () => {
    const result = parseHtmlgenRequest(
      validRequest({
        sections: [{}, { kind: 'narrative', paragraphs: ['正文'], bullets: [] }, { kind: 'metrics', items: [] }],
      }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.request.sections).toHaveLength(1);
  });

  it('⭐ 写了内容却没写 `kind` ⇒ 拒（静默丢掉等于把用户的内容吃掉而没人知道）', () => {
    const result = parseHtmlgenRequest(validRequest({ sections: [{ paragraphs: ['这段会被吃掉'] }] }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain('kind is required');
  });

  it('小节**只有标题**也算有内容（与 docgen 同一条口径）', () => {
    const result = parseHtmlgenRequest(
      validRequest({ template: 'research', sections: [{ heading: '只有标题', kind: 'narrative' }] }),
    );

    expect(result.ok).toBe(true);
  });
});

/**
 * ⭐⭐ **"模型写不了坏版面"的证据**（本任务最要紧的一组）。
 *
 * 不是"我们检查了它写的东西觉得不行"，而是"协议里根本没有那个字段"。
 * 判据两条：
 *   - 写了协议外的字段 ⇒ **整份拒**，且原因里带上**字段路径**（助手才知道删哪一处）；
 *   - 写了标记 ⇒ 当**文本**（转义那条由 `htmlgen-render.test.ts` 钉）。
 */
describe('htmlgen 契约：结构上写不出标记/样式/坐标/外链', () => {
  const forbiddenRootFields = [
    'html',
    'raw',
    'markup',
    'style',
    'css',
    'color',
    'font',
    'src',
    'url',
    'href',
    'image',
    'x',
    'y',
    'w',
    'h',
    'path',
    'filePath',
    'base64',
    'script',
  ];

  it('⭐ 根上出现任何一个"标记/样式/坐标/外链"字段 ⇒ 整份拒', () => {
    for (const field of forbiddenRootFields) {
      const result = parseHtmlgenRequest(validRequest({ [field]: '随便什么值' }));
      expect(result.ok, `根上的 "${field}" 竟然被接受了`).toBe(false);
      if (result.ok) continue;
      expect(result.failure.code).toBe('htmlgen-unsupported-field');
      if (result.failure.code === 'htmlgen-unsupported-field') {
        expect(result.failure.field).toBe(field);
      }
    }
  });

  it('⭐ 小节里写 `style` ⇒ 拒，且报**完整路径**（排错要有落点）', () => {
    const result = parseHtmlgenRequest(
      validRequest({
        sections: [
          { kind: 'narrative', paragraphs: ['正文'] },
          { kind: 'metrics', items: [{ label: 'a', value: 'b' }], style: 'color:red' },
        ],
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toEqual({ code: 'htmlgen-unsupported-field', field: 'sections[1].style' });
  });

  it('⭐ 几种小节类型各有自己的字段白名单（`metrics` 带 `columns` 是错的）', () => {
    const mismatch = [
      { kind: 'metrics', items: [{ label: 'a', value: 'b' }], columns: ['甲'] },
      { kind: 'table', columns: ['甲'], rows: [['x']], paragraphs: ['正文'] },
      { kind: 'actions', items: [{ title: 't' }], bullets: ['要点'] },
      { kind: 'narrative', paragraphs: ['正文'], items: [{ label: 'a', value: 'b' }] },
    ];
    for (const section of mismatch) {
      const result = parseHtmlgenRequest(validRequest({ sections: [section] }));
      expect(result.ok, `这种混搭被接受了：${JSON.stringify(section)}`).toBe(false);
      if (!result.ok) expect(result.failure.code).toBe('htmlgen-unsupported-field');
    }
  });

  it('⭐ 指标/行动项/来源各自的字段也白名单（`color` 写不进指标里）', () => {
    const cases: [string, Record<string, unknown>][] = [
      [
        'sections[0].items[0].color',
        { sections: [{ kind: 'metrics', items: [{ label: 'a', value: 'b', color: '#f00' }] }], template: 'data' },
      ],
      ['sections[0].items[0].icon', { sections: [{ kind: 'actions', items: [{ title: 't', icon: 'star' }] }] }],
      ['sources[0].url', { sources: [{ label: '来源', url: 'https://example.com' }] }],
    ];
    for (const [expectedField, overrides] of cases) {
      const result = parseHtmlgenRequest(validRequest(overrides));
      expect(result.ok, `${expectedField} 竟然被接受了`).toBe(false);
      if (result.ok) continue;
      expect(result.failure).toEqual({ code: 'htmlgen-unsupported-field', field: expectedField });
    }
  });

  it('⭐ 未知的**小节类型**也拒（没有 `chart`、没有 `image`、没有 `raw`）', () => {
    for (const kind of ['chart', 'image', 'raw', 'html', 'iframe']) {
      const result = parseHtmlgenRequest(validRequest({ sections: [{ kind, items: [] }] }));
      expect(result.ok, `小节类型 "${kind}" 竟然被接受了`).toBe(false);
      if (!result.ok) expect(result.failure.code).toBe('htmlgen-block-invalid');
    }
  });

  it('`kind: "html"` 本身照旧必填（少了就拒）', () => {
    const raw = validRequest();
    delete raw.kind;
    expect(parseHtmlgenRequest(raw).ok).toBe(false);
  });
});

describe('htmlgen 契约：超长与超量', () => {
  const L = HTMLGEN_LIMITS;

  it('标题超长 ⇒ 拒', () => {
    expect(parseHtmlgenRequest(validRequest({ title: '标'.repeat(L.maxTitleChars + 1) })).ok).toBe(false);
    expect(parseHtmlgenRequest(validRequest({ title: '标'.repeat(L.maxTitleChars) })).ok).toBe(true);
  });

  it('段落 / 要点超长 ⇒ 拒（边界值本身通过）', () => {
    const paragraph = (n: number) => validRequest({ sections: [{ kind: 'narrative', paragraphs: ['字'.repeat(n)] }] });
    expect(parseHtmlgenRequest(paragraph(L.maxParagraphChars + 1)).ok).toBe(false);
    expect(parseHtmlgenRequest(paragraph(L.maxParagraphChars)).ok).toBe(true);

    const bullet = (n: number) => validRequest({ sections: [{ kind: 'narrative', bullets: ['字'.repeat(n)] }] });
    expect(parseHtmlgenRequest(bullet(L.maxBulletChars + 1)).ok).toBe(false);
    expect(parseHtmlgenRequest(bullet(L.maxBulletChars)).ok).toBe(true);
  });

  it('小标题 / 指标 / 行动项 / 单元格超长 ⇒ 各自拒', () => {
    const heading = validRequest({
      sections: [{ kind: 'narrative', heading: '标'.repeat(L.maxHeadingChars + 1), paragraphs: ['正文'] }],
    });
    expect(parseHtmlgenRequest(heading).ok).toBe(false);

    const metric = validRequest({
      template: 'data',
      sections: [{ kind: 'metrics', items: [{ label: 'a', value: 'b'.repeat(L.maxMetricValueChars + 1) }] }],
    });
    expect(parseHtmlgenRequest(metric).ok).toBe(false);

    const action = validRequest({
      template: 'plan',
      sections: [{ kind: 'actions', items: [{ title: '题'.repeat(L.maxActionTitleChars + 1) }] }],
    });
    expect(parseHtmlgenRequest(action).ok).toBe(false);

    const cell = validRequest({
      sections: [{ kind: 'table', columns: ['甲'], rows: [['字'.repeat(L.maxTableCellChars + 1)]] }],
    });
    expect(parseHtmlgenRequest(cell).ok).toBe(false);
  });

  it('条数超量 ⇒ 拒（小节数 / 段落数 / 要点数 / 指标数 / 行动项数 / 表行数 / 来源数）', () => {
    const tooMany = (sections: unknown[]) => parseHtmlgenRequest(validRequest({ sections })).ok;

    expect(
      tooMany(Array.from({ length: L.maxSections + 1 }, () => ({ kind: 'narrative', paragraphs: ['正文'] }))),
    ).toBe(false);
    expect(
      tooMany([{ kind: 'narrative', paragraphs: Array.from({ length: L.maxParagraphs + 1 }, () => '正文') }]),
    ).toBe(false);
    expect(tooMany([{ kind: 'narrative', bullets: Array.from({ length: L.maxBullets + 1 }, () => '要点') }])).toBe(
      false,
    );
    expect(
      tooMany([
        {
          kind: 'metrics',
          items: Array.from({ length: L.maxMetricItems + 1 }, () => ({ label: 'a', value: 'b' })),
        },
      ]),
    ).toBe(false);
    expect(
      tooMany([{ kind: 'actions', items: Array.from({ length: L.maxActionItems + 1 }, () => ({ title: 't' })) }]),
    ).toBe(false);
    expect(
      tooMany([
        {
          kind: 'table',
          columns: ['甲'],
          rows: Array.from({ length: L.maxTableRows + 1 }, () => ['x']),
        },
      ]),
    ).toBe(false);

    const sources = parseHtmlgenRequest(
      validRequest({ sources: Array.from({ length: L.maxSources + 1 }, () => ({ label: '来源' })) }),
    );
    expect(sources.ok).toBe(false);
  });

  it('表格：比列多一个格子 ⇒ 拒（丢了会让用户拿到一张少了信息的表而不知道）', () => {
    const result = parseHtmlgenRequest(
      validRequest({ sections: [{ kind: 'table', columns: ['甲', '乙'], rows: [['1', '2', '3']] }] }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain('more cells than columns');
  });

  it('表格：没有表头 / 表头空串 ⇒ 拒', () => {
    expect(parseHtmlgenRequest(validRequest({ sections: [{ kind: 'table', rows: [['x']] }] })).ok).toBe(false);
    expect(parseHtmlgenRequest(validRequest({ sections: [{ kind: 'table', columns: [], rows: [['x']] }] })).ok).toBe(
      false,
    );
    expect(
      parseHtmlgenRequest(validRequest({ sections: [{ kind: 'table', columns: ['  '], rows: [['x']] }] })).ok,
    ).toBe(false);
  });

  it('表格：数字单元格变成文本（页面不是电子表格，不求和）', () => {
    const result = parseHtmlgenRequest(
      validRequest({ sections: [{ kind: 'table', columns: ['渠道', '线索'], rows: [['私域', 120]] }] }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const table = result.request.sections[0];
    if (table.kind !== 'table') throw new Error('不是表格');
    expect(table.rows[0]).toEqual(['私域', '120']);
  });
});

describe('htmlgen 契约：语言与来源', () => {
  it('`lang` 白名单：认得出的用，认不出的拒（不静默退回默认值）', () => {
    for (const lang of HTMLGEN_LANGS) {
      const result = parseHtmlgenRequest(validRequest({ lang }));
      expect(result.ok, `${lang} 被拒了`).toBe(true);
      if (result.ok) expect(result.request.lang).toBe(lang);
    }
    expect(parseHtmlgenRequest(validRequest({ lang: 'xx-YY' })).ok).toBe(false);
  });

  it('不给 `lang` ⇒ 默认 `zh-CN`', () => {
    const raw = validRequest();
    delete raw.lang;
    const result = parseHtmlgenRequest(raw);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.request.lang).toBe('zh-CN');
  });

  it('来源：`label` 必填、`sources` 可省', () => {
    const withoutSources = validRequest();
    delete withoutSources.sources;
    expect(parseHtmlgenRequest(withoutSources).ok).toBe(true);

    expect(parseHtmlgenRequest(validRequest({ sources: [{ note: '没有名字' }] })).ok).toBe(false);
  });
});
