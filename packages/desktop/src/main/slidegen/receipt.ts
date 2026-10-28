import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { SLIDEGEN_MAX_PAGES, type SlidegenWarning } from '@clawwork/shared';
import { readSlideSourceFile, readWorkspaceBytes } from './source-file.js';
import { extractSlidegenBlocks } from './blocks.js';
import { evaluateSlide } from './evaluate.js';
import { imageNames } from './resources.js';
import { parseTemplateDeck } from '../docgen/pptx-template/parse.js';
import { checkNativePpt } from '../docgen/pptx-template/check.js';
import { verifyTemplateDeck, type SlotTable, type TemplateDeckContent } from '../docgen/template-deck/index.js';

interface ReceiptInput {
  sourceFormat?: 'native-template-v5';
  templateContract?: 'templateDeck-v2';
  revision?: number;
  previousOutputSha256?: string;
  previousFileName?: string;
  previousReceiptFile?: string;
  sourceFile: string;
  sourceSha256: string;
  fileName: string;
  outputSha256: string;
  bytes: number;
  pages: number;
  resources: Array<{ file: string; bytes: number; sha256: string }>;
  warnings: SlidegenWarning[];
}
export interface SlideGenerationReceipt extends ReceiptInput {
  schemaVersion: 1;
  workspaceIdentity: { dev: string; ino: string };
  visualReview: 'not-performed';
  artifactIndexed: false;
}
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const sha = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = (value: unknown, max: number) =>
  Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= max;
function relative(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 1024 &&
    !path.isAbsolute(value) &&
    !value.includes('\0') &&
    !value.split(/[\\/]/).includes('..') &&
    !value.includes(':')
  );
}
function parse(value: unknown): SlideGenerationReceipt {
  if (
    !object(value) ||
    value.schemaVersion !== 1 ||
    !relative(value.sourceFile) ||
    !relative(value.fileName) ||
    path.basename(value.fileName) !== value.fileName ||
    !value.fileName.endsWith('.pptx') ||
    !sha(value.sourceSha256) ||
    !sha(value.outputSha256) ||
    !integer(value.bytes, 128 * 1024 * 1024) ||
    !integer(value.pages, SLIDEGEN_MAX_PAGES) ||
    value.visualReview !== 'not-performed' ||
    value.artifactIndexed !== false ||
    (value.sourceFormat !== undefined && value.sourceFormat !== 'native-template-v5') ||
    (value.templateContract !== undefined &&
      (value.templateContract !== 'templateDeck-v2' || value.sourceFormat !== 'native-template-v5')) ||
    (value.sourceFormat === 'native-template-v5' &&
      (!Number.isSafeInteger(value.revision) ||
        Number(value.revision) < 0 ||
        Number(value.revision) > 1000000 ||
        (Number(value.revision) > 0 && !sha(value.previousOutputSha256)))) ||
    !object(value.workspaceIdentity) ||
    typeof value.workspaceIdentity.dev !== 'string' ||
    typeof value.workspaceIdentity.ino !== 'string' ||
    !Array.isArray(value.resources) ||
    value.resources.length > 256 ||
    !Array.isArray(value.warnings) ||
    value.warnings.length > 2000
  )
    throw new Error('receipt-invalid');
  const warningCodes = [
    'layout-out-of-bounds',
    'layout-text-occluded',
    'layout-footer-overlap',
    'layout-text-low-contrast',
  ];
  for (const resource of value.resources) {
    if (
      !object(resource) ||
      !relative(resource.file) ||
      !integer(resource.bytes, 16 * 1024 * 1024) ||
      !sha(resource.sha256)
    )
      throw new Error('receipt-invalid');
  }
  for (const warning of value.warnings) {
    if (
      !object(warning) ||
      !warningCodes.includes(String(warning.code)) ||
      !integer(warning.page, Number(value.pages)) ||
      !Number.isSafeInteger(warning.element) ||
      Number(warning.element) < 0 ||
      typeof warning.detail !== 'string' ||
      warning.detail.length > 2000
    )
      throw new Error('receipt-invalid');
  }
  return value as unknown as SlideGenerationReceipt;
}
function identity(root: string) {
  const stats = fs.statSync(root, { bigint: true });
  return { dev: String(stats.dev), ino: String(stats.ino) };
}
function verify(root: string, receipt: SlideGenerationReceipt, verifyParents = true) {
  const current = identity(root);
  if (current.dev !== receipt.workspaceIdentity.dev || current.ino !== receipt.workspaceIdentity.ino)
    throw new Error('receipt-workspace-changed');
  const source =
    receipt.sourceFormat === 'native-template-v5'
      ? new TextDecoder('utf-8', { fatal: true }).decode(readWorkspaceBytes(root, receipt.sourceFile, 1024 * 1024))
      : readSlideSourceFile(root, receipt.sourceFile);
  const output = readWorkspaceBytes(root, receipt.fileName, receipt.bytes);
  if (hash(source) !== receipt.sourceSha256 || output.length !== receipt.bytes || hash(output) !== receipt.outputSha256)
    throw new Error('receipt-version-mismatch');
  let expected: string[];
  let pageCount: number;
  if (receipt.sourceFormat === 'native-template-v5') {
    if (verifyParents && (receipt.revision ?? 0) > 0) {
      if (!relative(receipt.previousFileName) || !relative(receipt.previousReceiptFile))
        throw new Error('receipt-parent-invalid');
      const parent = parse(
        JSON.parse(readWorkspaceBytes(root, receipt.previousReceiptFile, 1024 * 1024).toString('utf8')),
      );
      if (
        parent.sourceFormat !== 'native-template-v5' ||
        parent.templateContract !== receipt.templateContract ||
        parent.revision !== receipt.revision! - 1 ||
        parent.fileName !== receipt.previousFileName ||
        parent.outputSha256 !== receipt.previousOutputSha256
      )
        throw new Error('receipt-parent-invalid');
      verify(root, parent, false);
    }
    if (receipt.templateContract === 'templateDeck-v2') {
      const raw = JSON.parse(source) as { template?: string; content?: TemplateDeckContent };
      const tableResource = receipt.resources.find((resource) => path.basename(resource.file) === 'detail.json');
      if (
        raw.template !== 'templateDeck' ||
        !raw.content ||
        receipt.resources.length !== 2 ||
        !tableResource ||
        !receipt.resources.some((resource) => path.basename(resource.file) === 'tpl-native.pptx')
      )
        throw new Error('receipt-version-mismatch');
      const detail = readWorkspaceBytes(root, tableResource.file, tableResource.bytes);
      if (hash(detail) !== tableResource.sha256) throw new Error('receipt-version-mismatch');
      const table = JSON.parse(detail.toString('utf8')) as SlotTable;
      pageCount = verifyTemplateDeck(output, table, raw.content).pages;
      expected = receipt.resources.map((resource) => resource.file);
    } else {
      const parsed = parseTemplateDeck(JSON.parse(source), { controlledNative: true });
      if (!parsed.ok || !parsed.deck.controlledNative) throw new Error('receipt-version-mismatch');
      pageCount = parsed.deck.slides.length;
      if (
        receipt.resources.length !== 2 ||
        !receipt.resources.some((resource) => path.basename(resource.file) === 'business-deck-v5.pptx') ||
        !receipt.resources.some((resource) => path.basename(resource.file) === 'blank-root.pptx')
      )
        throw new Error('receipt-version-mismatch');
      checkNativePpt(output, parsed.deck);
      expected = receipt.resources.map((resource) => resource.file);
    }
  } else {
    const decks = extractSlidegenBlocks(source).decks;
    if (decks.length !== 1) throw new Error('receipt-version-mismatch');
    const pages = evaluateSlide(decks[0].source);
    pageCount = pages.length;
    const prefix = fs.existsSync(path.join(root, 'assets')) ? 'assets' : '';
    expected = imageNames(pages).map((name) => path.posix.join(prefix, name));
  }
  if (
    pageCount !== receipt.pages ||
    expected.length !== receipt.resources.length ||
    new Set(receipt.resources.map((entry) => entry.file)).size !== expected.length ||
    expected.some((file) => !receipt.resources.some((entry) => entry.file === file))
  )
    throw new Error('receipt-version-mismatch');
  let total = 0;
  for (const resource of receipt.resources) {
    const bytes = readWorkspaceBytes(root, resource.file, resource.bytes);
    total += bytes.length;
    if (bytes.length !== resource.bytes || hash(bytes) !== resource.sha256 || total > 64 * 1024 * 1024)
      throw new Error('receipt-version-mismatch');
  }
  const after = identity(root);
  if (after.dev !== current.dev || after.ino !== current.ino) throw new Error('receipt-workspace-changed');
}

export function writeSlideGenerationReceipt(workspace: string, input: ReceiptInput): string {
  if (!relative(input.fileName) || path.basename(input.fileName) !== input.fileName)
    throw new Error('receipt-path-invalid');
  const root = fs.realpathSync(workspace);
  const receipt = parse({
    ...input,
    schemaVersion: 1,
    workspaceIdentity: identity(root),
    visualReview: 'not-performed',
    artifactIndexed: false,
  });
  const serialized = JSON.stringify(receipt) + '\n';
  if (Buffer.byteLength(serialized, 'utf8') > 1024 * 1024) throw new Error('receipt-too-large');
  verify(root, receipt);
  const file = path.join(root, `.royin-ppt-receipt-${randomUUID()}.json`);
  const staging = file + '.tmp';
  let owned: fs.BigIntStats | undefined;
  try {
    const fd = fs.openSync(staging, 'wx');
    try {
      owned = fs.fstatSync(fd, { bigint: true });
      fs.writeFileSync(fd, serialized);
    } finally {
      fs.closeSync(fd);
    }
    verify(root, receipt);
    fs.renameSync(staging, file);
    return file;
  } finally {
    try {
      const current = fs.lstatSync(staging, { bigint: true });
      if (owned && current.dev === owned.dev && current.ino === owned.ino) fs.unlinkSync(staging);
    } catch {
      /* A committed receipt has no staging file. */
    }
  }
}

export function readSlideGenerationReceipt(workspace: string, file: string): SlideGenerationReceipt {
  const root = fs.realpathSync(workspace);
  let receipt: SlideGenerationReceipt;
  try {
    receipt = parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readWorkspaceBytes(root, file, 1024 * 1024))),
    );
  } catch {
    throw new Error('receipt-invalid');
  }
  verify(root, receipt);
  return receipt;
}
