import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MeasuredElement } from '../src/main/slidegen/measure.js';

vi.mock('electron', () => ({ BrowserWindow: {} }));
vi.mock('../src/main/slidegen/measure.js', () => ({ measureSlide: vi.fn() }));
import { renderSlideDeck } from '../src/main/slidegen/render-deck.js';
import { measureSlide } from '../src/main/slidegen/measure.js';
import { evaluateSlide } from '../src/main/slidegen/evaluate.js';

let workspacePath = '';
const measured: MeasuredElement = {
  id: 0,
  kind: 'slide',
  x: 0,
  y: 0,
  w: 1280,
  h: 720,
  text: '',
  fontSize: 24,
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
const pages = evaluateSlide('<Slide><Text>First</Text></Slide><Slide><Text>Second</Text></Slide>');
function render(overrides: Partial<Parameters<typeof renderSlideDeck>[0]> = {}) {
  return renderSlideDeck({ pages, workspacePath, assetsRoot: null, ...overrides });
}
function page(text: string, occluded = false): MeasuredElement[] {
  return [
    measured,
    {
      ...measured,
      id: 1,
      kind: 'text',
      x: 80,
      y: 80,
      w: 800,
      h: 70,
      text,
      lines: 1,
      occludedBy: occluded ? '#2' : null,
    },
  ];
}
beforeEach(() => {
  vi.resetAllMocks();
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'slidegen-render-deck-'));
  vi.mocked(measureSlide).mockResolvedValueOnce(page('First')).mockResolvedValue(page('Second', true));
});
afterEach(() => {
  const resolved = fs.realpathSync(workspacePath);
  if (!resolved.startsWith(fs.realpathSync(os.tmpdir()) + path.sep)) throw new Error('unexpected test directory');
  fs.rmSync(resolved, { recursive: true, force: true });
});

it('returns the actual editable file bytes, final hash and page-specific diagnostics', async () => {
  const onPage = vi.fn();
  const result = await render({ onPage });
  const zip = await JSZip.loadAsync(result.buffer);
  expect(await zip.file('ppt/slides/slide1.xml')!.async('string')).toContain('<a:t>First</a:t>');
  expect(await zip.file('ppt/slides/slide2.xml')!.async('string')).toContain('<a:t>Second</a:t>');
  expect(result).toMatchObject({
    pages: 2,
    bytes: result.buffer.length,
    visualReview: 'not-performed',
    outputSha256: createHash('sha256').update(result.buffer).digest('hex'),
  });
  expect(result.warnings).toEqual([expect.objectContaining({ page: 2, code: 'layout-text-occluded' })]);
  expect(onPage.mock.calls).toEqual([
    [1, 2],
    [2, 2],
  ]);
  expect(fs.readdirSync(workspacePath)).toEqual([]);
});

it('does not promote zero layout warnings to a final visual quality claim', async () => {
  vi.mocked(measureSlide).mockReset().mockResolvedValue(page('Clean'));
  expect(await render()).toMatchObject({ warnings: [], visualReview: 'not-performed' });
});

it.each([0, 201])('rejects an invalid page count of %s before rendering or writing', async (count) => {
  await expect(render({ pages: Array.from({ length: count }, () => pages[0]) })).rejects.toThrow('page-count');
  expect(measureSlide).not.toHaveBeenCalled();
  expect(fs.readdirSync(workspacePath)).toEqual([]);
});

it('does not return a half-deck when a later page fails', async () => {
  vi.mocked(measureSlide)
    .mockReset()
    .mockResolvedValueOnce(page('First'))
    .mockRejectedValueOnce(new Error('measurement failed'));
  await expect(render()).rejects.toThrow('measurement failed');
  expect(fs.readdirSync(workspacePath)).toEqual([]);
});

it('honors the original database ownership after each asynchronous page', async () => {
  let current = true;
  vi.mocked(measureSlide)
    .mockReset()
    .mockImplementation(async () => {
      current = false;
      return page('Stale');
    });
  await expect(
    render({
      assertCurrent: () => {
        if (!current) throw new Error('owner changed');
      },
    }),
  ).rejects.toThrow('owner changed');
  expect(measureSlide).toHaveBeenCalledOnce();
  expect(fs.readdirSync(workspacePath)).toEqual([]);
});

it('keeps concurrent render temporary files independent', async () => {
  const keep = path.join(workspacePath, 'existing.pptx');
  fs.writeFileSync(keep, 'preserve');
  const [first, second] = await Promise.all([render(), render()]);
  await Promise.all([JSZip.loadAsync(first.buffer), JSZip.loadAsync(second.buffer)]);
  expect(fs.readFileSync(keep, 'utf8')).toBe('preserve');
  expect(fs.readdirSync(workspacePath)).toEqual(['existing.pptx']);
});
