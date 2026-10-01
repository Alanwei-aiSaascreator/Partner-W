// @vitest-environment jsdom
import fs from 'node:fs';
import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ renderedText: '' }));
vi.mock('electron', () => ({
  BrowserWindow: class {
    webContents = {
      executeJavaScript: async (script: string) =>
        script.includes('document.fonts.ready') ? true : window.eval(script),
      debugger: {
        isAttached: () => false,
        attach: () => undefined,
        detach: () => undefined,
        sendCommand: async () => ({
          strings: ['data-sg', '0'],
          documents: [{ nodes: { attributes: [[0, 1]] }, layout: { nodeIndex: [0], paintOrders: [1] } }],
        }),
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

beforeEach(() => {
  const rectangle = { x: 0, y: 0, width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, toJSON: () => ({}) };
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(rectangle);
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [rectangle] });
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => null });
  Object.defineProperty(HTMLElement.prototype, 'innerText', { configurable: true, get: () => state.renderedText });
});

it('exports rendered whitespace instead of source formatting that creates extra PPTX lines', async () => {
  state.renderedText = 'Alpha Beta';
  const [text] = await measureSlide('<div data-sg="0" data-sg-kind="text">Alpha\n    Beta</div>', null);
  expect(text.text).toBe('Alpha Beta');
});

it('retains explicit rendered line breaks', async () => {
  state.renderedText = 'Alpha\nBeta';
  const [text] = await measureSlide(
    '<div data-sg="0" data-sg-kind="text" style="white-space:pre-line">Alpha\n    Beta</div>',
    null,
  );
  expect(text.text).toBe('Alpha\nBeta');
});

it('preserves intentional rendered indentation and non-breaking spaces', async () => {
  state.renderedText = '  Alpha\u00a0 Beta  ';
  const [text] = await measureSlide(
    '<div data-sg="0" data-sg-kind="text" style="white-space:pre-wrap">  Alpha\u00a0 Beta  </div>',
    null,
  );
  expect(text.text).toBe(state.renderedText);
});

it('does not replace an empty rendered value with hidden source text', async () => {
  state.renderedText = '';
  const [text] = await measureSlide('<div data-sg="0" data-sg-kind="text">Hidden source</div>', null);
  expect(text.text).toBe('');
});
