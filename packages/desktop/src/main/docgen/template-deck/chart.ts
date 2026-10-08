import ExcelJS from 'exceljs';
import type { XmlDocument, XmlElement } from 'pptx-automizer';
import type Archive from 'pptx-automizer/dist/helper/archive/archive-jszip.js';
import { readZipEntry } from '../../preview/zip-entry.js';
import type { ChartMeta, TemplateChartData } from './types.js';
import { fail } from './input.js';
import { children, descendants, first, parseXml, relationshipTarget, replaceParagraph } from './xml.js';

const namespace = 'http://schemas.openxmlformats.org/drawingml/2006/chart';

function element(doc: XmlDocument, tag: string, value?: string): XmlElement {
  const node = doc.createElementNS(namespace, tag);
  if (value !== undefined) node.textContent = value;
  return node;
}

function cache(
  doc: XmlDocument,
  parent: XmlElement,
  values: (string | number)[],
  formula: string,
  numeric: boolean,
): void {
  const reference = first(parent, numeric ? 'c:numRef' : 'c:strRef');
  const target = reference && first(reference, numeric ? 'c:numCache' : 'c:strCache');
  const range = reference && first(reference, 'c:f');
  if (!target || !range) fail('chart-invalid', 'unsupported chart reference');
  range.textContent = formula;
  for (const node of children(target)) if (node.nodeName !== 'c:formatCode') target.removeChild(node);
  const count = element(doc, 'c:ptCount');
  count.setAttribute('val', String(values.length));
  target.appendChild(count);
  values.forEach((value, index) => {
    const point = element(doc, 'c:pt');
    point.setAttribute('idx', String(index));
    point.appendChild(element(doc, 'c:v', String(value)));
    target.appendChild(point);
  });
}

export function workbookPart(read: (name: string) => string, part: string, doc: XmlDocument): string {
  const id = first(doc, 'c:externalData')?.getAttribute('r:id');
  if (!id) fail('chart-workbook-missing', part);
  return relationshipTarget(read, part, id, 'ppt/embeddings/');
}

export async function fillChart(
  archive: Archive,
  part: string,
  meta: ChartMeta,
  data: TemplateChartData,
): Promise<void> {
  const doc = await archive.readXml(part);
  const series = descendants(doc, 'c:ser');
  if (!first(doc, meta.kind === 'bar' ? 'c:barChart' : 'c:lineChart') || data.series.length > series.length)
    fail('chart-type-mismatch', part);
  const title = first(doc, 'c:title'),
    paragraph = title && first(title, 'a:p');
  if (!paragraph) fail('chart-title-missing', 'template title missing');
  replaceParagraph(paragraph, data.title);
  const relationsName = part.replace(/([^/]+)$/, '_rels/$1.rels');
  const relations = await archive.read(relationsName, 'string');
  const embedded = workbookPart(
    (name) => {
      if (name !== relationsName) fail('native-relation-invalid', name);
      return String(relations);
    },
    part,
    doc,
  );
  const workbook = new ExcelJS.Workbook();
  const bytes = await archive.read(embedded, 'nodebuffer');
  if (!Buffer.isBuffer(bytes)) fail('chart-workbook-missing', embedded);
  await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const originalFormula = first(series[0], 'c:f')?.textContent ?? '';
  const sheetName = originalFormula.split('!')[0].replace(/^'|'$/g, '').replace(/''/g, "'");
  const sheet = workbook.getWorksheet(sheetName);
  if (!sheet) fail('chart-workbook-missing', sheetName);
  sheet.eachRow((row) =>
    row.eachCell((cell) => {
      cell.value = null;
    }),
  );
  const last = data.categories.length + 1;
  const escapedSheet = /^[A-Za-z_][A-Za-z0-9_]*$/.test(sheet.name) ? sheet.name : `'${sheet.name.replace(/'/g, "''")}'`;
  data.categories.forEach((category, index) => {
    sheet.getCell(index + 2, 1).value = category;
  });
  data.series.forEach((dataSeries, index) => {
    const node = series[index],
      column = String.fromCharCode(66 + index);
    cache(doc, first(node, 'c:tx'), [dataSeries.name], `${escapedSheet}!$${column}$1`, false);
    cache(doc, first(node, 'c:cat'), data.categories, `${escapedSheet}!$A$2:$A$${last}`, false);
    cache(doc, first(node, 'c:val'), dataSeries.values, `${escapedSheet}!$${column}$2:$${column}$${last}`, true);
    sheet.getCell(1, index + 2).value = dataSeries.name;
    dataSeries.values.forEach((value, row) => {
      sheet.getCell(row + 2, index + 2).value = value;
    });
  });
  for (const node of series.slice(data.series.length)) node.parentNode?.removeChild(node);
  archive.writeXml(part, doc);
  await archive.write(embedded, Buffer.from(await workbook.xlsx.writeBuffer()));
}

function points(parent: XmlElement, tag: string): string[] {
  const cached = first(parent, tag);
  if (!cached) fail('chart-data-mismatch', 'cache missing');
  const points = children(cached, 'c:pt');
  if (
    Number(first(cached, 'c:ptCount')?.getAttribute('val')) !== points.length ||
    points.some((point, index) => Number(point.getAttribute('idx')) !== index)
  )
    fail('chart-data-mismatch', 'cache point count or index invalid');
  return points.map((point) => first(point, 'c:v')?.textContent ?? '');
}

function readWorkbook(buffer: Buffer, sheetName: string): Map<string, string> {
  const read = (name: string) => {
    const bytes = readZipEntry(buffer, name);
    if (!bytes) fail('chart-workbook-missing', name);
    return bytes.toString('utf8');
  };
  const workbook = parseXml(read('xl/workbook.xml'));
  const sheet = descendants(workbook, 'sheet').find((node) => node.getAttribute('name') === sheetName);
  if (!sheet) fail('chart-workbook-missing', sheetName);
  const part = relationshipTarget(read, 'xl/workbook.xml', sheet.getAttribute('r:id') ?? '', 'xl/worksheets/');
  const sharedBytes = readZipEntry(buffer, 'xl/sharedStrings.xml');
  const shared = sharedBytes
    ? descendants(parseXml(sharedBytes.toString('utf8')), 'si').map((node) =>
        descendants(node, 't')
          .map((text) => text.textContent ?? '')
          .join(''),
      )
    : [];
  const cells = new Map<string, string>();
  for (const cell of descendants(parseXml(read(part)), 'c')) {
    const type = cell.getAttribute('t'),
      value = first(cell, 'v')?.textContent ?? '';
    const resolved =
      type === 's'
        ? shared[Number(value)]
        : type === 'inlineStr'
          ? descendants(cell, 't')
              .map((node) => node.textContent ?? '')
              .join('')
          : value;
    cells.set(cell.getAttribute('r') ?? '', resolved ?? '');
  }
  return cells;
}

export function verifyChart(
  read: (name: string) => string,
  readBytes: (name: string) => Buffer,
  part: string,
  meta: ChartMeta,
  data: TemplateChartData,
  page: number,
): XmlDocument {
  const doc = parseXml(read(part)),
    series = descendants(doc, 'c:ser');
  if (!first(doc, meta.kind === 'bar' ? 'c:barChart' : 'c:lineChart')) fail('chart-type-mismatch', part, page);
  if (series.length !== data.series.length) fail('chart-data-mismatch', 'series count', page);
  const title = first(doc, 'c:title');
  if (
    !title ||
    descendants(title, 'a:t')
      .map((node) => node.textContent ?? '')
      .join('') !== data.title
  )
    fail('chart-title-mismatch', part, page);
  const formula = first(series[0], 'c:f')?.textContent ?? '';
  const sheetName = formula.split('!')[0].replace(/^'|'$/g, '').replace(/''/g, "'");
  const cells = readWorkbook(readBytes(workbookPart(read, part, doc)), sheetName);
  const prefix = formula.split('!')[0],
    last = data.categories.length + 1;
  series.forEach((node, index) => {
    const expected = data.series[index],
      column = String.fromCharCode(66 + index);
    const tx = first(node, 'c:tx'),
      cat = first(node, 'c:cat'),
      val = first(node, 'c:val');
    if (
      !tx ||
      !cat ||
      !val ||
      JSON.stringify(points(tx, 'c:strCache')) !== JSON.stringify([expected.name]) ||
      JSON.stringify(points(cat, 'c:strCache')) !== JSON.stringify(data.categories) ||
      JSON.stringify(points(val, 'c:numCache').map(Number)) !== JSON.stringify(expected.values)
    )
      fail('chart-data-mismatch', `series ${index}`, page);
    const ranges = [`${prefix}!$${column}$1`, `${prefix}!$A$2:$A$${last}`, `${prefix}!$${column}$2:$${column}$${last}`];
    if ([tx, cat, val].some((target, cursor) => first(target, 'c:f')?.textContent !== ranges[cursor]))
      fail('chart-formula-mismatch', `series ${index}`, page);
    if (
      cells.get(`${column}1`) !== expected.name ||
      data.categories.some(
        (category, row) =>
          cells.get(`A${row + 2}`) !== category || Number(cells.get(`${column}${row + 2}`)) !== expected.values[row],
      )
    )
      fail('chart-workbook-mismatch', `series ${index}`, page);
  });
  for (const [address, value] of cells) {
    if (!value) continue;
    const match = /^([A-Z]+)(\d+)$/.exec(address);
    if (!match || match[1].length !== 1 || match[1].charCodeAt(0) - 65 > data.series.length || Number(match[2]) > last)
      fail('chart-workbook-mismatch', `unexpected cell ${address}`, page);
  }
  return doc;
}
