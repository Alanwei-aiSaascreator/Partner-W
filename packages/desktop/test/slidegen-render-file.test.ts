import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MeasuredElement } from '../src/main/slidegen/measure.js';

vi.mock('electron', () => ({ BrowserWindow: {} }));
vi.mock('../src/main/slidegen/measure.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/slidegen/measure.js')>()),
  measureSlide: vi.fn(),
}));
import { measureSlide } from '../src/main/slidegen/measure.js';
import { renderSlideSourceFile } from '../src/main/slidegen/render-file.js';
import { absolutizeImageSources } from '../src/main/slidegen/measure.js';
import { fileURLToPath } from 'node:url';
import * as receipts from '../src/main/slidegen/receipt.js';

let root = '';
let workspace = '';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  'base64',
);
const base: MeasuredElement = {
  id: 0,
  kind: 'slide',
  x: 0,
  y: 0,
  w: 1280,
  h: 720,
  text: '',
  fontSize: 32,
  fontWeight: '400',
  color: 'rgb(0, 0, 0)',
  textAlign: 'left',
  letterSpacing: 0,
  background: 'rgb(255, 255, 255)',
  backgroundImage: 'none',
  borderRadius: 0,
  borderWidth: 0,
  borderColor: 'rgb(0, 0, 0)',
  lines: 0,
  occludedBy: null,
};
const measured = [
  base,
  { ...base, id: 1, kind: 'text' as const, x: 80, y: 80, w: 900, h: 70, text: '\u6587\u5b57', lines: 1 },
];
function source(body = '<Slide><Text>Body</Text></Slide>') {
  return '```slidegen\n// title: Report\n' + body + '\n```';
}
function write(body = source()) {
  fs.writeFileSync(path.join(workspace, 'report.slidegen'), body);
  return body;
}
async function render(file = 'report.slidegen'): Promise<Record<string, unknown>> {
  return renderSlideSourceFile(file, workspace);
}
function pptxFiles() {
  return fs.readdirSync(workspace).filter((name) => name.endsWith('.pptx'));
}

it.each(['.NET Report', '..Budget'])('keeps a dot-prefixed title collectable: %s', async (title) => {
  write(source().replace('// title: Report', `// title: ${title}`));
  const result = await render();
  expect(result.status).toBe('file-generated');
  expect(String(result.fileName).startsWith('.')).toBe(false);
  expect(receipts.readSlideGenerationReceipt(workspace, String(result.receiptFile)).fileName).toBe(result.fileName);
  expect(pptxFiles()).toHaveLength(1);
});

it('creates a verifiable receipt for the exact file it generated in this turn', async () => {
  write();
  const result = await render();
  expect(result).toMatchObject({ status: 'file-generated', receiptStatus: 'ready', artifactIndexed: false });
  const receipt = receipts.readSlideGenerationReceipt(workspace, String(result.receiptFile));
  expect(receipt).toMatchObject({
    sourceFile: 'report.slidegen',
    sourceSha256: result.sourceSha256,
    fileName: result.fileName,
    outputSha256: result.outputSha256,
    pages: result.pages,
    warnings: result.warnings,
  });
  expect(pptxFiles()).toHaveLength(1);
});

it.each([
  { label: 'fixed error', reason: 'receipt-too-large', expected: 'receipt-too-large' },
  { label: 'oversized diagnostic', reason: 'receipt-' + 'x'.repeat(10000), expected: 'receipt-unavailable' },
])(
  'reports an existing generated file honestly when receipt persistence fails: $label',
  async ({ reason, expected }) => {
    write();
    const spy = vi.spyOn(receipts, 'writeSlideGenerationReceipt').mockImplementationOnce(() => {
      throw new Error(reason);
    });
    try {
      const result = await render();
      expect(result).toMatchObject({
        status: 'file-generated',
        fileCreated: true,
        artifactIndexed: false,
        receiptStatus: 'unavailable',
        receiptDiagnostic: expected,
      });
      expect(result.receiptFile).toBeUndefined();
      expect(fs.existsSync(path.join(workspace, String(result.fileName)))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  },
);
beforeEach(() => {
  vi.resetAllMocks();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'slidegen-file-render-'));
  workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  vi.mocked(measureSlide).mockResolvedValue(measured);
});
afterEach(() => {
  if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('test path escaped');
  fs.rmSync(root, { recursive: true, force: true });
});

it('returns a real editable file with matching source and final output versions', async () => {
  const input = write(source('<Slide><Text>One</Text></Slide><Slide><Text>Two</Text></Slide>'));
  const result = await render();
  expect(result).toMatchObject({
    schemaVersion: 1,
    status: 'file-generated',
    fileCreated: true,
    artifactIndexed: false,
    pages: 2,
    sourceSha256: createHash('sha256').update(input).digest('hex'),
    resources: [],
    warnings: [],
    visualReview: 'not-performed',
  });
  const bytes = fs.readFileSync(path.join(workspace, String(result.fileName)));
  expect(result).toMatchObject({ bytes: bytes.length, outputSha256: createHash('sha256').update(bytes).digest('hex') });
  const zip = await JSZip.loadAsync(bytes);
  expect(await zip.file('ppt/slides/slide2.xml')!.async('string')).toContain('<a:t>\u6587\u5b57</a:t>');
  expect(fs.readFileSync(path.join(workspace, 'report.slidegen'), 'utf8')).toBe(input);
  expect(fs.readdirSync(workspace).some((name) => name.startsWith('.slidegen-'))).toBe(false);
});

it('returns actual closing-tag diagnostics without creating a half file', async () => {
  write(source('<Slide><Text>Body</Text invalid></Slide>'));
  expect(await render()).toMatchObject({
    status: 'source-invalid',
    fileCreated: false,
    diagnostics: [expect.objectContaining({ diagnostic: expect.objectContaining({ detail: 'invalid closing tag' }) })],
  });
  expect(pptxFiles()).toEqual([]);
  expect(measureSlide).not.toHaveBeenCalled();
});

it.each([
  ['```slidegen\n// title: Report\n<Slide>', 'slidegen-block-unclosed'],
  ['text only', 'slidegen-file-no-fence'],
])('rejects incomplete input: %s', async (input, code) => {
  write(input);
  expect(await render()).toMatchObject({
    status: 'source-invalid',
    diagnostics: [expect.objectContaining({ code })],
    fileCreated: false,
  });
  expect(pptxFiles()).toEqual([]);
});

it('keeps page warnings and does not claim a visual pass', async () => {
  write();
  vi.mocked(measureSlide).mockResolvedValue([base, { ...measured[1], occludedBy: '#2' }]);
  expect(await render()).toMatchObject({
    status: 'file-generated',
    layoutReview: 'warnings',
    visualReview: 'not-performed',
    warnings: [expect.objectContaining({ page: 1, code: 'layout-text-occluded' })],
  });
});

it('keeps existing presentations and repeated command output independent', async () => {
  write();
  fs.writeFileSync(path.join(workspace, 'Report.pptx'), 'existing');
  const a = await render(),
    b = await render();
  expect(a.fileName).not.toBe(b.fileName);
  expect(fs.readFileSync(path.join(workspace, 'Report.pptx'), 'utf8')).toBe('existing');
  expect(pptxFiles()).toHaveLength(3);
});

it('rejects a source changed while the real asynchronous render is in progress', async () => {
  write();
  vi.mocked(measureSlide).mockImplementation(async () => {
    write(source('<Slide><Text>Changed</Text></Slide>'));
    return measured;
  });
  expect(await render()).toMatchObject({
    status: 'render-failed',
    fileCreated: false,
    diagnostics: [{ code: 'source-changed-during-render' }],
  });
  expect(pptxFiles()).toEqual([]);
});

it('rejects a replaced workspace even when its source bytes are identical', async () => {
  const input = write();
  vi.mocked(measureSlide).mockImplementation(async () => {
    fs.renameSync(workspace, path.join(root, 'old'));
    fs.mkdirSync(workspace);
    write(input);
    return measured;
  });
  expect(await render()).toMatchObject({
    status: 'render-failed',
    fileCreated: false,
    diagnostics: [{ code: 'workspace-changed-during-render' }],
  });
  expect(pptxFiles()).toEqual([]);
});

it('rejects workspace escapes and malformed UTF-8 before rendering', async () => {
  fs.writeFileSync(path.join(root, 'outside.slidegen'), source());
  expect(await render('../outside.slidegen')).toMatchObject({
    status: 'source-invalid',
    diagnostics: [{ code: 'source-outside-workspace' }],
  });
  fs.writeFileSync(path.join(workspace, 'report.slidegen'), Buffer.from([0xff]));
  expect(await render()).toMatchObject({
    status: 'source-invalid',
    diagnostics: [{ code: 'source-encoding-invalid' }],
  });
  expect(measureSlide).not.toHaveBeenCalled();
});

it('reports a missing referenced image instead of silently producing a clean-looking receipt', async () => {
  write(source('<Slide><Image src="assets/missing.png" /></Slide>'));
  expect(await render()).toMatchObject({
    status: 'render-failed',
    fileCreated: false,
    diagnostics: [{ code: 'resource-unavailable' }],
  });
  expect(pptxFiles()).toEqual([]);
});

it('uses the exact snapshotted image bytes in both measurement and final export', async () => {
  write(source('<Slide><Image src="assets/pixel.png" /></Slide>'));
  fs.mkdirSync(path.join(workspace, 'assets'));
  fs.writeFileSync(path.join(workspace, 'assets/pixel.png'), png);
  vi.mocked(measureSlide).mockImplementation(async (_html, assetsRoot) => {
    expect(fs.readFileSync(path.join(String(assetsRoot), 'pixel.png'))).toEqual(png);
    fs.writeFileSync(path.join(workspace, 'assets/pixel.png'), 'changed');
    return [base, { ...base, id: 1, kind: 'image', w: 100, h: 100, src: 'assets/pixel.png' }];
  });
  const result = await render();
  expect(result).toMatchObject({
    status: 'file-generated',
    resources: [{ name: 'pixel.png', bytes: png.length, sha256: createHash('sha256').update(png).digest('hex') }],
  });
  const zip = await JSZip.loadAsync(fs.readFileSync(path.join(workspace, String(result.fileName))));
  const media = Object.keys(zip.files).find((name) => /^ppt\/media\/image.*\.png$/.test(name));
  expect(media).toBeDefined();
  expect(await zip.file(media!)!.async('nodebuffer')).toEqual(png);
});

it('does not read referenced images through a junction outside the workspace', async () => {
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'pixel.png'), png);
  fs.symlinkSync(outside, path.join(workspace, 'assets'), 'junction');
  write(source('<Slide><Image src="assets/pixel.png" /></Slide>'));
  expect(await render()).toMatchObject({
    status: 'render-failed',
    fileCreated: false,
    diagnostics: [{ code: 'resource-outside-workspace' }],
  });
  expect(measureSlide).not.toHaveBeenCalled();
});

it('cleans snapshots when the authorized workspace is a junction', async () => {
  write();
  const alias = path.join(root, 'alias');
  fs.symlinkSync(workspace, alias, 'junction');
  workspace = alias;
  expect(await render()).toMatchObject({ status: 'file-generated' });
  expect(fs.readdirSync(workspace).some((name) => name.startsWith('.slidegen-'))).toBe(false);
});

it.each(['image', 'directory'])('rejects a replaced snapshot %s during measurement', async (replacement) => {
  write(source('<Slide><Image src="assets/pixel.png" /></Slide>'));
  fs.mkdirSync(path.join(workspace, 'assets'));
  fs.writeFileSync(path.join(workspace, 'assets/pixel.png'), png);
  vi.mocked(measureSlide).mockImplementation(async (_html, assetsRoot) => {
    const snapshot = String(assetsRoot);
    if (replacement === 'directory') {
      fs.renameSync(snapshot, path.join(root, 'replaced-snapshot'));
      fs.mkdirSync(snapshot);
    }
    fs.writeFileSync(path.join(snapshot, 'pixel.png'), Buffer.concat([png, Buffer.from('changed')]));
    return [base, { ...base, id: 1, kind: 'image', w: 100, h: 100, src: 'assets/pixel.png' }];
  });
  expect(await render()).toMatchObject({
    status: 'render-failed',
    diagnostics: [{ code: 'resource-snapshot-changed' }],
    fileCreated: false,
  });
  expect(pptxFiles()).toEqual([]);
});

it('preserves image names containing HTML-sensitive characters in the actual URL mapping', async () => {
  write(source('<Slide><Image src="assets/a&b.png" /></Slide>'));
  fs.mkdirSync(path.join(workspace, 'assets'));
  fs.writeFileSync(path.join(workspace, 'assets/a&b.png'), png);
  vi.mocked(measureSlide).mockImplementation(async (html, assetsRoot) => {
    const src = /<img [^>]*src="([^"]*)"/.exec(absolutizeImageSources(html, assetsRoot))![1];
    expect(fs.readFileSync(fileURLToPath(src))).toEqual(png);
    return [base, { ...base, id: 1, kind: 'image', w: 100, h: 100, src }];
  });
  const result = await render();
  expect(result.status).toBe('file-generated');
  const zip = await JSZip.loadAsync(fs.readFileSync(path.join(workspace, String(result.fileName))));
  expect(Object.keys(zip.files).some((name) => /^ppt\/media\/image.*\.png$/.test(name))).toBe(true);
});

it.each(['assets/%2e%2e%2fpixel.png', 'https://example.com/pixel.png', 'assets/%ff.png'])(
  'rejects unsupported image paths: %s',
  async (src) => {
    write(source('<Slide><Image src="' + src + '" /></Slide>'));
    expect(await render()).toMatchObject({
      status: 'render-failed',
      diagnostics: [{ code: 'resource-source-invalid' }],
      fileCreated: false,
    });
    expect(measureSlide).not.toHaveBeenCalled();
  },
);

it('rejects an oversized image before measurement or output', async () => {
  write(source('<Slide><Image src="assets/large.png" /></Slide>'));
  fs.mkdirSync(path.join(workspace, 'assets'));
  const image = path.join(workspace, 'assets/large.png');
  fs.writeFileSync(image, '');
  fs.truncateSync(image, 16 * 1024 * 1024 + 1);
  expect(await render()).toMatchObject({
    status: 'render-failed',
    diagnostics: [{ code: 'resource-too-large' }],
    fileCreated: false,
  });
  expect(measureSlide).not.toHaveBeenCalled();
  expect(pptxFiles()).toEqual([]);
});

it('rejects multiple decks in one command without partially generating the first', async () => {
  write(source() + '\n' + source());
  expect(await render()).toMatchObject({
    status: 'source-invalid',
    diagnostics: [{ code: 'source-one-deck-required' }],
    fileCreated: false,
  });
  expect(measureSlide).not.toHaveBeenCalled();
});

it('cleans temporary data after a later page fails', async () => {
  write(source('<Slide><Text>One</Text></Slide><Slide><Text>Two</Text></Slide>'));
  vi.mocked(measureSlide).mockResolvedValueOnce(measured).mockRejectedValueOnce(new Error('failed page'));
  expect(await render()).toMatchObject({ status: 'render-failed', fileCreated: false });
  expect(pptxFiles()).toEqual([]);
  expect(fs.readdirSync(workspace)).toEqual(['report.slidegen']);
});
