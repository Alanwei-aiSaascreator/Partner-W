import { existsSync, readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  findPptxTemplate,
  pageNumberShapeFor,
  PPTX_BLANK_ROOT_FILE,
  PPTX_TEMPLATE_FILE,
} from '../src/main/docgen/pptx-template/catalog';
import { fillTemplateDeck } from '../src/main/docgen/pptx-template/fill';
import { parseTemplateDeck } from '../src/main/docgen/pptx-template/parse';
import { listZipEntries, readZipEntry } from '../src/main/preview/zip-entry';

/**
 * **打包态**那条路：用的是 `win-unpacked/resources/pptx-templates` 里的真文件，
 * 不是仓库里的那一份。
 *
 * 为什么开发态全绿还不够：`extraResources` 漏了 / `to:` 拼错 / 资源没拷进包里 ——
 * 这三种都**只在装出来之后**才表现，而症状是"每次生成都失败"，开发机上什么都看不出来。
 * 所以这条必须对着**真实构建产物**跑。
 *
 * ⚠️ 用环境变量门控，和 `PARTNERW_PPTX_SAMPLE_OUT` 同一个套路：
 *
 * ```
 * PARTNERW_PACKAGED_RESOURCES="D:\p4-rel\packages\desktop\dist\win-unpacked\resources" \
 *   ./node_modules/.bin/vitest run test/pptx-template-packaged.test.ts
 * ```
 *
 * 不设就整组 skip —— `pnpm check` 里跑的就是 skip 那一支（仓库里没有构建产物）。
 */

const RESOURCES = process.env.PARTNERW_PACKAGED_RESOURCES;
const ENABLED = typeof RESOURCES === 'string' && RESOURCES.length > 0 && existsSync(RESOURCES);
const TEMPLATES_ROOT = ENABLED ? join(RESOURCES!, 'pptx-templates') : '';
const OUR_SKILLS_ROOT = ENABLED ? join(RESOURCES!, 'our-skills') : '';

const scratch = mkdtempSync(join(tmpdir(), 'pptx-packaged-'));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function slideTexts(buffer: Buffer): string[] {
  return listZipEntries(buffer)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/(\d+)/)![1]) - Number(b.match(/(\d+)/)![1]))
    .map((n) => readZipEntry(buffer, n)!.toString('utf8'));
}

function shapeText(xml: string, name: string): string {
  for (const sp of xml.match(/<p:sp>[\s\S]*?<\/p:sp>/g) ?? []) {
    if (!new RegExp(`<p:cNvPr[^>]*name="${name}"`).test(sp)) continue;
    return (sp.match(/<a:t>(.*?)<\/a:t>/g) ?? []).join('').replace(/<\/?a:t>/g, '');
  }
  return '';
}

describe.skipIf(!ENABLED)('打包态资源', () => {
  it('两份模板文件真的在包里', () => {
    expect(existsSync(join(TEMPLATES_ROOT, PPTX_TEMPLATE_FILE)), `缺 ${PPTX_TEMPLATE_FILE}`).toBe(true);
    expect(existsSync(join(TEMPLATES_ROOT, PPTX_BLANK_ROOT_FILE)), `缺 ${PPTX_BLANK_ROOT_FILE}`).toBe(true);
  });

  it('两个新技能也随包', () => {
    for (const slug of ['html-deliverable', 'presentation-deck-v2']) {
      expect(existsSync(join(OUR_SKILLS_ROOT, slug, 'SKILL.md')), `缺技能 ${slug}`).toBe(true);
    }
  });

  it('⭐ 用**打包态**资源生成一份 cover/insight/metrics/timeline/closing 的 deck', async () => {
    const parsed = parseTemplateDeck({
      template: 'business-deck-v4',
      slides: [
        { templateId: 'cover', data: { cover_title: '打包态验证', cover_subtitle: '资源来自 win-unpacked' } },
        {
          templateId: 'insight',
          data: { slide_title: '观点', takeaway: '打包态的模板一样能用', evidence_1: '证据一', evidence_2: '证据二' },
        },
        { templateId: 'metrics', data: { slide_title: '指标', value_1: '12.4%', label_1: '转化率' } },
        { templateId: 'timeline', data: { slide_title: '时间线', step_1_title: '第一步', step_2_title: '第二步' } },
        { templateId: 'closing', data: { closing_title: '收尾', closing_message: '结束' } },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const written = await fillTemplateDeck({
      deck: parsed.deck,
      templatesRoot: TEMPLATES_ROOT,
      outputDir: scratch,
      outputName: 'packaged.pptx',
    });
    const buffer = readFileSync(written);
    expect(buffer.byteLength).toBeGreaterThan(1000);

    const texts = slideTexts(buffer);
    expect(texts).toHaveLength(5);
    // 内容真写进去了
    expect(texts[0]).toContain('打包态验证');
    expect(texts.join('\n')).not.toMatch(/\{\{[^}]+\}\}/); // 无残留占位符
  });

  it('⭐ 页码按**输出顺序**，不用模板里写死的那个数', async () => {
    const parsed = parseTemplateDeck({
      slides: [
        { templateId: 'cover', data: { cover_title: 'A' } },
        { templateId: 'timeline', data: { slide_title: 'B', step_1_title: 'x' } }, // 模板里是 06
        { templateId: 'closing', data: { closing_title: 'C' } }, // 模板里是 08
      ],
    });
    if (!parsed.ok) throw new Error('parse 失败');
    const written = await fillTemplateDeck({
      deck: parsed.deck,
      templatesRoot: TEMPLATES_ROOT,
      outputDir: scratch,
      outputName: 'pages.pptx',
    });
    const texts = slideTexts(readFileSync(written));
    expect(shapeText(texts[0], 'COVER_INDEX')).toBe('01');
    expect(shapeText(texts[1], pageNumberShapeFor('timeline')!)).toBe('02');
    expect(shapeText(texts[2], pageNumberShapeFor('closing')!)).toBe('03');
  });

  it('⭐ 真机投资路演顺序在打包资源上可重复使用观点页与指标页', async () => {
    const parsed = parseTemplateDeck({
      template: 'business-deck-v4',
      slides: [
        { templateId: 'cover', data: { cover_title: '我的项目商业计划书' } },
        { templateId: 'insight', data: { slide_title: '市场痛点' } },
        { templateId: 'insight', data: { slide_title: '解决方案' } },
        { templateId: 'metrics', data: { slide_title: '市场空间', value_1: '5.6万亿', label_1: '市场规模' } },
        { templateId: 'comparison', data: { slide_title: '竞争优势' } },
        { templateId: 'insight', data: { slide_title: '商业模式' } },
        { templateId: 'timeline', data: { slide_title: '发展规划', step_1_title: '第一阶段' } },
        { templateId: 'metrics', data: { slide_title: '经营预测', value_1: '120万', label_1: '单店收入' } },
        { templateId: 'section', data: { section_title: '团队介绍' } },
        { templateId: 'actions', data: { slide_title: '融资计划', action_1: '产品研发' } },
        { templateId: 'closing', data: { closing_title: '感谢关注' } },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const written = await fillTemplateDeck({
      deck: parsed.deck,
      templatesRoot: TEMPLATES_ROOT,
      outputDir: scratch,
      outputName: 'packaged-investor-deck.pptx',
    });
    const texts = slideTexts(readFileSync(written));
    expect(texts).toHaveLength(11);
    expect(texts[0]).toContain('我的项目商业计划书');
    expect(texts[10]).toContain('感谢关注');
  });

  it('打包态资源与 catalog 仍然对齐（换模板文件忘了改目录会在这里红）', async () => {
    const buffer = readFileSync(join(TEMPLATES_ROOT, PPTX_TEMPLATE_FILE));
    for (const id of ['cover', 'insight', 'metrics', 'timeline', 'closing'] as const) {
      const spec = findPptxTemplate(id)!;
      const xml = readZipEntry(buffer, `ppt/slides/slide${spec.slide}.xml`)!.toString('utf8');
      for (const [token, tokenSpec] of Object.entries(spec.tokens)) {
        expect(shapeText(xml, tokenSpec.shape), `${id}.${token} 在打包态文件里对不上`).toBe(`{{${token}}}`);
      }
    }
  });
});
