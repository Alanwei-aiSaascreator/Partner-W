import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { SLIDEGEN_MAX_PAGES, type SlidegenWarning } from '@clawwork/shared';
import { readSlideSourceFile, readWorkspaceBytes } from './source-file.js';
import { extractSlidegenBlocks } from './blocks.js';
import { evaluateSlide } from './evaluate.js';
import { imageNames } from './resources.js';

interface ReceiptInput {
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
function verify(root: string, receipt: SlideGenerationReceipt) {
  const current = identity(root);
  if (current.dev !== receipt.workspaceIdentity.dev || current.ino !== receipt.workspaceIdentity.ino)
    throw new Error('receipt-workspace-changed');
  const source = readSlideSourceFile(root, receipt.sourceFile);
  const output = readWorkspaceBytes(root, receipt.fileName, receipt.bytes);
  if (hash(source) !== receipt.sourceSha256 || output.length !== receipt.bytes || hash(output) !== receipt.outputSha256)
    throw new Error('receipt-version-mismatch');
  const decks = extractSlidegenBlocks(source).decks;
  if (decks.length !== 1) throw new Error('receipt-version-mismatch');
  const pages = evaluateSlide(decks[0].source);
  const prefix = fs.existsSync(path.join(root, 'assets')) ? 'assets' : '';
  const expected = imageNames(pages).map((name) => path.posix.join(prefix, name));
  if (
    pages.length !== receipt.pages ||
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
