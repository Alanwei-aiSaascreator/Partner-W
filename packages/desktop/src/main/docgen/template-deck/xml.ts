import path from 'node:path';
import ArchiveModule from 'pptx-automizer/dist/helper/archive/archive-jszip.js';
import type { XmlDocument, XmlElement } from 'pptx-automizer';
import type { SlotAddress } from './types.js';
import { fail } from './input.js';

// Normalize the pinned CommonJS deep export in both Node ESM and test transforms.
export const Archive =
  typeof ArchiveModule === 'function'
    ? ArchiveModule
    : (ArchiveModule as unknown as { default: typeof ArchiveModule }).default;
export const parser = new Archive(Buffer.alloc(0), { mode: 'jszip' });
export const parseXml = (value: string) => parser.parseXml(value);
export const descendants = (element: XmlDocument | XmlElement, tag: string) =>
  Array.from(element.getElementsByTagName(tag));
export const first = (element: XmlDocument | XmlElement, tag: string) => descendants(element, tag)[0];
export function children(element: XmlElement, tag?: string): XmlElement[] {
  return Array.from(element.childNodes).filter(
    (node): node is XmlElement => node.nodeType === 1 && (!tag || node.nodeName === tag),
  );
}

export function shapes(doc: XmlDocument): Map<number, XmlElement> {
  const result = new Map<number, XmlElement>();
  const tree = first(doc, 'p:spTree');
  if (!tree) fail('slide-invalid', 'missing shape tree');
  function visit(parent: XmlElement): void {
    for (const shape of children(parent)) {
      if (!['p:sp', 'p:graphicFrame', 'p:grpSp', 'p:pic', 'p:cxnSp'].includes(shape.nodeName)) continue;
      const id = Number(first(shape, 'p:cNvPr')?.getAttribute('id'));
      if (!id || result.has(id)) fail('slide-invalid', 'duplicate or missing shape ID');
      result.set(id, shape);
      if (shape.nodeName === 'p:grpSp') visit(shape);
    }
  }
  visit(tree);
  return result;
}

export function bodyOf(index: Map<number, XmlElement>, address: SlotAddress, page: number, slotId: string): XmlElement {
  const shape = index.get(address.shape_id);
  if (!shape) fail('slot-missing', `shape ${address.shape_id}`, page, slotId);
  let body: XmlElement | undefined;
  if (address.cell) {
    const [row, column] = address.cell;
    const table = first(shape, 'a:tbl');
    const targetRow = table && children(table, 'a:tr')[row];
    const cell = targetRow && children(targetRow, 'a:tc')[column];
    body = cell && children(cell, 'a:txBody')[0];
  } else body = children(shape, 'p:txBody')[0];
  if (!body) fail('slot-missing', 'text body or table cell missing', page, slotId);
  return body;
}

export function paragraphOf(body: XmlElement, paragraph: number, page: number, slotId: string): XmlElement {
  const node = children(body, 'a:p')[paragraph];
  if (!Number.isInteger(paragraph) || paragraph < 0 || !node || !children(node, 'a:r').length)
    fail('slot-missing', `paragraph ${paragraph} or run missing`, page, slotId);
  return node;
}

export function paragraphText(node: XmlElement): string {
  return children(node, 'a:r')
    .map((run) => first(run, 'a:t')?.textContent ?? '')
    .join('');
}

export function replaceParagraph(node: XmlElement, value: string): void {
  const runs = children(node, 'a:r');
  if (!runs.length || !first(runs[0], 'a:t')) fail('slot-missing', 'run text missing');
  runs.forEach((run, index) => {
    const text = first(run, 'a:t');
    if (text) text.textContent = index === 0 ? value : '';
  });
}

export function relationshipTarget(read: (name: string) => string, part: string, id: string, prefix: string): string {
  const rels = path.posix.join(path.posix.dirname(part), '_rels', `${path.posix.basename(part)}.rels`);
  const relationship = descendants(parseXml(read(rels)), 'Relationship').find((node) => node.getAttribute('Id') === id);
  const target = relationship?.getAttribute('Target');
  if (!target || relationship?.getAttribute('TargetMode') === 'External') fail('native-relation-invalid', part);
  const resolved = path.posix.normalize(
    target.startsWith('/') ? target.slice(1) : path.posix.join(path.posix.dirname(part), target),
  );
  if (!resolved.startsWith(prefix)) fail('native-relation-invalid', resolved);
  return resolved;
}

export function chartPart(
  read: (name: string) => string,
  slide: string,
  index: Map<number, XmlElement>,
  shapeId: number,
): string {
  const shape = index.get(shapeId);
  const chart = shape && first(shape, 'c:chart');
  const id = chart?.getAttribute('r:id');
  if (!id) fail('chart-missing', `shape ${shapeId}`);
  return relationshipTarget(read, slide, id, 'ppt/charts/');
}
