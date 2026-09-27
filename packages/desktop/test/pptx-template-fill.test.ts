import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findPptxTemplate, PPTX_TEMPLATE_IDS, PPTX_TEMPLATE_SET_ID } from '../src/main/docgen/pptx-template/catalog';
import { fillTemplateDeck, PptxTemplateError } from '../src/main/docgen/pptx-template/fill';
import { resolvePptxTemplatesRoot } from '../src/main/docgen/pptx-template/locate';
import { parseTemplateDeck } from '../src/main/docgen/pptx-template/parse';
import { listZipEntries, readZipEntry } from '../src/main/preview/zip-entry';
import type { TemplateDeckSpec } from '../src/main/docgen/pptx-template/parse';

/**
 * 填充：**真生成一份 pptx，再真读回来**。
 *
 * 为什么不能只断言"函数没抛"：
 *  - `modifyElement` 找不到元素时**只记一条日志、不抛** ⇒ 静默出一份带 `{{占位符}}` 的成品；
 *  - 值里的 `<` `&` 有没有被转义，只有把 zip 解开、读那段 XML 才知道；
 *  - "生成成功"与"这份文件能被 WPS 打开"是两件事（这个仓库为此栽过一次：
 *    追加出来的 `p:sldId` 用了没声明的 `xmlns:r`，WPS 判 0 页而单测全绿）。
 */

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const TEMPLATES_ROOT = resolvePptxTemplatesRoot({ isPackaged: false, appPath: PACKAGE_ROOT })!;

let outDir: string;
beforeEach(() => {
  outDir = mkdtempSync(join(tmpdir(), 'pptx-template-fill-'));
});
afterEach(() => {
  rmSync(outDir, { recursive: true, force: true });
});

async function fill(input: unknown, name = 'deck.pptx'): Promise<{ path: string; buffer: Buffer }> {
  const parsed = parseTemplateDeck(input);
  if (!parsed.ok) throw new Error(`parse 失败：${JSON.stringify(parsed.failure)}`);
  const path = await fillTemplateDeck({ deck: parsed.deck, templatesRoot: TEMPLATES_ROOT, outputDir: outDir, outputName: name });
  const { readFileSync } = await import('node:fs');
  return { path, buffer: readFileSync(path) };
}

/** 输出里每一页 slide XML 的文本合集。 */
function slideTexts(buffer: Buffer): string[] {
  return listZipEntries(buffer)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/(\d+)/)![1]) - Number(b.match(/(\d+)/)![1]))
    .map((n) => readZipEntry(buffer, n)!.toString('utf8'));
}

describe('fillTemplateDeck —— 真生成真读回', () => {
  it('生成的文件存在，且是一个能读的 zip', async () => {
    const { path, buffer } = await fill({ slides: [{ templateId: 'cover', data: { cover_title: '九月经营简报' } }] });
    expect(existsSync(path)).toBe(true);
    expect(listZipEntries(buffer)).toContain('ppt/presentation.xml');
    expect(listZipEntries(buffer)).toContain('ppt/slides/slide1.xml');
  });

  it('内容真的写进去了（读回来能看到那几个字，中文不乱码）', async () => {
    const { buffer } = await fill({
      slides: [{ templateId: 'cover', data: { cover_title: '九月经营简报', cover_subtitle: '私域增长', date: '2026-09-27' } }],
    });
    const all = slideTexts(buffer).join('\n');
    expect(all).toContain('九月经营简报');
    expect(all).toContain('私域增长');
    expect(all).toContain('2026-09-27');
  });

  it('⭐ 成品里**一个 {{占位符}} 都不许剩**（包括没给值的可选字段）', async () => {
    // metrics 有 12 个占位符，这里只给 4 个 —— 剩下 8 个必须被清成空串
    const { buffer } = await fill({
      slides: [{ templateId: 'metrics', data: { slide_title: '关键指标', value_1: '12.4%', label_1: '转化率' } }],
    });
    const leftovers = slideTexts(buffer).flatMap((xml) => xml.match(/\{\{[^}]+\}\}/g) ?? []);
    expect(leftovers).toEqual([]);
  });

  it('⭐ 助手写的字是**数据不是标记**：XML 特殊字符被转义', async () => {
    const { buffer } = await fill({
      slides: [{ templateId: 'cover', data: { cover_title: '<script>alert(1)</script>', cover_subtitle: 'A & B' } }],
    });
    const xml = slideTexts(buffer)[0];
    expect(xml).not.toContain('<script>');
    expect(xml).toContain('&lt;script&gt;');
    expect(xml).not.toContain('A & B');
    expect(xml).toContain('A &amp; B');
  });

  it('一页都不认识模板时不会生成（parse 已挡，这里确认整条链是一致的）', async () => {
    await expect(fill({ slides: [{ templateId: 'no-such-page', data: {} }] })).rejects.toThrow(/parse 失败/);
  });

  it('模板文件缺失时报的是"模板文件找不到"，不是一句泛泛的渲染失败', async () => {
    const parsed = parseTemplateDeck({ slides: [{ templateId: 'cover', data: { cover_title: 'x' } }] });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    await expect(
      fillTemplateDeck({ deck: parsed.deck, templatesRoot: join(outDir, 'nope'), outputDir: outDir, outputName: 'x.pptx' }),
    ).rejects.toBeInstanceOf(PptxTemplateError);
  });
});

describe('八种模板页 —— 逐个真生成', () => {
  /** 每种模板给一份最小合法数据（必填字段都有）。 */
  const minimal: Record<string, Record<string, string>> = Object.fromEntries(
    PPTX_TEMPLATE_IDS.map((id) => {
      const spec = findPptxTemplate(id)!;
      const data: Record<string, string> = {};
      for (const [token, tokenSpec] of Object.entries(spec.tokens)) {
        data[token] = tokenSpec.required ? `必填-${token}` : `可选-${token}`;
      }
      return [id, data];
    }),
  );

  it.each(PPTX_TEMPLATE_IDS)('%s：单独生成一页，内容写对、无残留占位符', async (id) => {
    const { buffer } = await fill({ slides: [{ templateId: id, data: minimal[id] }] }, `${id}.pptx`);
    const texts = slideTexts(buffer);
    expect(texts).toHaveLength(1);
    expect(texts[0]).not.toMatch(/\{\{[^}]+\}\}/);
    for (const value of Object.values(minimal[id])) {
      expect(texts[0]).toContain(value);
    }
  });

  it('八页拼成一份：页数正确、顺序与请求一致', async () => {
    const { buffer } = await fill(
      {
        template: PPTX_TEMPLATE_SET_ID,
        slides: PPTX_TEMPLATE_IDS.map((id) => ({ templateId: id, data: minimal[id] })),
      },
      'all.pptx',
    );
    const texts = slideTexts(buffer);
    expect(texts).toHaveLength(PPTX_TEMPLATE_IDS.length);
    PPTX_TEMPLATE_IDS.forEach((id, index) => {
      expect(texts[index]).toContain(minimal[id][Object.keys(minimal[id])[0]]);
    });
    expect(texts.join('\n')).not.toMatch(/\{\{[^}]+\}\}/);
  });

  it('同一模板页可以用多次（对比页连着两页），互不串味', async () => {
    const { buffer } = await fill({
      slides: [
        { templateId: 'cover', data: { cover_title: '第一份' } },
        { templateId: 'cover', data: { cover_title: '第二份' } },
      ],
    });
    const texts = slideTexts(buffer);
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain('第一份');
    expect(texts[0]).not.toContain('第二份');
    expect(texts[1]).toContain('第二份');
  });

  it('⭐ 页脚页码跟**在成品里的位置**走，不沿用模板里写死的那个数', async () => {
    // 模板里 timeline 那一页写死 FOOTER_PAGE_6 = "06"。把它放在一副 3 页 deck 的
    // 第 2 页，页脚必须印 02 而不是 06 —— 这是靠 WPS 渲图审出来的缺陷：
    // 一副「封面 + 时间线 + 行动」的汇报，页脚原本印的是 01 / 06 / 07。
    const { buffer } = await fill({
      slides: [
        { templateId: 'cover', data: { cover_title: '封面' } },
        { templateId: 'timeline', data: { slide_title: '时间线', step_1_title: '第一步' } },
        { templateId: 'actions', data: { slide_title: '行动', action_1: '做事' } },
      ],
    });
    const texts = slideTexts(buffer);
    expect(texts).toHaveLength(3);

    /** 取某个形状的文本（模板里页码形状是固定的那一个）。 */
    const shapeText = (xml: string, name: string): string => {
      for (const sp of xml.match(/<p:sp>[\s\S]*?<\/p:sp>/g) ?? []) {
        if (!new RegExp(`<p:cNvPr[^>]*name="${name}"`).test(sp)) continue;
        return (sp.match(/<a:t>(.*?)<\/a:t>/g) ?? []).join('').replace(/<\/?a:t>/g, '');
      }
      return '';
    };

    expect(shapeText(texts[0], 'COVER_INDEX')).toBe('01');
    expect(shapeText(texts[1], 'FOOTER_PAGE_6')).toBe('02'); // 不是模板里的 "06"
    expect(shapeText(texts[2], 'FOOTER_PAGE_7')).toBe('03'); // 不是模板里的 "07"
  });

  it('一份 deck 里没有任何 `{{` 残留（全文扫一遍，不只是首几段）', async () => {
    const { buffer } = await fill({
      slides: PPTX_TEMPLATE_IDS.map((id) => ({
        templateId: id,
        data: Object.fromEntries(Object.entries(minimal[id]).filter(([, v]) => !v.startsWith('可选-'))),
      })),
    });
    const all = listZipEntries(buffer)
      .filter((n) => n.startsWith('ppt/slides/slide'))
      .map((n) => readZipEntry(buffer, n)!.toString('utf8'))
      .join('\n');
    expect(all.match(/\{\{[^}]+\}\}/g)).toBeNull();
  });
});
