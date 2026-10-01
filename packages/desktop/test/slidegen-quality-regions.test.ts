import { describe, expect, it } from 'vitest';
import type { MeasuredElement } from '../src/main/slidegen/measure';
import { validateLayout } from '../src/main/slidegen/validate';

function element(overrides: Partial<MeasuredElement>): MeasuredElement {
  return {
    id: 0,
    kind: 'slide',
    x: 0,
    y: 0,
    w: 1280,
    h: 720,
    text: '',
    fontSize: 16,
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
    ...overrides,
  };
}
const footer = () =>
  element({
    id: 3,
    kind: 'text',
    parentId: 0,
    position: 'absolute',
    x: 80,
    y: 674,
    w: 1120,
    h: 16,
    text: 'Product footer',
    fontSize: 13,
    background: 'rgba(0, 0, 0, 0)',
    color: 'rgb(100, 116, 139)',
    lines: 1,
  });
const card = () =>
  element({ id: 1, kind: 'box', parentId: 0, x: 760, y: 480, w: 440, h: 214, background: 'rgb(255, 255, 255)' });

describe('slide quality regions', () => {
  it('reports a footer entering a body card even when the footer paints on top', () => {
    const warnings = validateLayout([element({}), card(), footer()]);
    expect(warnings).toContainEqual(expect.objectContaining({ code: 'layout-footer-overlap', element: 3 }));
    expect(warnings.find((warning) => warning.code === 'layout-footer-overlap')?.detail).toContain('#1');
  });
  it('does not treat a card own bottom label or a footer background strip as a collision', () => {
    expect(
      validateLayout([element({}), card(), { ...footer(), parentId: 1 }]).filter(
        (warning) => warning.code === 'layout-footer-overlap',
      ),
    ).toEqual([]);
    expect(
      validateLayout([element({}), element({ ...card(), y: 660, h: 60 }), footer()]).filter(
        (warning) => warning.code === 'layout-footer-overlap',
      ),
    ).toEqual([]);
  });
  it('accepts a footer that clears the body card without changing any geometry', () => {
    const elements = [element({}), { ...card(), h: 170 }, footer()];
    const before = JSON.stringify(elements);
    expect(validateLayout(elements).filter((warning) => warning.code === 'layout-footer-overlap')).toEqual([]);
    expect(JSON.stringify(elements)).toBe(before);
  });
  it('does not treat a full-slide background as a body card', () => {
    expect(
      validateLayout([element({}), element({ id: 1, kind: 'box' }), footer()]).filter(
        (warning) => warning.code === 'layout-footer-overlap',
      ),
    ).toEqual([]);
  });
  it('skips unsupported fills and text backgrounds that are not exported', () => {
    for (const background of ['oklch(0 0 0)', 'color(display-p3 0 0 0)']) {
      expect(
        validateLayout([
          element({}),
          element({ id: 1, kind: 'box', background }),
          { ...footer(), color: 'rgb(180, 180, 180)' },
        ]).filter((warning) => warning.code === 'layout-text-low-contrast'),
      ).toEqual([]);
    }
    expect(
      validateLayout([element({}), { ...footer(), background: 'rgb(0, 0, 0)', color: 'rgb(0, 0, 0)' }]).filter(
        (warning) => warning.code === 'layout-text-low-contrast',
      ),
    ).toEqual([]);
  });
  it('does not assume rounded corners are filled behind text', () => {
    const rounded = element({
      id: 1,
      kind: 'box',
      x: 80,
      y: 180,
      w: 500,
      h: 150,
      borderRadius: 75,
      background: 'rgb(0, 0, 0)',
    });
    const text = { ...footer(), x: 82, y: 182, w: 15, h: 12, fontSize: 12, color: 'rgb(0, 0, 0)' };
    expect(
      validateLayout([element({}), rounded, text]).filter((warning) => warning.code === 'layout-text-low-contrast'),
    ).toEqual([]);
    expect(validateLayout([element({}), rounded, { ...text, x: 180, y: 220 }])).toContainEqual(
      expect.objectContaining({ code: 'layout-text-low-contrast' }),
    );
  });
  it('reports muted small text on a solid dark slide', () => {
    const warnings = validateLayout([element({ background: 'rgb(15, 23, 42)' }), footer()]);
    expect(warnings).toContainEqual(expect.objectContaining({ code: 'layout-text-low-contrast', element: 3 }));
  });
  it('measures contrast at actual text lines rather than blank footer container space', () => {
    const stripe = element({ id: 1, kind: 'box', x: 80, w: 8, backgroundImage: 'linear-gradient(black, white)' });
    const text = { ...footer(), textBounds: [{ x: 480, y: 674, w: 320, h: 16 }] };
    expect(validateLayout([element({ background: 'rgb(15, 23, 42)' }), stripe, text])).toContainEqual(
      expect.objectContaining({ code: 'layout-text-low-contrast' }),
    );
  });
  it('uses the solid card behind text instead of assuming the slide background', () => {
    const text = { ...footer(), x: 800, y: 510, w: 300, parentId: 1 };
    expect(
      validateLayout([element({ background: 'rgb(15, 23, 42)' }), card(), text]).filter(
        (warning) => warning.code === 'layout-text-low-contrast',
      ),
    ).toEqual([]);
  });
  it('composites translucent text and skips unknown gradient or mixed backgrounds', () => {
    const text = { ...footer(), color: 'rgba(255, 255, 255, 0.1)' };
    expect(validateLayout([element({ background: 'rgb(15, 23, 42)' }), text])).toContainEqual(
      expect.objectContaining({ code: 'layout-text-low-contrast' }),
    );
    expect(
      validateLayout([element({ backgroundImage: 'linear-gradient(black, white)' }), text]).filter(
        (warning) => warning.code === 'layout-text-low-contrast',
      ),
    ).toEqual([]);
    expect(
      validateLayout([element({}), card(), text]).filter((warning) => warning.code === 'layout-text-low-contrast'),
    ).toEqual([]);
  });
  it('does not flag large readable text, empty text or unknown inherited opacity', () => {
    const text = { ...footer(), fontSize: 32, color: 'rgb(140, 140, 140)' };
    expect(validateLayout([element({}), text])).toEqual([]);
    expect(validateLayout([element({}), { ...text, text: '', color: 'rgb(255, 255, 255)' }])).toEqual([]);
    expect(
      validateLayout([element({}), { ...footer(), opacity: 0.5 }]).filter(
        (warning) => warning.code === 'layout-text-low-contrast',
      ),
    ).toEqual([]);
  });
});
