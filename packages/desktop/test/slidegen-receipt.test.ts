import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import PptxGenJS from 'pptxgenjs';
import { afterEach, beforeEach, expect, it } from 'vitest';
import * as receipts from '../src/main/slidegen/receipt.js';

let root = '';
let workspace = '';
const source = '```slidegen\n// title: Report\n<Slide><Text>One</Text></Slide>\n```';
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
let output: Buffer;
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'slidegen-receipt-'));
  workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'report.slidegen'), source);
  const pptx = new PptxGenJS();
  pptx.addSlide().addText('One', { x: 1, y: 1, w: 5, h: 1 });
  output = (await pptx.write({ outputType: 'nodebuffer' })) as Buffer;
  fs.writeFileSync(path.join(workspace, 'report.pptx'), output);
});
afterEach(() => {
  if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('outside temp');
  fs.rmSync(root, { recursive: true, force: true });
});
function input() {
  return {
    sourceFile: 'report.slidegen',
    sourceSha256: digest(source),
    fileName: 'report.pptx',
    outputSha256: digest(output),
    bytes: output.length,
    pages: 1,
    resources: [],
    warnings: [],
  };
}
function write(value = input()) {
  expect(receipts.writeSlideGenerationReceipt).toBeTypeOf('function');
  return receipts.writeSlideGenerationReceipt(workspace, value);
}

it('records actual source and final file versions without claiming indexing or visual quality', () => {
  const file = write();
  expect(path.basename(file)).toMatch(/^\.royin-ppt-receipt-.*\.json$/);
  const value = receipts.readSlideGenerationReceipt(workspace, file);
  expect(value).toMatchObject({ ...input(), schemaVersion: 1, visualReview: 'not-performed', artifactIndexed: false });
  expect(fs.readFileSync(path.join(workspace, 'report.pptx'))).toEqual(output);
});

it.each(['source', 'output'])('rejects a changed %s instead of reusing a stale generation', (kind) => {
  const file = write();
  fs.writeFileSync(path.join(workspace, kind === 'source' ? 'report.slidegen' : 'report.pptx'), 'changed');
  expect(() => receipts.readSlideGenerationReceipt(workspace, file)).toThrow('receipt-version-mismatch');
});

it('binds actual image bytes and rejects a changed resource', () => {
  fs.mkdirSync(path.join(workspace, 'assets'));
  fs.writeFileSync(path.join(workspace, 'assets/pixel.png'), 'pixel');
  const imageSource = source.replace('<Slide>', '<Slide><Image src="assets/pixel.png"/>');
  fs.writeFileSync(path.join(workspace, 'report.slidegen'), imageSource);
  const value = {
    ...input(),
    sourceSha256: digest(imageSource),
    resources: [{ file: 'assets/pixel.png', bytes: 5, sha256: digest('pixel') }],
  };
  const file = receipts.writeSlideGenerationReceipt(workspace, value);
  expect(receipts.readSlideGenerationReceipt(workspace, file).resources).toEqual(value.resources);
  fs.writeFileSync(path.join(workspace, 'assets/pixel.png'), 'other');
  expect(() => receipts.readSlideGenerationReceipt(workspace, file)).toThrow('receipt-version-mismatch');
});

it('rejects copied receipts after the authorized root is replaced with identical files', () => {
  const file = write();
  fs.renameSync(workspace, path.join(root, 'old'));
  fs.mkdirSync(workspace);
  fs.cpSync(path.join(root, 'old'), workspace, { recursive: true });
  expect(() => receipts.readSlideGenerationReceipt(workspace, file)).toThrow('receipt-workspace-changed');
});

it('accepts the authorized root as a junction', () => {
  const alias = path.join(root, 'alias');
  fs.symlinkSync(workspace, alias, 'junction');
  const file = receipts.writeSlideGenerationReceipt(alias, input());
  expect(receipts.readSlideGenerationReceipt(alias, file).sourceSha256).toBe(digest(source));
});

it('rejects output links escaping the root without writing metadata', () => {
  fs.unlinkSync(path.join(workspace, 'report.pptx'));
  fs.mkdirSync(path.join(root, 'external'));
  fs.writeFileSync(path.join(root, 'external/report.pptx'), output);
  fs.symlinkSync(path.join(root, 'external'), path.join(workspace, 'linked'), 'junction');
  expect(() => receipts.writeSlideGenerationReceipt(workspace, { ...input(), fileName: 'linked/report.pptx' })).toThrow(
    'receipt-path-invalid',
  );
  expect(fs.readdirSync(path.join(root, 'external'))).toEqual(['report.pptx']);
});

it.each(['bad-json', 'pages', 'path', 'warning'])('rejects malformed receipt data: %s', (kind) => {
  const file = write();
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (kind === 'pages') value.pages = 201;
  if (kind === 'path') value.fileName = '../report.pptx';
  if (kind === 'warning') value.warnings = [{ code: 'made-up', page: 1, element: 0, detail: 'invented' }];
  fs.writeFileSync(file, kind === 'bad-json' ? '{' : JSON.stringify(value));
  expect(() => receipts.readSlideGenerationReceipt(workspace, file)).toThrow('receipt-invalid');
});

it('retains real layout warnings without promoting them to a visual pass', () => {
  const warning = { code: 'layout-footer-overlap' as const, page: 1, element: 2, detail: 'footer overlaps card' };
  const file = receipts.writeSlideGenerationReceipt(workspace, { ...input(), warnings: [warning] });
  expect(receipts.readSlideGenerationReceipt(workspace, file)).toMatchObject({
    warnings: [warning],
    visualReview: 'not-performed',
    artifactIndexed: false,
  });
});

it('does not leave metadata when the producer supplies a wrong final hash', () => {
  expect(() => receipts.writeSlideGenerationReceipt(workspace, { ...input(), outputSha256: digest('wrong') })).toThrow(
    'receipt-version-mismatch',
  );
  expect(fs.readdirSync(workspace).filter((name) => name.startsWith('.royin-ppt-'))).toEqual([]);
});

it('rejects a receipt that omits images referenced by the actual source', () => {
  const imageSource = source.replace('<Slide>', '<Slide><Image src="pixel.png"/>');
  fs.writeFileSync(path.join(workspace, 'report.slidegen'), imageSource);
  fs.writeFileSync(path.join(workspace, 'pixel.png'), 'pixel');
  expect(() =>
    receipts.writeSlideGenerationReceipt(workspace, { ...input(), sourceSha256: digest(imageSource) }),
  ).toThrow('receipt-version-mismatch');
});

it('rejects metadata larger than the reader budget before leaving a receipt', () => {
  const warning = { code: 'layout-footer-overlap' as const, page: 1, element: 2, detail: 'x'.repeat(2000) };
  expect(() =>
    receipts.writeSlideGenerationReceipt(workspace, { ...input(), warnings: Array(600).fill(warning) }),
  ).toThrow('receipt-too-large');
  expect(fs.readdirSync(workspace).filter((name) => name.startsWith('.royin-ppt-'))).toEqual([]);
});
