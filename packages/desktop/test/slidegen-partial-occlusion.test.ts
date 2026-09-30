// @vitest-environment jsdom
import fs from 'node:fs';
import { beforeEach, expect, it, vi } from 'vitest';

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
          strings: ['data-sg', '0', '1'],
          documents: [
            {
              nodes: {
                attributes: [
                  [0, 1],
                  [0, 2],
                ],
              },
              layout: { nodeIndex: [0, 1], paintOrders: [1, 2] },
            },
          ],
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
import { validateLayout } from '../src/main/slidegen/validate';

const rectangle = { x: 0, y: 0, width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, toJSON: () => ({}) };
beforeEach(() => {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(rectangle);
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [rectangle] });
});
const html =
  '<div data-sg="0" data-sg-kind="text">Footer<span> text</span></div><div data-sg="1" data-sg-kind="box"></div>';

it('warns when text is partially covered while its center remains visible', async () => {
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: (x: number) => document.querySelector(`[data-sg="${x > 75 ? 1 : 0}"]`),
  });
  const measured = await measureSlide(html, null);
  expect(measured.find((item) => item.id === 0)?.occludedBy).toBe('#1');
  expect(validateLayout(measured).some((item) => item.code === 'layout-text-occluded')).toBe(true);
});

it('does not report the text own inline child as an obstruction', async () => {
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: () => document.querySelector('span'),
  });
  const measured = await measureSlide(html, null);
  expect(measured.find((item) => item.id === 0)?.occludedBy).toBeNull();
});

it('samples text line bounds rather than blank space in a wide text container', async () => {
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    value: () => [{ ...rectangle, width: 30, right: 30 }],
  });
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: (x: number) => document.querySelector(`[data-sg="${x > 75 ? 1 : 0}"]`),
  });
  const measured = await measureSlide(html, null);
  expect(measured.find((item) => item.id === 0)?.occludedBy).toBeNull();
});
