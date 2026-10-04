import type { XmlElement } from 'pptx-automizer';
import { TemplateDeckError, type SlotTable, type TemplateDeckContent } from './types.js';
import { fail, validateContent } from './input.js';
import {
  Archive,
  bodyOf,
  chartPart,
  descendants,
  paragraphOf,
  relationshipTarget,
  replaceParagraph,
  shapes,
} from './xml.js';
import { fillChart, workbookPart } from './chart.js';
import { verifyTemplateDeck } from './check.js';

export async function renderTemplateDeck(
  template: Buffer,
  table: SlotTable,
  content: TemplateDeckContent,
): Promise<Buffer> {
  const input = validateContent(table, content),
    archive = new Archive(template, { mode: 'jszip' });
  const removed = new Set<string>();
  for (const page of table.pages) {
    const data = input.get(page.slide_number);
    try {
      const part = `ppt/slides/slide${page.slide_number}.xml`,
        doc = await archive.readXml(part);
      const index = shapes(doc);
      if (!data) {
        // Selection must not conceal broken addresses in the supplied catalog.
        for (const slot of page.text_slots.filter((item) => item.editable)) {
          const body = bodyOf(index, slot.address, page.slide_number, slot.slot_id);
          paragraphOf(body, slot.address.paragraph, page.slide_number, slot.slot_id);
        }
        continue;
      }
      const slots = page.text_slots.filter((slot) => slot.editable);
      const captured = slots.map((slot, cursor) => ({
        paragraph: paragraphOf(
          bodyOf(index, slot.address, data.outputPage, slot.slot_id),
          slot.address.paragraph,
          data.outputPage,
          slot.slot_id,
        ),
        text: data.texts[cursor],
      }));
      for (const { paragraph, text } of captured) {
        const lines = text.split('\n');
        const original = paragraph.cloneNode(true) as XmlElement;
        replaceParagraph(paragraph, lines[0]);
        let previous = paragraph;
        for (const line of lines.slice(1)) {
          const clone = original.cloneNode(true) as XmlElement;
          replaceParagraph(clone, line);
          previous.parentNode!.insertBefore(clone, previous.nextSibling);
          previous = clone;
        }
      }
      archive.writeXml(part, doc);
      if (page.chart && data.chart) {
        const relations = `${part.slice(0, part.lastIndexOf('/'))}/_rels/${part.slice(part.lastIndexOf('/') + 1)}.rels`;
        const relationXml = String(await archive.read(relations, 'string'));
        const chart = chartPart(() => relationXml, part, index, page.chart.shape_id);
        await fillChart(archive, chart, page.chart, data.chart);
      }
    } catch (error) {
      if (error instanceof TemplateDeckError)
        throw new TemplateDeckError(
          error.diagnostics.map((item) => ({
            ...item,
            page: data?.outputPage ?? item.page,
            detail: `layout ${page.slide_number}: ${item.detail}`,
          })),
        );
      throw error;
    }
  }
  if (input.size !== table.slide_count) {
    const chartAssets = new Map<number, string[]>();
    for (const page of table.pages.filter((item) => item.chart)) {
      const slide = `ppt/slides/slide${page.slide_number}.xml`,
        relations = slide.replace(/([^/]+)$/, '_rels/$1.rels'),
        relationXml = String(await archive.read(relations, 'string')),
        chart = chartPart(() => relationXml, slide, shapes(await archive.readXml(slide)), page.chart!.shape_id),
        chartRelations = chart.replace(/([^/]+)$/, '_rels/$1.rels'),
        chartRelationXml = String(await archive.read(chartRelations, 'string')),
        embedded = workbookPart(() => chartRelationXml, chart, await archive.readXml(chart));
      chartAssets.set(page.slide_number, [chart, chartRelations, embedded]);
    }
    const retainedAssets = new Set(
      [...chartAssets].filter(([number]) => input.has(number)).flatMap(([, assets]) => assets),
    );
    for (const page of table.pages.filter((item) => !input.has(item.slide_number))) {
      const slide = `ppt/slides/slide${page.slide_number}.xml`;
      removed.add(slide);
      removed.add(slide.replace(/([^/]+)$/, '_rels/$1.rels'));
      for (const asset of chartAssets.get(page.slide_number) ?? []) {
        if (retainedAssets.has(asset)) fail('native-relation-invalid', 'unselected layout shares chart assets');
        removed.add(asset);
      }
    }
    const presentation = await archive.readXml('ppt/presentation.xml'),
      relations = await archive.readXml('ppt/_rels/presentation.xml.rels'),
      relationXml = String(await archive.read('ppt/_rels/presentation.xml.rels', 'string'));
    for (const node of descendants(presentation, 'p:sldId')) {
      const target = relationshipTarget(
        () => relationXml,
        'ppt/presentation.xml',
        node.getAttribute('r:id') ?? '',
        'ppt/slides/',
      );
      if (removed.has(target)) node.parentNode!.removeChild(node);
    }
    for (const node of descendants(relations, 'Relationship')) {
      if (!(node.getAttribute('Type') ?? '').endsWith('/slide')) continue;
      const target = relationshipTarget(
        () => relationXml,
        'ppt/presentation.xml',
        node.getAttribute('Id') ?? '',
        'ppt/slides/',
      );
      if (removed.has(target)) node.parentNode!.removeChild(node);
    }
    archive.writeXml('ppt/presentation.xml', presentation);
    archive.writeXml('ppt/_rels/presentation.xml.rels', relations);
    const types = await archive.readXml('[Content_Types].xml');
    for (const node of descendants(types, 'Override'))
      if (removed.has((node.getAttribute('PartName') ?? '').replace(/^\//, ''))) node.parentNode!.removeChild(node);
    archive.writeXml('[Content_Types].xml', types);
  }
  const zip = await archive.getFinalArchive();
  // readXml buffers parsed parts; remove after its final flush so excluded
  // chart/slide buffers cannot recreate the parts that were pruned.
  for (const part of removed) zip.remove(part);
  const result = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  verifyTemplateDeck(result, table, content);
  return result;
}
