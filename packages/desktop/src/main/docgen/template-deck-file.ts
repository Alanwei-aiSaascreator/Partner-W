import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { SlidegenToolProgress } from '@clawwork/shared';
import {
  renderTemplateDeck,
  verifyTemplateDeck,
  TemplateDeckError,
  type SlotTable,
  type TemplateDeckContent,
} from './template-deck/index.js';
import { ensureTemplateDeckFont } from './template-deck/font.js';
import { readWorkspaceBytes } from '../slidegen/source-file.js';
import { readSlideGenerationReceipt, writeSlideGenerationReceipt } from '../slidegen/receipt.js';
import { documentFileStem } from '../util/document-file-name.js';
import type { NativePptReport } from './native-file.js';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
interface Request {
  template: 'templateDeck';
  title?: string;
  content: TemplateDeckContent;
}
function request(raw: unknown): Request {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('native-slot-source-invalid');
  const value = raw as Record<string, unknown>;
  if (
    value.template !== 'templateDeck' ||
    !value.content ||
    typeof value.content !== 'object' ||
    Array.isArray(value.content) ||
    Object.keys(value).some((key) => !['kind', 'template', 'title', 'content'].includes(key)) ||
    (value.kind !== undefined && value.kind !== 'pptx') ||
    (value.title !== undefined && typeof value.title !== 'string')
  )
    throw Error('native-slot-source-invalid');
  return value as unknown as Request;
}
/**
 * Slot roles that only carry layout display numbering — TOC ordinal (目录序号),
 * list ordinal (清单序号), parallel-segment ordinal (序号) and the
 * section-transition number (章节号). Numbers in these slots are not business
 * facts: adding or trimming a chapter legitimately changes them. 2026-10-04 real case — a
 * user revision trimmed the TOC from 8 entries to 6, the guard treated the dropped
 * ordinals 07/08 as changed facts, and the managed revision was refused. Every other
 * role, including anything unrecognized, stays under the multiset guard.
 */
const displayOrdinalRoles = new Set(['目录序号', '清单序号', '序号', '章节号']);
const facts = (content: TemplateDeckContent, table: SlotTable) => {
  const pages = Object.keys(content)
    .filter((key) => /^\d+$/.test(key))
    .sort((a, b) => Number(a) - Number(b));
  return {
    charts: pages
      .map((key) => (Array.isArray(content[key]) ? undefined : content[key].chart))
      .filter((chart) => chart !== undefined),
    numbers: pages
      .flatMap((key) => {
        const page = content[key];
        const texts = Array.isArray(page) ? page : page.texts;
        const slots = table.pages
          .find((item) => item.slide_number === Number(key))
          ?.text_slots.filter((slot) => slot.editable);
        // Only waive when the texts line up with the slot contract; any other shape
        // keeps every number protected.
        return texts.flatMap((text, index) => {
          const slot = slots && slots.length === texts.length ? slots[index] : undefined;
          return slot && displayOrdinalRoles.has(slot.role) ? [] : (text.match(/\d+(?:\.\d+)?%?/g) ?? []);
        });
      })
      .sort(),
  };
};

export async function renderSlotNativePpt(input: {
  raw: unknown;
  source: Buffer;
  sourceName: string;
  root: string;
  templatesRoot?: string;
  previous?: string;
  assertCurrent(): void;
  ensureFont?: (root: string) => Promise<void>;
  onPage?: (progress: SlidegenToolProgress) => void;
}): Promise<NativePptReport> {
  const base = {
    schemaVersion: 1 as const,
    artifactIndexed: false as const,
    visualReview: 'not-performed' as const,
    officeReview: 'not-performed' as const,
  };
  let fileCreated = false;
  try {
    const raw = request(input.raw);
    if (!input.templatesRoot) throw Error('native-template-unavailable');
    const resourceRoot = path.join(input.templatesRoot, 'native-deck');
    const template = readWorkspaceBytes(resourceRoot, 'tpl-native.pptx', 16 * 1024 * 1024);
    const detail = readWorkspaceBytes(resourceRoot, 'detail.json', 1024 * 1024);
    const table = JSON.parse(detail.toString('utf8')) as SlotTable;
    let revision = 0;
    let previousOutputSha256: string | undefined, previousFileName: string | undefined;
    if (input.previous) {
      const parent = readSlideGenerationReceipt(input.root, input.previous);
      if (parent.sourceFormat !== 'native-template-v5' || parent.templateContract !== 'templateDeck-v2')
        throw Error('native-parent-invalid');
      const previous = request(
        JSON.parse(readWorkspaceBytes(input.root, parent.sourceFile, 1024 * 1024).toString('utf8')),
      );
      const before = facts(previous.content, table),
        after = facts(raw.content, table);
      if (JSON.stringify(before.charts) !== JSON.stringify(after.charts))
        throw Error('native-revision-chart-data-changed');
      if (JSON.stringify(before.numbers) !== JSON.stringify(after.numbers)) throw Error('native-revision-data-changed');
      revision = (parent.revision ?? 0) + 1;
      previousOutputSha256 = parent.outputSha256;
      previousFileName = parent.fileName;
    }
    input.assertCurrent();
    // Rendering is pure ZIP/XML. Host font readiness is required before publishing a file.
    const buffer = await renderTemplateDeck(template, table, raw.content);
    input.assertCurrent();
    await (input.ensureFont ?? ensureTemplateDeckFont)(path.join(resourceRoot, 'fonts'));
    input.assertCurrent();
    if (hash(readWorkspaceBytes(input.root, input.sourceName, 1024 * 1024)) !== hash(input.source))
      throw Error('native-source-changed');
    const verification = verifyTemplateDeck(buffer, table, raw.content);
    const snapshot = fs.mkdtempSync(path.join(input.root, '.royin-native-'));
    const relative = (name: string) => path.relative(input.root, path.join(snapshot, name)).replaceAll('\\', '/');
    fs.writeFileSync(path.join(snapshot, 'source.json'), input.source, { flag: 'wx' });
    const resources = [
      ['tpl-native.pptx', template],
      ['detail.json', detail],
    ] as const;
    const bound = resources.map(([name, bytes]) => {
      fs.writeFileSync(path.join(snapshot, name), bytes, { flag: 'wx' });
      return { file: relative(name), bytes: bytes.length, sha256: hash(bytes) };
    });
    const stem = documentFileStem(raw.title ?? 'presentation', 'presentation');
    const fileName = `${stem.startsWith('.') ? '_' : ''}${stem}-${randomUUID().slice(0, 8)}.pptx`;
    const sourceSha256 = hash(input.source),
      outputSha256 = hash(buffer);
    for (let completed = 1; completed <= verification.pages; completed++) {
      input.assertCurrent();
      input.onPage?.({
        schemaVersion: 1,
        status: 'slidegen-progress',
        sourceSha256,
        completed,
        total: verification.pages,
      });
    }
    input.assertCurrent();
    fs.writeFileSync(path.join(input.root, fileName), buffer, { flag: 'wx' });
    fileCreated = true;
    const receiptFile = path.basename(
      writeSlideGenerationReceipt(input.root, {
        sourceFormat: 'native-template-v5',
        templateContract: 'templateDeck-v2',
        revision,
        previousOutputSha256,
        previousFileName,
        previousReceiptFile: input.previous,
        sourceFile: relative('source.json'),
        sourceSha256,
        fileName,
        outputSha256,
        bytes: buffer.length,
        pages: verification.pages,
        resources: bound,
        warnings: [],
      }),
    );
    return {
      ...base,
      status: 'file-generated',
      fileCreated,
      sourceSha256,
      fileName,
      outputSha256,
      bytes: buffer.length,
      pages: verification.pages,
      receiptFile,
      receiptStatus: 'ready',
      contentReview: 'field-coverage-passed',
      qualityStatus: 'needs-review',
      revision,
      ...(previousOutputSha256 ? { previousOutputSha256 } : {}),
    };
  } catch (error) {
    const code = error instanceof Error ? error.message : 'native-slot-render-failed';
    return {
      ...base,
      status: 'render-failed',
      fileCreated,
      diagnostics:
        error instanceof TemplateDeckError
          ? error.diagnostics
          : [{ code: /^(native-|template-font-)/.test(code) ? code : 'native-slot-render-failed' }],
    };
  }
}
