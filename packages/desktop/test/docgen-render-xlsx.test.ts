import { describe, expect, it } from 'vitest';
import yauzl from 'yauzl';
import { parseDocgenRequest } from '../src/main/docgen/request';
import { renderXlsx } from '../src/main/docgen/render-xlsx';

/**
 * Excel 渲染层：**解包看结构 + 格子真的在 + 数字还是数字**。
 *
 * ⚠️ "数字还是数字"值得单独一条：把 1200 写成文本（`"1200"`）在界面上**看起来一样**，
 *    但用户没法求和、没法排序 —— 这正是"助手给的表"最常见的没用之处。
 *    判据：数字要落在工作表 XML 的 `<v>` 里，而**不能**出现在共享字符串表里。
 */

function unzip(buffer: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) return reject(err ?? new Error('no zipfile'));
      const files = new Map<string, Buffer>();
      zipfile.on('entry', (entry: yauzl.Entry) => {
        if (/\/$/.test(entry.fileName)) return zipfile.readEntry();
        zipfile.openReadStream(entry, (readErr, stream) => {
          if (readErr || !stream) return reject(readErr ?? new Error('no stream'));
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.on('end', () => {
            files.set(entry.fileName, Buffer.concat(chunks));
            zipfile.readEntry();
          });
          stream.on('error', reject);
        });
      });
      zipfile.on('end', () => resolve(files));
      zipfile.on('error', reject);
      zipfile.readEntry();
    });
  });
}

const REQUEST = {
  kind: 'xlsx',
  title: '九月台账',
  sheets: [
    {
      name: '汇总',
      rows: [
        ['产品', '数量'],
        ['甲产品', 1200],
        ['乙产品', 830.5],
      ],
    },
    { name: '备注', rows: [['一句话说明']] },
  ],
};

async function renderValid(): Promise<Map<string, Buffer>> {
  const parsed = parseDocgenRequest(REQUEST);
  if (!parsed.ok) throw new Error(`夹具本身不合法：${parsed.error}`);
  if (parsed.request.kind !== 'xlsx') throw new Error('夹具 kind 不对');
  return unzip(await renderXlsx(parsed.request));
}

function textOf(files: Map<string, Buffer>, name: string): string {
  return files.get(name)?.toString('utf8') ?? '';
}

function allXml(files: Map<string, Buffer>): string {
  return [...files.values()].map((buf) => buf.toString('utf8')).join('\n');
}

describe('renderXlsx —— 解包验证', () => {
  it('是一个结构合法的 xlsx（必备部件都在）', async () => {
    const files = await renderValid();
    for (const part of ['[Content_Types].xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml']) {
      expect([...files.keys()], `缺 ${part}`).toContain(part);
    }
  });

  it('两张表 ⇒ 两张工作表，表名写进了 workbook.xml', async () => {
    const files = await renderValid();
    expect([...files.keys()]).toContain('xl/worksheets/sheet2.xml');
    const workbook = textOf(files, 'xl/workbook.xml');
    expect(workbook).toContain('汇总');
    expect(workbook).toContain('备注');
  });

  it('⭐ 文本真的在（中文没被吞）', async () => {
    const files = await renderValid();
    const all = allXml(files);
    for (const text of ['产品', '数量', '甲产品', '乙产品', '一句话说明']) {
      expect(all, `缺「${text}」`).toContain(text);
    }
  });

  it('⭐ 数字还是数字（落在 `<v>` 里，不是文本）', async () => {
    const files = await renderValid();
    const sheet1 = textOf(files, 'xl/worksheets/sheet1.xml');
    expect(sheet1, '1200 不在工作表里').toContain('1200');
    expect(sheet1, '830.5 不在工作表里').toContain('830.5');

    const shared = textOf(files, 'xl/sharedStrings.xml');
    expect(shared, '1200 被写成了文本（用户没法求和）').not.toContain('1200');
  });

  it('布尔也保持布尔（`t="b"`，不是文本 true）', async () => {
    const parsed = parseDocgenRequest({ kind: 'xlsx', title: 't', sheets: [{ name: 'S', rows: [['开关', true]] }] });
    if (!parsed.ok || parsed.request.kind !== 'xlsx') throw new Error('夹具不合法');
    const files = await unzip(await renderXlsx(parsed.request));
    expect(textOf(files, 'xl/worksheets/sheet1.xml')).toMatch(/t="b"/);
  });

  it('负对照：**不存在的文字必须判 false**（否则上面那些 toContain 可能恒真）', async () => {
    const files = await renderValid();
    expect(allXml(files)).not.toContain('这段字压根不存在');
  });
});
