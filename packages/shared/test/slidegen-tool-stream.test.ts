import { expect, it } from 'vitest';
import { parseSlidegenToolStream } from '../src/slidegen-tool-stream.js';

const sourceSha256 = 'a'.repeat(64);
const page = (completed = 1, total = 3, overrides: Record<string, unknown> = {}) =>
  JSON.stringify({ schemaVersion: 1, status: 'slidegen-progress', sourceSha256, completed, total, ...overrides });
const report = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  status: 'file-generated',
  sourceSha256,
  pages: 3,
  fileCreated: true,
  artifactIndexed: false,
  visualReview: 'not-performed',
  ...overrides,
});

it('preserves legacy reports including pretty JSON', () => {
  expect(parseSlidegenToolStream(JSON.stringify(report(), null, 2))).toEqual({ report: report() });
});

it('decodes bounded native foreground snapshots without confirming a file', () => {
  expect(parseSlidegenToolStream(page(1) + '\n' + page(2), true)).toMatchObject({
    progress: { completed: 2, total: 3, sourceSha256 },
  });
  expect(parseSlidegenToolStream(page(3))?.report).toBeUndefined();
});

it('accepts an incremental terminal poll tail without requiring already-consumed pages', () => {
  expect(parseSlidegenToolStream(page(3) + '\n' + JSON.stringify(report()))).toMatchObject({
    progress: { completed: 3 },
    report: report(),
  });
});

it('holds the last complete page when a live chunk ends mid-record', () => {
  expect(parseSlidegenToolStream(page(1) + '\n{"schemaVersion":1,"status":"slidegen-', true)).toMatchObject({
    progress: { completed: 1 },
  });
  expect(parseSlidegenToolStream(page(1) + '\n{"schemaVersion":1,"status":"slidegen-')).toBeNull();
});

it.each([
  ['source switch', page(2, 3, { sourceSha256: 'b'.repeat(64) })],
  ['total switch', page(2, 4)],
  ['duplicate page', page(1)],
  ['regression', page(1, 3)],
  ['garbage', 'untrusted prefix'],
  ['missing source', JSON.stringify(report({ sourceSha256: undefined }))],
  ['wrong source report', JSON.stringify(report({ sourceSha256: 'b'.repeat(64) }))],
  ['wrong total report', JSON.stringify(report({ pages: 4 }))],
  ['foreign report', JSON.stringify({ status: 'done' })],
])('rejects corrupted stream %s', (_label, tail) => {
  expect(parseSlidegenToolStream(page(2) + '\n' + tail)).toBeNull();
});

it.each([
  { completed: 0 },
  { completed: 1.5 },
  { completed: 4 },
  { total: 201 },
  { total: '3' },
  { sourceSha256: 'A'.repeat(64) },
  { extra: true },
])('rejects invalid telemetry fields %j', (overrides) => {
  expect(parseSlidegenToolStream(page(1, 3, overrides))).toBeNull();
});

it('rejects duplicate final reports and text after a valid final report', () => {
  const final = JSON.stringify(report());
  expect(parseSlidegenToolStream(page(1) + '\n' + final + '\n' + final)).toBeNull();
  expect(parseSlidegenToolStream(final + '\nextra')).toBeNull();
});

it('bounds input and accepts the full 200-page limit', () => {
  const prefix = Array.from({ length: 200 }, (_unused, i) => page(i + 1, 200)).join('\n');
  expect(parseSlidegenToolStream(prefix + '\n' + JSON.stringify(report({ pages: 200 })))).toMatchObject({
    progress: { completed: 200 },
    report: { pages: 200 },
  });
  expect(parseSlidegenToolStream(' '.repeat(2 * 1024 * 1024 + 1))).toBeNull();
});
