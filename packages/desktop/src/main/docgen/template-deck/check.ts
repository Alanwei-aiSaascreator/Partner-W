import path from 'node:path';
import type { XmlDocument, XmlElement } from 'pptx-automizer';
import { listZipEntries, readZipEntry } from '../../preview/zip-entry.js';
import { TemplateDeckError, type SlotTable, type TemplateDeckContent, type TemplateDeckVerification } from './types.js';
import { fail, validateContent } from './input.js';
import {
  bodyOf,
  chartPart,
  children,
  descendants,
  first,
  paragraphOf,
  paragraphText,
  parseXml,
  relationshipTarget,
  shapes,
} from './xml.js';
import { verifyChart, workbookPart } from './chart.js';

function checkFont(doc: XmlDocument, table: SlotTable, fonts: Set<string>): void {
  const tags = ['a:rPr', 'a:defRPr', 'a:endParaRPr'];
  for (const tag of tags)
    for (const properties of descendants(doc, tag)) {
      for (const face of ['a:latin', 'a:ea', 'a:cs']) {
        const name = first(properties, face)?.getAttribute('typeface');
        if (!name) continue;
        if (/yahei|msyh|\u96c5\u9ed1/i.test(name) || !table.fonts.includes(name)) fail('font-not-allowed', name);
        fonts.add(name);
      }
      const size = properties.getAttribute('sz');
      if (size && (!/^\d+$/.test(size) || Number(size) % 100 !== 0))
        fail('font-size-mismatch', 'fractional or invalid point size');
    }
}

function checkSlotSize(paragraph: XmlElement, expected: number, page: number, slotId: string): void {
  for (const run of children(paragraph, 'a:r')) {
    const properties = children(run, 'a:rPr')[0];
    if (!properties || properties.getAttribute('sz') !== String(expected * 100))
      fail('font-size-mismatch', `expected explicit ${expected}pt`, page, slotId);
  }
}

export function verifyTemplateDeck(
  buffer: Buffer,
  table: SlotTable,
  content: TemplateDeckContent,
): TemplateDeckVerification {
  const input = validateContent(table, content),
    entries = listZipEntries(buffer),
    fonts = new Set<string>();
  const partSet = new Set(entries),
    bytesCache = new Map<string, Buffer>();
  const readBytes = (name: string) => {
    const cached = bytesCache.get(name);
    if (cached) return cached;
    const bytes = readZipEntry(buffer, name);
    if (!bytes) fail('package-part-missing', name);
    bytesCache.set(name, bytes);
    return bytes;
  };
  const read = (name: string) => readBytes(name).toString('utf8');
  const slideParts = entries.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  if (
    slideParts.length !== input.size ||
    descendants(parseXml(read('ppt/presentation.xml')), 'p:sldId').length !== input.size
  )
    fail('slide-count-mismatch', `expected ${input.size}`);
  const presentation = parseXml(read('ppt/presentation.xml'));
  const orderedParts = descendants(presentation, 'p:sldId').map((node) =>
    relationshipTarget(read, 'ppt/presentation.xml', node.getAttribute('r:id') ?? '', 'ppt/slides/'),
  );
  const expectedParts = [...input.keys()].map((number) => `ppt/slides/slide${number}.xml`);
  if (
    JSON.stringify(orderedParts) !== JSON.stringify(expectedParts) ||
    slideParts.some((part) => !expectedParts.includes(part))
  )
    fail('slide-order-mismatch', 'presentation must reference each selected layout in natural order');
  const size = first(presentation, 'p:sldSz');
  if (
    table.slide_size_emu &&
    (!size ||
      Number(size.getAttribute('cx')) !== table.slide_size_emu[0] ||
      Number(size.getAttribute('cy')) !== table.slide_size_emu[1])
  )
    fail('slide-size-mismatch', 'template dimensions changed');
  for (const name of entries) {
    if (name.startsWith('ppt/media/')) fail('media-not-allowed', name);
    if (name.startsWith('ppt/') && /(?:^|\/)(?:fonts?|[^/]+\.(?:fntdata|odttf))(?:\/|$)/i.test(name))
      fail('embedded-font-not-allowed', name);
    if (name.endsWith('.rels')) {
      const owner = name === '_rels/.rels' ? '' : name.replace(/(^|\/)_rels\/([^/]+)\.rels$/, '$1$2');
      if (owner === name || (owner && !partSet.has(owner))) fail('native-relation-invalid', name);
      const ids = new Set<string>();
      for (const node of descendants(parseXml(read(name)), 'Relationship')) {
        if (node.getAttribute('TargetMode') === 'External') fail('external-relation-not-allowed', name);
        const target = node.getAttribute('Target'),
          id = node.getAttribute('Id');
        const resolved =
          target &&
          path.posix.normalize(
            target.startsWith('/') ? target.slice(1) : path.posix.join(path.posix.dirname(owner), target),
          );
        if (!id || ids.has(id) || !resolved || !partSet.has(resolved)) fail('native-relation-invalid', name);
        ids.add(id);
      }
    }
  }
  for (const node of descendants(parseXml(read('[Content_Types].xml')), 'Override'))
    if (!partSet.has((node.getAttribute('PartName') ?? '').replace(/^\//, '')))
      fail('native-relation-invalid', 'content type references a missing part');
  let slotsChecked = 0,
    tableCells = 0,
    charts = 0,
    actualTables = 0;
  const expectedCharts = new Set<string>(),
    expectedWorkbooks = new Set<string>();
  for (const page of table.pages.filter((item) => input.has(item.slide_number))) {
    const data = input.get(page.slide_number)!,
      number = data.outputPage;
    try {
      const part = `ppt/slides/slide${page.slide_number}.xml`,
        doc = parseXml(read(part));
      const index = shapes(doc),
        slots = page.text_slots.filter((slot) => slot.editable);
      checkFont(doc, table, fonts);
      actualTables += descendants(doc, 'a:tbl').length;
      slots.forEach((slot, cursor) => {
        const body = bodyOf(index, slot.address, number, slot.slot_id),
          lines = data.texts[cursor].split('\n');
        const sameContainer = (candidate: typeof slot) =>
          candidate.address.shape_id === slot.address.shape_id &&
          JSON.stringify(candidate.address.cell) === JSON.stringify(slot.address.cell);
        const added = slots.reduce(
          (sum, candidate, candidateCursor) =>
            sum +
            (sameContainer(candidate) && candidate.address.paragraph < slot.address.paragraph
              ? data.texts[candidateCursor].split('\n').length - 1
              : 0),
          0,
        );
        const paragraph = slot.address.paragraph + added;
        lines.forEach((line, lineIndex) => {
          const node = paragraphOf(body, paragraph + lineIndex, number, slot.slot_id);
          if (paragraphText(node) !== line) fail('content-mismatch', `line ${lineIndex}`, number, slot.slot_id);
          checkSlotSize(node, slot.font_size_pt, number, slot.slot_id);
        });
        slotsChecked++;
        if (slot.kind === 'table_cell') tableCells++;
      });
      if (page.chart && data.chart) {
        const chart = chartPart(read, part, index, page.chart.shape_id);
        const chartDoc = verifyChart(read, readBytes, chart, page.chart, data.chart, number);
        expectedCharts.add(chart);
        expectedWorkbooks.add(workbookPart(read, chart, chartDoc));
        checkFont(chartDoc, table, fonts);
        const defaults = descendants(chartDoc, 'a:defRPr').map((node) => Number(node.getAttribute('sz')));
        if (!defaults.includes(page.chart.font_size_pt * 100)) fail('font-size-mismatch', 'chart default size', number);
        charts++;
      }
    } catch (error) {
      if (error instanceof TemplateDeckError)
        throw new TemplateDeckError(
          error.diagnostics.map((item) => ({
            ...item,
            page: number,
            detail: `layout ${page.slide_number}: ${item.detail}`,
          })),
        );
      throw error;
    }
  }
  const chartParts = entries.filter((name) => /^ppt\/charts\/[^/]+\.xml$/.test(name));
  if (chartParts.length !== charts || chartParts.some((name) => !expectedCharts.has(name)))
    fail('chart-count-mismatch', 'native chart count');
  const workbooks = entries.filter((name) => /^ppt\/embeddings\/[^/]+$/.test(name));
  if (workbooks.length !== expectedWorkbooks.size || workbooks.some((name) => !expectedWorkbooks.has(name)))
    fail('chart-count-mismatch', 'orphan or missing native workbook');
  const expectedTables = new Set(
    table.pages
      .filter((page) => input.has(page.slide_number))
      .flatMap((page) =>
        page.text_slots
          .filter((slot) => slot.kind === 'table_cell')
          .map((slot) => `${page.slide_number}:${slot.address.shape_id}`),
      ),
  ).size;
  if (actualTables !== expectedTables) fail('table-count-mismatch', 'native table count');
  if (!fonts.size) fail('font-not-allowed', 'no explicit fonts found');
  return {
    status: 'passed',
    pages: input.size,
    slots: slotsChecked,
    tableCells,
    charts,
    fonts: [...fonts].sort(),
  };
}
