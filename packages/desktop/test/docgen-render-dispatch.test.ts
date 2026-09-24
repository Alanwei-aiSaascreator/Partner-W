import { describe, expect, it } from 'vitest';
import yauzl from 'yauzl';
import { parseDocgenRequest, type DocgenRequest } from '../src/main/docgen/request';
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
