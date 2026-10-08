import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import Archive from 'pptx-automizer/dist/helper/archive/archive-jszip.js';
import {
  renderTemplateDeck,
  verifyTemplateDeck,
  TemplateDeckError,
  type SlotTable,
  type TemplateDeckContent,
} from '../src/main/docgen/template-deck/index.js';

const resource = path.resolve('resources/pptx-templates/native-deck');
const template = fs.readFileSync(path.join(resource, 'tpl-native.pptx'));
const table = JSON.parse(fs.readFileSync(path.join(resource, 'detail.json'), 'utf8')) as SlotTable;
const example = JSON.parse(fs.readFileSync(path.join(resource, 'content.example.json'), 'utf8')) as TemplateDeckContent;
const content = () => structuredClone(example);
const subset = (...pages: number[]): TemplateDeckContent =>
  Object.fromEntries(pages.map((page) => [String(page), structuredClone(example[String(page)])]));
const texts = (data: TemplateDeckContent, page: string) => {
  const raw = data[page];
  return Array.isArray(raw) ? raw : raw.texts;
};
const chart = (data: TemplateDeckContent, page: string) => {
  const raw = data[page];
  if (Array.isArray(raw) || !raw.chart) throw new Error('test-chart-missing');
  return raw.chart;
};
const rewrite = async (bytes: Buffer, part: string, change: (xml: string) => string) => {
  const zip = await JSZip.loadAsync(bytes);
  zip.file(part, change(await zip.file(part)!.async('string')));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
};
const xml = async (bytes: Buffer, part: string) => (await JSZip.loadAsync(bytes)).file(part)!.async('string');

describe('fixed slot native template deck', () => {
  it('selects existing layouts without inventing charts and removes unused package resources', async () => {
    const data = subset(16, 4, 1, 15);
    const result = await renderTemplateDeck(template, table, data);
    const checked = verifyTemplateDeck(result, table, data);
    expect(checked.pages).toBe(4);
    expect(checked.charts).toBe(0);
    const zip = await JSZip.loadAsync(result);
    const parts = Object.keys(zip.files).filter((name) => !zip.files[name].dir);
    expect(parts.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort()).toEqual([
      'ppt/slides/slide1.xml',
      'ppt/slides/slide15.xml',
      'ppt/slides/slide16.xml',
      'ppt/slides/slide4.xml',
    ]);
    expect(parts.filter((name) => /^ppt\/(charts|embeddings)\//.test(name))).toEqual([]);
    const presentation = new Archive(Buffer.alloc(0), { mode: 'jszip' }).parseXml(
      await xml(result, 'ppt/presentation.xml'),
    );
    const ids = Array.from(presentation.getElementsByTagName('p:sldId')).map((node) => node.getAttribute('r:id'));
    const rels = new Archive(Buffer.alloc(0), { mode: 'jszip' }).parseXml(
      await xml(result, 'ppt/_rels/presentation.xml.rels'),
    );
    expect(
      ids.map((id) =>
        Array.from(rels.getElementsByTagName('Relationship'))
          .find((node) => node.getAttribute('Id') === id)!
          .getAttribute('Target'),
      ),
    ).toEqual(['slides/slide1.xml', 'slides/slide4.xml', 'slides/slide15.xml', 'slides/slide16.xml']);
  });

  it.each([10, 11])('keeps only selected chart %i and its native workbook', async (page) => {
    const data = subset(1, page, 16);
    const result = await renderTemplateDeck(template, table, data);
    expect(verifyTemplateDeck(result, table, data)).toMatchObject({ pages: 3, charts: 1 });
    const zip = await JSZip.loadAsync(result);
    expect(Object.keys(zip.files).filter((name) => /^ppt\/charts\/chart\d+\.xml$/.test(name))).toHaveLength(1);
    expect(Object.keys(zip.files).filter((name) => /^ppt\/embeddings\/[^/]+\.xlsx$/.test(name))).toHaveLength(1);
    const damaged = await rewrite(result, `ppt/charts/chart${page === 10 ? 1 : 2}.xml`, (value) =>
      value.replace(/(<c:title>[\s\S]*?<a:t>)[^<]*/, '$1Changed title'),
    );
    expect(() => verifyTemplateDeck(damaged, table, data)).toThrowError(
      expect.objectContaining({
        diagnostics: [expect.objectContaining({ page: 2, detail: expect.stringContaining(`layout ${page}`) })],
      }),
    );
    chart(data, String(page)).title = '';
    await expect(renderTemplateDeck(template, table, data)).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'chart-title-missing', page: 2 })],
    });
  });

  it('keeps all native cells in a selected table layout', async () => {
    const data = subset(13);
    expect(verifyTemplateDeck(await renderTemplateDeck(template, table, data), table, data)).toMatchObject({
      pages: 1,
      tableCells: 24,
      charts: 0,
    });
  });

  it('rejects empty or noncanonical selection and invalid unselected catalog metadata', async () => {
    const invalidSelections: TemplateDeckContent[] = [
      {},
      { '0': example['1'] },
      { '17': example['1'] },
      { '01': example['1'] },
      { bogus: example['1'] },
    ];
    for (const data of invalidSelections)
      await expect(renderTemplateDeck(template, table, data)).rejects.toBeInstanceOf(TemplateDeckError);
    for (const mutate of [
      (invalid: SlotTable) => {
        invalid.pages[9].text_slots[0].address.paragraph = -1;
      },
      (invalid: SlotTable) => {
        invalid.pages[9].text_slots[0].max_chars = 0;
      },
    ]) {
      const invalid = structuredClone(table);
      mutate(invalid);
      await expect(renderTemplateDeck(template, invalid, subset(1))).rejects.toThrow('slot-table-invalid');
    }
  });

  it('rejects reordered presentation, orphan resources and dangling internal relationships', async () => {
    const data = subset(1, 4);
    const result = await renderTemplateDeck(template, table, data);
    const reordered = await rewrite(result, 'ppt/presentation.xml', (value) =>
      value.replace(/(<p:sldId\b[^>]*\/>)(<p:sldId\b[^>]*\/>)/, '$2$1'),
    );
    expect(() => verifyTemplateDeck(reordered, table, data)).toThrow('slide-order-mismatch');
    for (const part of ['ppt/slides/slide16.xml', 'ppt/charts/chart1.xml', 'ppt/embeddings/unused.xlsx']) {
      const zip = await JSZip.loadAsync(result);
      zip.file(part, 'unused');
      const changed = await zip.generateAsync({ type: 'nodebuffer' });
      expect(() => verifyTemplateDeck(changed, table, data)).toThrow();
    }
    const dangling = await rewrite(result, 'ppt/_rels/presentation.xml.rels', (value) =>
      value.replace(
        '</Relationships>',
        '<Relationship Id="unused" Type="test" Target="slides/missing.xml"/></Relationships>',
      ),
    );
    expect(() => verifyTemplateDeck(dangling, table, data)).toThrow('native-relation-invalid');
  });
  it('rejects all placeholders required by the reference verifier', async () => {
    const words = [
      '页面标题',
      '卡片标题',
      '卡片正文',
      '底部结论',
      '步骤名',
      '步骤说明',
      '补充说明',
      '左表头',
      '右表头',
      '左列正文',
      '右列正文',
      '维度',
      '对比维度',
      '方案1',
      '方案2',
      '方案3',
      '主标题',
      '副标题',
      '导语',
      '落款',
      '页脚',
      '序号',
      '目录项',
      '章节名称',
      '章节标题',
      '章节说明',
      '时间线节点',
      '时间线说明',
      '年份',
      '要点标题',
      '要点说明',
      '结论标题',
      '结论说明',
      '指标名称',
      '口径说明',
      '解读标题',
      '解读正文',
      '层级名称',
      '层级说明',
      '清单条目',
      '结尾主标',
      '结尾副标',
      '联系方式',
      '单元格',
      '内容',
      '项目1',
      '项目2',
      '项目3',
      '项目4',
      '项目5',
      '表头1',
      '表头2',
      '表头3',
      '表头4',
      '图表标题',
      '系列一',
      '本期',
      '同期',
    ];
    for (const word of words) {
      const data = content();
      texts(data, '1')[0] = word;
      await expect(renderTemplateDeck(template, table, data)).rejects.toBeInstanceOf(TemplateDeckError);
    }
  });
  it('renders the supplied 16 pages, all 211 slots, 24 table cells and 2 editable native charts', async () => {
    const result = await renderTemplateDeck(template, table, content());
    expect(verifyTemplateDeck(result, table, content())).toEqual({
      status: 'passed',
      pages: 16,
      slots: 211,
      tableCells: 24,
      charts: 2,
      fonts: table.fonts,
    });
  });

  it('preserves every template part except addressed slide, chart and embedded workbook parts', async () => {
    const result = await renderTemplateDeck(template, table, content());
    const sourceZip = await JSZip.loadAsync(template),
      resultZip = await JSZip.loadAsync(result);
    for (const [name, part] of Object.entries(sourceZip.files)) {
      if (part.dir || /^ppt\/(slides\/slide\d+\.xml|charts\/chart\d+\.xml|embeddings\/.*\.xlsx)$/.test(name)) continue;
      expect(await resultZip.file(name)!.async('nodebuffer'), name).toEqual(await part.async('nodebuffer'));
    }
  });

  it('inserts multiline paragraphs adjacent and preserves the later addressed paragraph and all run styles', async () => {
    const data = content();
    texts(data, '1')[0] = 'Alpha\nBeta';
    texts(data, '1')[1] = 'Gamma\nDelta';
    const result = await renderTemplateDeck(template, table, data);
    expect(verifyTemplateDeck(result, table, data).status).toBe('passed');
    const archive = new Archive(result, { mode: 'jszip' });
    const doc = await archive.readXml('ppt/slides/slide1.xml');
    const shape = Array.from(doc.getElementsByTagName('p:sp')).find(
      (node) => node.getElementsByTagName('p:cNvPr')[0].getAttribute('id') === '6',
    )!;
    const paragraphs = Array.from(shape.getElementsByTagName('a:p'));
    expect(paragraphs.map((node) => node.getElementsByTagName('a:t')[0].textContent)).toEqual([
      'Alpha',
      'Beta',
      'Gamma',
      'Delta',
    ]);
    expect(paragraphs.map((node) => node.getElementsByTagName('a:rPr')[0].getAttribute('sz'))).toEqual([
      '4000',
      '4000',
      '2200',
      '2200',
    ]);
  });

  it('locates addressed text inside a nested group', async () => {
    const grouped = await rewrite(template, 'ppt/slides/slide1.xml', (source) =>
      source.replace(
        /<p:sp><p:nvSpPr><p:cNvPr id="6"[\s\S]*?<\/p:sp>/,
        (shape) =>
          `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="999" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shape}</p:grpSp>`,
      ),
    );
    const result = await renderTemplateDeck(grouped, table, content());
    expect(verifyTemplateDeck(result, table, content()).slots).toBe(211);
    expect(await xml(result, 'ppt/slides/slide1.xml')).toContain('p:grpSp');
  });

  it('counts unicode codepoints for the character cap', async () => {
    const data = content();
    texts(data, '1')[0] = '\u{1f642}'.repeat(26);
    expect(verifyTemplateDeck(await renderTemplateDeck(template, table, data), table, data).status).toBe('passed');
    texts(data, '1')[0] += '\u{1f642}';
    await expect(renderTemplateDeck(template, table, data)).rejects.toThrow('text-overflow');
  });

  it('rejects explicit or wrapped line counts beyond the declared cap', async () => {
    const data = content();
    texts(data, '1')[0] = 'A\nB\nC';
    await expect(renderTemplateDeck(template, table, data)).rejects.toThrow('line-overflow');
    texts(data, '1')[0] = 'A'.repeat(14) + '\nB'.repeat(1);
    await expect(renderTemplateDeck(template, table, data)).rejects.toThrow('line-overflow');
  });

  it('rejects missing content, missing slot addresses and cardinality differences', async () => {
    await expect(renderTemplateDeck(template, table, {})).rejects.toThrow('content-invalid');
    const invalid = structuredClone(table);
    invalid.pages[0].text_slots[0].address.shape_id = 9999;
    await expect(renderTemplateDeck(template, invalid, content())).rejects.toThrow('slot-missing');
    const mismatch = content();
    texts(mismatch, '1').pop();
    await expect(renderTemplateDeck(template, table, mismatch)).rejects.toThrow('slot-content-count');
  });

  it('rejects a missing native chart title and invalid data lengths', async () => {
    const data = content();
    chart(data, '10').title = '';
    await expect(renderTemplateDeck(template, table, data)).rejects.toThrow('chart-title-missing');
    chart(data, '10').title = 'Real chart';
    chart(data, '10').series[0].values.pop();
    await expect(renderTemplateDeck(template, table, data)).rejects.toThrow('chart-data-invalid');
  });

  it('refreshes categories, names, values, formulas and the native workbook consistently', async () => {
    const data = content();
    Object.assign(chart(data, '11'), {
      title: 'A & B < trend',
      categories: ['2026', '2027', '2028'],
      series: [{ name: 'New & One', values: [3, 5, 8] }],
    });
    const result = await renderTemplateDeck(template, table, data);
    expect(verifyTemplateDeck(result, table, data).charts).toBe(2);
    const chartXml = await xml(result, 'ppt/charts/chart2.xml');
    expect(chartXml).toContain('Sheet1!$B$2:$B$4');
    expect(chartXml).toContain('Sheet1!$A$2:$A$4');
    expect(chartXml).toContain('<c:lineChart>');
    expect(chartXml).toContain('A &amp; B &lt; trend');
    const zip = await JSZip.loadAsync(result),
      workbook = new ExcelJS.Workbook();
    const workbookBytes = await zip.file('ppt/embeddings/Microsoft_Excel_Sheet2.xlsx')!.async('nodebuffer');
    await workbook.xlsx.load(workbookBytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    const sheet = workbook.getWorksheet('Sheet1')!;
    expect(sheet.getCell('B1').value).toBe('New & One');
    expect(sheet.getCell('A4').value).toBe('2028');
    expect(sheet.getCell('B4').value).toBe(8);
    expect(sheet.getCell('C1').value).toBeNull();
  });

  it('rejects table font-size drift, inherited slot sizes and fractional sizes on readback', async () => {
    const result = await renderTemplateDeck(template, table, content());
    for (const size of ['1125', '1300', '']) {
      const changed = await rewrite(result, 'ppt/slides/slide13.xml', (source) =>
        source.replace(/(<a:tbl>[\s\S]*?<a:rPr) sz="1500"/, `$1${size ? ` sz="${size}"` : ''}`),
      );
      expect(() => verifyTemplateDeck(changed, table, content())).toThrow('font-size-mismatch');
    }
  });

  it('checks every multiline line rather than only the first line', async () => {
    const data = content();
    texts(data, '1')[0] = 'First\nSecond';
    const result = await renderTemplateDeck(template, table, data);
    const changed = await rewrite(result, 'ppt/slides/slide1.xml', (source) =>
      source.replace('Second</a:t>', 'Tampered</a:t>'),
    );
    expect(() => verifyTemplateDeck(changed, table, data)).toThrow('content-mismatch');
  });

  it('checks table-cell fonts and rejects Microsoft YaHei', async () => {
    const result = await renderTemplateDeck(template, table, content());
    const changed = await rewrite(result, 'ppt/slides/slide13.xml', (source) =>
      source.replace(/(<a:tbl>[\s\S]*?typeface=")[^"]+/, '$1Microsoft YaHei'),
    );
    expect(() => verifyTemplateDeck(changed, table, content())).toThrow('font-not-allowed');
  });

  it('rejects placeholders before generating any output', async () => {
    const data = content();
    texts(data, '1')[0] = '\u4e3b\u6807\u9898';
    await expect(renderTemplateDeck(template, table, data)).rejects.toThrow('placeholder-text');
  });

  it('rejects bitmap media, external relationships and embedded fonts', async () => {
    const result = await renderTemplateDeck(template, table, content());
    for (const [name, value] of [
      ['ppt/media/image1.png', 'bitmap'],
      ['ppt/fonts/font1.fntdata', 'font'],
      [
        'ppt/slides/_rels/untrusted.xml.rels',
        '<Relationships><Relationship Id="r1" Target="https://example.test" TargetMode="External"/></Relationships>',
      ],
    ]) {
      const zip = await JSZip.loadAsync(result);
      zip.file(name, value);
      const changed = await zip.generateAsync({ type: 'nodebuffer' });
      expect(() => verifyTemplateDeck(changed, table, content())).toThrow(TemplateDeckError);
    }
  });

  it('detects workbook tampering even when the chart cache remains correct', async () => {
    const result = await renderTemplateDeck(template, table, content()),
      zip = await JSZip.loadAsync(result);
    const embedded = await JSZip.loadAsync(
      await zip.file('ppt/embeddings/Microsoft_Excel_Sheet1.xlsx')!.async('nodebuffer'),
    );
    const sheet = await embedded.file('xl/worksheets/sheet1.xml')!.async('string');
    embedded.file('xl/worksheets/sheet1.xml', sheet.replace(/(<c r="B2"[^>]*>[\s\S]*?<v>)[^<]+/, '$1999'));
    zip.file('ppt/embeddings/Microsoft_Excel_Sheet1.xlsx', await embedded.generateAsync({ type: 'nodebuffer' }));
    const changed = await zip.generateAsync({ type: 'nodebuffer' });
    expect(() => verifyTemplateDeck(changed, table, content())).toThrow('chart-workbook-mismatch');
  });
});
