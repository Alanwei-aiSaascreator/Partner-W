// @vitest-environment jsdom
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ snapshot: {} as unknown, visible: '' }));
vi.mock('electron', () => ({
  BrowserWindow: class {
    webContents = {
      executeJavaScript: async (script: string) =>
        script.includes('document.fonts.ready') ? true : window.eval(script),
      debugger: {
        isAttached: () => false,
        attach: () => undefined,
        detach: () => undefined,
        sendCommand: async () => state.snapshot,
      },
    };
    async loadFile(file: string) {
      document.body.innerHTML = new DOMParser().parseFromString(
        fs.readFileSync(file, 'utf8'),
        'text/html',
      ).body.innerHTML;
    }
    isDestroyed() {
      return false;
    }
    on() {
      return this;
    }
  },
}));
import { measureSlide } from '../src/main/slidegen/measure';
import { toShapes, writeSlidePptx } from '../src/main/slidegen/emit';

// Minimal native Electron34 snapshot: UTF-16 indexes, multiple font fragments
// may share one baseline. Transport is mocked; production measurement/export run.
function snapshot(text: string, boxes: { start: number; length: number; y: number }[]) {
  return {
    strings: ['data-sg', '0', '', text],
    documents: [
      {
        nodes: { attributes: [[0, 1], []], parentIndex: [-1, 0] },
        layout: { nodeIndex: [0, 1], paintOrders: [1, 1], text: [2, 3] },
        textBoxes: {
          layoutIndex: boxes.map(() => 1),
          start: boxes.map((b) => b.start),
          length: boxes.map((b) => b.length),
          bounds: boxes.map((b) => [0, b.y, 200, 32]),
        },
      },
    ],
  };
}
const html = (text: string, extra = '') =>
  `<div data-sg="0" data-sg-kind="text" style="font-size:24px;line-height:1.35;text-wrap:balance;direction:ltr;writing-mode:horizontal-tb;white-space:normal;${extra}">${text}</div>`;

beforeEach(() => {
  const r = { x: 0, y: 0, width: 400, height: 64.8, top: 0, left: 0, right: 400, bottom: 64.8, toJSON: () => ({}) };
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(r);
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [r, r] });
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => null });
  Object.defineProperty(HTMLElement.prototype, 'innerText', { configurable: true, get: () => state.visible });
});

it('retains native balanced CJK lines in one editable text box without Office greedy rewrap', async () => {
  state.visible = '六位助手各司其职，深度覆盖不同领域';
  state.snapshot = snapshot(state.visible, [
    { start: 0, length: 9, y: 0 },
    { start: 9, length: 8, y: 32 },
  ]);
  const measured = await measureSlide(html(state.visible), null);
  expect(measured[0]).toMatchObject({ textLines: ['六位助手各司其职，', '深度覆盖不同领域'] });
  const shapes = toShapes(measured);
  expect(shapes[0]).toMatchObject({ text: '六位助手各司其职，\n深度覆盖不同领域', fontSize: 18, wrap: false });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'balanced-native-'));
  try {
    const file = path.join(root, 'balanced.pptx');
    await writeSlidePptx([{ background: 'FFFFFF', shapes }], file, null);
    const zip = await JSZip.loadAsync(fs.readFileSync(file));
    const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
    expect(xml).toContain('wrap="none"');
    expect(xml).toContain('<a:t>六位助手各司其职，</a:t>');
    expect(xml).toContain('<a:t>深度覆盖不同领域</a:t>');
    expect(xml.match(/<p:sp>/g)).toHaveLength(1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('groups same-row font fragments, preserves emoji and ignores only source formatting whitespace', async () => {
  const raw = 'AI 🧠\n    支持写作';
  state.visible = 'AI 🧠 支持写作';
  state.snapshot = snapshot(raw, [
    { start: 0, length: 3, y: 0 },
    { start: 3, length: 2, y: 0 },
    { start: 10, length: 4, y: 32 },
  ]);
  const measured = await measureSlide(html(raw), null);
  expect(measured[0]).toMatchObject({ textLines: ['AI 🧠', '支持写作'] });
  expect(toShapes(measured)[0]).toMatchObject({ text: 'AI 🧠\n支持写作', wrap: false });
});

it.each(['missing', 'partial-boxes', 'truncated', 'non-breaking-space', 'pre', 'rtl', 'greedy'])(
  'keeps full original text when native line mapping is unsafe: %s',
  async (condition) => {
    state.visible = condition === 'non-breaking-space' ? 'Alpha\u00a0Beta' : 'Alpha Beta';
    state.snapshot = snapshot(state.visible, [
      { start: 0, length: 5, y: 0 },
      { start: 6, length: 4, y: 32 },
    ]);
    if (condition === 'missing')
      state.snapshot = {
        strings: ['data-sg', '0'],
        documents: [{ nodes: { attributes: [[0, 1]] }, layout: { nodeIndex: [0], paintOrders: [1] } }],
      };
    if (condition === 'partial-boxes') {
      const incomplete = snapshot(state.visible, [
        { start: 0, length: 5, y: 0 },
        { start: 6, length: 4, y: 32 },
      ]);
      Reflect.deleteProperty(incomplete.documents[0].textBoxes, 'start');
      state.snapshot = incomplete;
    }
    if (condition === 'truncated')
      state.snapshot = snapshot(state.visible, [
        { start: 0, length: 4, y: 0 },
        { start: 6, length: 4, y: 32 },
      ]);
    const extra =
      condition === 'pre'
        ? 'white-space:pre-wrap'
        : condition === 'rtl'
          ? 'direction:rtl'
          : condition === 'greedy'
            ? 'text-wrap:wrap'
            : '';
    const measured = await measureSlide(html(state.visible, extra), null);
    expect(measured[0]).not.toHaveProperty('textLines');
    expect(toShapes(measured)[0]).toMatchObject({ text: state.visible, wrap: true });
  },
);
