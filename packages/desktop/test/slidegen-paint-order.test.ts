// @vitest-environment jsdom
import fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Only Electron transport/layout metrics are substituted. The production browser
// measurement script runs against real DOM/computed order; paintOrders below use
// the documented Chromium snapshot shape, confirmed by a real-browser probe.
const state = vi.hoisted(() => ({ snapshot: {} as unknown, attached: false, detaches: 0, fail: false, failNext: 0 }));
vi.mock('electron', () => ({
  BrowserWindow: class {
    webContents = {
      executeJavaScript: async (script: string) =>
        script.includes('document.fonts.ready') ? true : window.eval(script),
      debugger: {
        isAttached: () => state.attached,
        attach: () => {
          state.attached = true;
        },
        detach: () => {
          state.attached = false;
          state.detaches++;
        },
        sendCommand: async () => {
          if (state.fail || state.failNext-- > 0) throw new Error('snapshot failed');
          return state.snapshot;
        },
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

function snapshot(entries: [number, number][]) {
  const strings = ['data-sg', ...entries.map(([id]) => String(id))];
  return {
    strings,
    documents: [
      {
        nodes: { attributes: entries.map((_, i) => [0, i + 1]) },
        layout: { nodeIndex: entries.map((_, i) => i), paintOrders: entries.map(([, order]) => order) },
      },
    ],
  };
}
const node = (id: number, style = '', children = '') =>
  `<div data-sg="${id}" data-sg-kind="box" style="${style}">${children}</div>`;

beforeEach(() => {
  state.attached = false;
  state.detaches = 0;
  state.fail = false;
  state.failNext = 0;
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => null });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    top: 0,
    left: 0,
    right: 100,
    bottom: 100,
    toJSON: () => ({}),
  });
});

describe('slidegen Chromium paint ordering', () => {
  it('paints an earlier absolute auto-z heading above a later normal-flow card', async () => {
    state.snapshot = snapshot([
      [0, 2],
      [1, 3],
      [2, 2],
    ]);
    const result = await measureSlide(
      node(0, 'position:relative;display:flex', node(1, 'position:absolute') + node(2)),
      null,
    );
    expect(result.map((item) => item.id)).toEqual([0, 2, 1]);
    expect(state.detaches).toBe(1);
  });

  it('preserves normal-flow parent/child and sibling tree order in one layer', async () => {
    state.snapshot = snapshot([
      [0, 1],
      [1, 1],
      [2, 1],
      [3, 1],
    ]);
    const result = await measureSlide(node(0, '', node(1, '', node(2)) + node(3)), null);
    expect(result.map((item) => item.id)).toEqual([0, 1, 2, 3]);
  });

  it('respects nested stacking contexts rather than globally lifting a child with a larger z-index', async () => {
    state.snapshot = snapshot([
      [0, 2],
      [1, 3],
      [2, 4],
      [3, 5],
    ]);
    const result = await measureSlide(
      node(
        0,
        'position:relative',
        node(3, 'position:absolute;z-index:2') +
          node(1, 'position:relative;z-index:1', node(2, 'position:absolute;z-index:9')),
      ),
      null,
    );
    expect(result.map((item) => item.id)).toEqual([0, 1, 2, 3]);
  });

  it('uses computed flex order for same-layer siblings and keeps each subtree together', async () => {
    state.snapshot = snapshot([
      [0, 1],
      [1, 1],
      [2, 1],
      [3, 1],
    ]);
    const result = await measureSlide(node(0, 'display:flex', node(1, 'order:2', node(2)) + node(3, 'order:1')), null);
    expect(result.map((item) => item.id)).toEqual([0, 3, 1, 2]);
  });

  it('reports absent browser paint data instead of pretending DOM order is correct', async () => {
    state.snapshot = { strings: [], documents: [] };
    await expect(measureSlide(node(0), null)).rejects.toThrow('paint order');
    expect(state.detaches).toBe(1);
  });

  it('detaches its own debugger even when snapshot capture fails', async () => {
    state.fail = true;
    await expect(measureSlide(node(0), null)).rejects.toThrow('snapshot failed');
    expect(state.detaches).toBe(1);
  });

  it('does not detach a debugger it did not attach', async () => {
    state.attached = true;
    state.snapshot = snapshot([[0, 1]]);
    await measureSlide(node(0), null);
    expect(state.detaches).toBe(0);
    expect(state.attached).toBe(true);
  });

  it('serializes two overlapping requests through the shared measurement window', async () => {
    state.snapshot = snapshot([
      [1, 1],
      [2, 1],
    ]);
    const result = await Promise.all([measureSlide(node(1), null), measureSlide(node(2), null)]);
    expect(result.map((elements) => elements.map((item) => item.id))).toEqual([[1], [2]]);
  });

  it('continues the shared-window queue after an earlier request fails', async () => {
    state.snapshot = snapshot([
      [1, 1],
      [2, 1],
    ]);
    state.failNext = 1;
    const [first, second] = await Promise.allSettled([measureSlide(node(1), null), measureSlide(node(2), null)]);
    expect(first.status).toBe('rejected');
    expect(second.status).toBe('fulfilled');
    if (second.status === 'fulfilled') expect(second.value.map((item) => item.id)).toEqual([2]);
  });
});
