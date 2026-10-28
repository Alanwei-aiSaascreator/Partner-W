import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  findPptxTemplate,
  PPTX_TEMPLATE_FILE,
  PPTX_TEMPLATE_IDS,
  PPTX_TEMPLATES,
  PPTX_TEMPLATE_SET_ID,
} from '../src/main/docgen/pptx-template/catalog';
import { resolvePptxTemplatesRoot } from '../src/main/docgen/pptx-template/locate';
import { listZipEntries, readZipEntry } from '../src/main/preview/zip-entry';

/**
 * 目录 ↔ **真实模板文件** 的对齐测试。
 *
 * 为什么非要有这一条：`catalog.ts` 里把 token 名到形状名的映射**写死了**
 * （`value_1` ↔ `METRIC_1_VALUE`，这不是大小写规则能推出来的）。写死就会漂移 ——
 * 换个模板文件、或者手改了一个形状名，产物上那一格就**永远是空的**
 * （`modifyElement` 找不到元素时只记一条日志，不抛），
 * 而所有单测都会绿。这条测试打开真文件逐页核对，漂移当场红。
 *
 * ⚠️ 这里读的是**开发态**那一份（走生产代码的 `resolvePptxTemplatesRoot`），
 *    所以它同时也在验证"开发态定位是对的"。
 */

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

function templateBuffer(): Buffer {
  const root = resolvePptxTemplatesRoot({ isPackaged: false, appPath: PACKAGE_ROOT });
  if (!root) throw new Error('开发态定位返回了 undefined');
  return readFileSync(join(root, PPTX_TEMPLATE_FILE));
}

/** 从 slide XML 里抽出 `形状名 → 文本`（同一 `p:sp` 内的 `<a:t>` 拼接）。 */
function shapesIn(slideXml: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const sp of slideXml.match(/<p:sp>[\s\S]*?<\/p:sp>/g) ?? []) {
    const name = /<p:cNvPr[^>]*name="([^"]*)"/.exec(sp)?.[1];
    if (!name) continue;
    const text = (sp.match(/<a:t>(.*?)<\/a:t>/g) ?? []).join('').replace(/<\/?a:t>/g, '');
    out.set(name, text);
  }
  return out;
}

function slideXml(buffer: Buffer, index: number): string {
  const entry = readZipEntry(buffer, `ppt/slides/slide${index}.xml`);
  if (!entry) throw new Error(`模板里没有 ppt/slides/slide${index}.xml`);
  return entry.toString('utf8');
}

describe('pptx 模板目录 —— 与真实模板文件对齐', () => {
  const buffer = templateBuffer();

  it('七种模板页都在，且页序连续从 1 开始', () => {
    expect(PPTX_TEMPLATE_IDS.length).toBeGreaterThanOrEqual(7);
    const slides = PPTX_TEMPLATE_IDS.map((id) => findPptxTemplate(id)?.slide);
    expect(slides).toEqual([...slides].sort((a, b) => (a ?? 0) - (b ?? 0)));
    expect(new Set(slides).size).toBe(slides.length);
  });

  it.each(PPTX_TEMPLATE_IDS)('%s：每个形状都在那一页上，且文字正好是 {{token}}', (id) => {
    const spec = findPptxTemplate(id);
    expect(spec).toBeDefined();
    if (!spec) return;
    const shapes = shapesIn(slideXml(buffer, spec.slide));

    for (const [token, tokenSpec] of Object.entries(spec.tokens)) {
      expect(shapes.has(tokenSpec.shape), `第 ${spec.slide} 页没有名为 ${tokenSpec.shape} 的形状`).toBe(true);
      if (tokenSpec.keepTemplateTextWhenEmpty) {
        expect(shapes.get(tokenSpec.shape)?.trim()).toBeTruthy();
        expect(shapes.get(tokenSpec.shape)).not.toMatch(/\{\{[^}]+\}\}/);
        continue;
      }
      expect(shapes.get(tokenSpec.shape), `${tokenSpec.shape} 的文字不是 {{${token}}}`).toBe(`{{${token}}}`);
    }
  });

  it('模板文件里的每一个 {{占位符}} 都在目录里（没有目录外的野占位符）', () => {
    const known = new Set(
      Object.values(PPTX_TEMPLATES).flatMap((spec) => Object.keys(spec.tokens).map((t) => `{{${t}}}`)),
    );
    const entries = listZipEntries(buffer).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
    const found = new Set<string>();
    for (const entry of entries) {
      const xml = readZipEntry(buffer, entry)?.toString('utf8') ?? '';
      for (const match of xml.match(/\{\{[^}]+\}\}/g) ?? []) found.add(match);
    }
    expect(found.size).toBeGreaterThan(0);
    expect([...found].filter((t) => !known.has(t))).toEqual([]);
  });

  it('目录里声明的 token 总数与文件里的占位符总数一致（没有只声明不存在的）', () => {
    const declared = Object.values(PPTX_TEMPLATES).reduce(
      (n, spec) => n + Object.values(spec.tokens).filter((token) => !token.keepTemplateTextWhenEmpty).length,
      0,
    );
    const entries = listZipEntries(buffer).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
    let inFile = 0;
    for (const entry of entries) {
      const xml = readZipEntry(buffer, entry)?.toString('utf8') ?? '';
      inFile += (xml.match(/\{\{[^}]+\}\}/g) ?? []).length;
    }
    expect(inFile).toBe(declared);
  });

  it('preserves template defaults only for the three optional action header mappings', () => {
    const preserved = Object.values(PPTX_TEMPLATES).flatMap((spec) =>
      Object.entries(spec.tokens)
        .filter(([, tokenSpec]) => tokenSpec.keepTemplateTextWhenEmpty)
        .map(([token, tokenSpec]) => ({ templateId: spec.id, token, ...tokenSpec })),
    );
    expect(preserved).toEqual(
      [
        ['action_header', 'ACTION_HEADER'],
        ['owner_header', 'OWNER_HEADER'],
        ['due_header', 'DUE_HEADER'],
      ].map(([token, shape]) => ({
        templateId: 'actions',
        token,
        shape,
        maxLength: 40,
        keepTemplateTextWhenEmpty: true,
      })),
    );
  });
});

/**
 * 模板资产的**三条不变量**。它们不是"风格问题"，每一条都对应一次实测故障 ——
 * 换成一份直接从 WPS 导出的 pptx 而不做这三件事，功能会**当场坏掉**。
 *
 * 详见 `resources/pptx-templates/README.md`。
 */
describe('pptx 模板资产的不变量（换文件时必须重新满足）', () => {
  const buffer = templateBuffer();

  it('① 没有任何部件带 UTF-8 BOM（否则 @xmldom 解析直接抛错）', () => {
    const withBom = listZipEntries(buffer).filter((name) => {
      const data = readZipEntry(buffer, name);
      return data !== null && data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf;
    });
    expect(withBom).toEqual([]);
  });

  it('② 没有备注页 / 备注母版（复制页之后它们的反向引用会错位）', () => {
    const notes = listZipEntries(buffer).filter(
      (n) => n.startsWith('ppt/notesSlides/') || n.startsWith('ppt/notesMasters/'),
    );
    expect(notes).toEqual([]);
  });

  it('③ presentation.xml 的根元素声明了 xmlns:r（否则追加的 sldId 里那个 r: 前缀无人绑定）', () => {
    const xml = readZipEntry(buffer, 'ppt/presentation.xml')?.toString('utf8') ?? '';
    const root = /<p:presentation\b[^>]*>/.exec(xml)?.[0] ?? '';
    expect(root).not.toBe('');
    expect(root).toContain('xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"');
    expect(root).toContain('xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"');
  });
});

describe('pptx 模板目录 —— 内容自洽', () => {
  it('模板集 id 与文件名都在，且 id 非空', () => {
    expect(PPTX_TEMPLATE_SET_ID.length).toBeGreaterThan(0);
    expect(PPTX_TEMPLATE_FILE.endsWith('.pptx')).toBe(true);
  });

  it('每个 token 都有有限的字符上限（不能是"随便多长都行"）', () => {
    for (const spec of Object.values(PPTX_TEMPLATES)) {
      for (const [token, tokenSpec] of Object.entries(spec.tokens)) {
        expect(Number.isSafeInteger(tokenSpec.maxLength), `${spec.id}.${token} 的 maxLength 不是整数`).toBe(true);
        expect(tokenSpec.maxLength, `${spec.id}.${token} 的 maxLength 不是正数`).toBeGreaterThan(0);
      }
    }
  });

  it('每个模板页至少有一个必填字段（否则可以生成一张全空的页）', () => {
    for (const spec of Object.values(PPTX_TEMPLATES)) {
      const required = Object.values(spec.tokens).filter((t) => t.required);
      expect(required.length, `${spec.id} 一个必填字段都没有`).toBeGreaterThan(0);
    }
  });
});
