import { describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import yauzl from 'yauzl';
import { findPptxTemplate, PPTX_TEMPLATE_IDS } from '../src/main/docgen/pptx-template/catalog';
import { templateDeckFallbackRequest } from '../src/main/docgen/pptx-template/fallback';
import { resolvePptxTemplatesRoot } from '../src/main/docgen/pptx-template/locate';
import { parseDocgenRequest, type DocgenRequest } from '../src/main/docgen/request';
import { listZipEntries, readZipEntry } from '../src/main/preview/zip-entry';
import { renderDocument } from '../src/main/docgen/render';

/**
 * **分发层**：`renderDocument` 按 `kind` 把请求交给对应的渲染器。
 *
 * 这一层单独钉的理由：三种格式各自"解包看结构"的断言在各自的文件里，
 * 而"分错了渲染器"这种错**每一个单独看都是绿的** —— 只有把请求与容器的
 * 对应关系钉死才看得见（docx 请求渲染出 pptx 结构，照样是个合法 zip）。
 *
 * ⚠️ 判据用**每种格式独有的必备部件**（`ppt/presentation.xml` / `word/document.xml` /
 *    `xl/workbook.xml`），不是"有没有报错"，并配一条负对照。
 */

function requestOf(raw: unknown): DocgenRequest {
  const parsed = parseDocgenRequest(raw);
  if (!parsed.ok) throw new Error(`夹具本该合法：${parsed.error}`);
  return parsed.request;
}

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const TEMPLATES_ROOT = resolvePptxTemplatesRoot({ isPackaged: false, appPath: PACKAGE_ROOT })!;

function unzipNames(buffer: Buffer): Promise<string[]> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) return reject(err ?? new Error('no zipfile'));
      const names: string[] = [];
      zipfile.on('entry', (entry: yauzl.Entry) => {
        names.push(entry.fileName);
        zipfile.readEntry();
      });
      zipfile.on('end', () => resolve(names));
      zipfile.on('error', reject);
      zipfile.readEntry();
    });
  });
}

describe('renderDocument —— 按 kind 分发', () => {
  it('pptx 请求 ⇒ pptx 容器', async () => {
    const buffer = await renderDocument(
      requestOf({ kind: 'pptx', title: 't', slides: [{ title: 's', bullets: ['b'] }] }),
    );
    expect(await unzipNames(buffer)).toContain('ppt/presentation.xml');
  });

  it('⭐ 模板渲染器内部失败 ⇒ 自动降级成仍可打开的 PPTX，而不是零产物', async () => {
    const onTemplateFallback = vi.fn();
    const buffer = await renderDocument(
      requestOf({
        kind: 'pptx',
        title: '餐饮项目商业计划书',
        template: 'business-deck-v4',
        slides: [
          { templateId: 'cover', data: { cover_title: '餐饮项目商业计划书', cover_subtitle: '种子轮融资' } },
          {
            templateId: 'insight',
            data: {
              slide_title: '市场痛点',
              takeaway: '消费者需要稳定品质和更便捷的服务',
              evidence_1: '传统门店的线上线下体验割裂',
            },
          },
        ],
      }),
      { templatesRoot: undefined, fileName: 'investor-deck.pptx', onTemplateFallback },
    );

    expect(await unzipNames(buffer)).toContain('ppt/presentation.xml');
    expect(buffer.toString('utf8')).not.toBe('');
    expect(onTemplateFallback).toHaveBeenCalledTimes(1);
    expect(onTemplateFallback.mock.calls[0]?.[0]).toMatchObject({
      failure: { code: 'render-failed', format: 'pptx' },
    });
  });

  it('⭐ 降级后保留八种模板的每个非空字段（含封面标题、日期、作者）', async () => {
    const expected: string[] = [];
    let serial = 0;
    const slides = PPTX_TEMPLATE_IDS.map((templateId) => {
      const spec = findPptxTemplate(templateId)!;
      const data = Object.fromEntries(
        Object.entries(spec.tokens).map(([token, tokenSpec]) => {
          const value = Array.from(`字段${serial++}-${token}`).slice(0, tokenSpec.maxLength).join('');
          expected.push(value);
          return [token, value];
        }),
      );
      return { templateId, data };
    });

    const buffer = await renderDocument(
      requestOf({ kind: 'pptx', title: '文件名不等于封面标题', template: 'business-deck-v4', slides }),
      { templatesRoot: undefined, fileName: 'all-fields.pptx' },
    );
    const allSlideXml = listZipEntries(buffer)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .map((name) => readZipEntry(buffer, name)?.toString('utf8') ?? '')
      .join('\n');

    for (const value of expected) expect(allSlideXml, `降级时丢了：${value}`).toContain(value);
  });

  it('⭐ 八种模板的每个字段取目录上限，模板引擎故障后仍必须产出 PPTX', async () => {
    const slides = PPTX_TEMPLATE_IDS.map((templateId) => {
      const spec = findPptxTemplate(templateId)!;
      const data = Object.fromEntries(
        Object.entries(spec.tokens).map(([token, tokenSpec]) => [token, '界'.repeat(tokenSpec.maxLength)]),
      );
      return { templateId, data };
    });

    const buffer = await renderDocument(
      requestOf({ kind: 'pptx', title: '最大合法输入', template: 'business-deck-v4', slides }),
      { templatesRoot: undefined, fileName: 'max-valid-fields.pptx' },
    );

    expect(await unzipNames(buffer)).toContain('ppt/presentation.xml');
  });

  it('⭐ 41–60 字章节背景不塞进模板小框，自动走可读同格式保底且保留全文', async () => {
    const sectionContext = '核心团队平均从业经验8年以上，曾在头部餐饮集团/互联网平台担任管理职位，具备从0到1的创业经验';
    expect(sectionContext.length).toBe(47);
    const onTemplateFallback = vi.fn();
    const buffer = await renderDocument(
      requestOf({
        kind: 'pptx',
        title: '团队介绍',
        template: 'business-deck-v4',
        slides: [{ templateId: 'section', data: { section_title: '团队介绍', section_context: sectionContext } }],
      }),
      { templatesRoot: TEMPLATES_ROOT, fileName: 'readable-section.pptx', onTemplateFallback },
    );

    expect(onTemplateFallback).toHaveBeenCalledTimes(1);
    const slideXml = listZipEntries(buffer)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .map((name) => readZipEntry(buffer, name)?.toString('utf8') ?? '')
      .join('\n');
    expect(slideXml).toContain(sectionContext);
  });

  it('保底封面把合法换行压成空格，完整值仍由内容页保存', () => {
    const fallback = templateDeckFallbackRequest('文件名', {
      slides: [{ templateId: 'cover', data: { cover_title: '餐饮项目\n商业计划书' } }],
    });

    expect(fallback?.title).toBe('餐饮项目 商业计划书');
    expect(fallback?.slides[0]?.bullets.join('\n').replace(/\s/gu, '')).toContain('餐饮项目商业计划书');
  });

  it('docx 请求 ⇒ docx 容器（不是 pptx）', async () => {
    const buffer = await renderDocument(requestOf({ kind: 'docx', title: 't', sections: [{ paragraphs: ['一段'] }] }));
    const names = await unzipNames(buffer);
    expect(names).toContain('word/document.xml');
    expect(names, 'docx 请求被交给了 pptx 渲染器').not.toContain('ppt/presentation.xml');
  });

  it('xlsx 请求 ⇒ xlsx 容器（不是 pptx / docx）', async () => {
    const buffer = await renderDocument(
      requestOf({ kind: 'xlsx', title: 't', sheets: [{ name: 'S', rows: [['a']] }] }),
    );
    const names = await unzipNames(buffer);
    expect(names).toContain('xl/workbook.xml');
    expect(names).not.toContain('ppt/presentation.xml');
    expect(names).not.toContain('word/document.xml');
  });

  it('负对照：不存在的部件判不存在（否则上面那些 toContain 可能恒真）', async () => {
    const buffer = await renderDocument(
      requestOf({ kind: 'xlsx', title: 't', sheets: [{ name: 'S', rows: [['a']] }] }),
    );
    expect(await unzipNames(buffer)).not.toContain('word/nonexistent-part.xml');
  });
});
