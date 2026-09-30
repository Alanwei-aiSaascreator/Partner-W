import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toShapes, writeSlidePptx } from '../src/main/slidegen/emit';
import { evaluateSlide } from '../src/main/slidegen/evaluate';
import type { MeasuredElement } from '../src/main/slidegen/measure';

const measurement = vi.hoisted(() => ({ elements: [] as MeasuredElement[] }));
vi.mock('../src/main/slidegen/measure.js', () => ({ measureSlide: async () => measurement.elements }));

import { emitPageShapes } from '../src/main/slidegen/pipeline';

const gradient = 'linear-gradient(135deg, rgb(26, 26, 46) 0%, rgb(45, 27, 105) 50%, rgb(22, 33, 62) 100%)';
const root: MeasuredElement = {
  id: 0,
  kind: 'slide',
  x: 0,
  y: 0,
  w: 1280,
  h: 720,
  text: '',
  fontSize: 48,
  fontWeight: '700',
  color: 'rgb(255, 255, 255)',
  textAlign: 'left',
  letterSpacing: 0,
  background: 'rgba(0, 0, 0, 0)',
  backgroundImage: gradient,
  borderRadius: 0,
  borderWidth: 0,
  borderColor: 'rgba(0, 0, 0, 0)',
  lines: 0,
  occludedBy: null,
};

const title: MeasuredElement = {
  ...root,
  id: 1,
  kind: 'text',
  x: 80,
  y: 120,
  w: 1000,
  h: 80,
  text: 'Operations service introduction',
  backgroundImage: 'none',
  lines: 1,
};

const outputRoots: string[] = [];

afterEach(() => {
  for (const outputRoot of outputRoots.splice(0)) fs.rmSync(outputRoot, { recursive: true, force: true });
});

describe('slide root background export', () => {
  it('places one native root gradient behind the existing child paint order', () => {
    const card = { ...root, id: 2, kind: 'box' as const, background: 'rgb(240, 240, 240)', backgroundImage: 'none' };
    const shapes = toShapes([root, card, title]);
    expect(shapes.map((shape) => shape.id)).toEqual([0, 2, 1]);
    expect(shapes[0]).toMatchObject({
      kind: 'rect',
      x: 0,
      y: 0,
      w: 1280,
      h: 720,
      gradient: {
        angleDeg: 135,
        stops: [
          { pos: 0, color: '1A1A2E' },
          { pos: 0.5, color: '2D1B69' },
          { pos: 1, color: '16213E' },
        ],
      },
    });
  });

  it.each(['rgb(255, 255, 255)', 'rgba(255, 255, 255, 0.3)'])(
    'keeps the gradient above the root background color %s',
    (background) => {
      const shapes = toShapes([{ ...root, background }, title]);
      expect(shapes).toHaveLength(2);
      expect(shapes[0]).toMatchObject({ kind: 'rect', fill: '2D1B69', gradient: expect.any(Object) });
      expect(shapes[0]).not.toHaveProperty('fillTransparency');
    },
  );

  it.each([
    ['rgb(45, 27, 105)', '2D1B69'],
    ['rgba(0, 0, 0, 0)', 'FFFFFF'],
  ])('preserves the root background %s without an extra opaque shape', async (background, expected) => {
    measurement.elements = [{ ...root, background, backgroundImage: 'none' }, title];
    const result = await emitPageShapes(evaluateSlide('<Slide />')[0], null);
    expect(result.page.background).toBe(expected);
    expect(result.page.shapes.map((shape) => shape.id)).toEqual([1]);
  });

  it('writes cover and closing gradients into PPTX while retaining editable titles and solid fills', async () => {
    const outputRoot = fs.mkdtempSync(path.join(process.cwd(), '.slide-root-test-'));
    outputRoots.push(outputRoot);
    const file = path.join(outputRoot, 'root-backgrounds.pptx');
    const pages = [];
    for (let index = 0; index < 8; index++) {
      const isGradient = index === 0 || index === 7;
      measurement.elements = [
        { ...root, background: 'rgb(45, 27, 105)', backgroundImage: isGradient ? gradient : 'none' },
        {
          ...title,
          text: index === 7 ? 'Start your operations journey' : `Operations service introduction ${index + 1}`,
        },
        {
          ...title,
          id: 2,
          y: 260,
          text: 'Solid subtitle',
          color: 'rgb(45, 27, 105)',
        },
      ];
      pages.push((await emitPageShapes(evaluateSlide('<Slide />')[0], null)).page);
    }
    await writeSlidePptx(pages, file, null);
    const zip = await JSZip.loadAsync(fs.readFileSync(file));
    for (let number = 1; number <= 8; number++) {
      const xml = await zip.file(`ppt/slides/slide${number}.xml`)!.async('string');
      const shapes = xml.match(/<p:sp>.*?<\/p:sp>/gs) ?? [];
      const isGradient = number === 1 || number === 8;
      expect(xml.match(/<a:gradFill>/g) ?? []).toHaveLength(isGradient ? 1 : 0);
      expect(shapes).toHaveLength(isGradient ? 3 : 2);
      expect(xml.match(/<p:pic>/g) ?? []).toHaveLength(0);
      expect(xml).toContain('<p:bgPr><a:solidFill><a:srgbClr val="2D1B69"/></a:solidFill>');
      const titleShape = shapes[isGradient ? 1 : 0];
      expect(titleShape).toContain(
        number === 8 ? 'Start your operations journey' : `Operations service introduction ${number}`,
      );
      expect(titleShape).toContain('<a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill>');
      expect(shapes.at(-1)).toContain('<a:solidFill><a:srgbClr val="2D1B69"/></a:solidFill>');
      if (isGradient) {
        expect(shapes[0]).toContain('<a:gradFill>');
        expect(shapes[0]).toContain('<a:lin ang="2700000" scaled="1"/>');
        for (const color of ['1A1A2E', '2D1B69', '16213E']) {
          expect(shapes[0]).toContain(`<a:srgbClr val="${color}"/>`);
        }
        expect(shapes[0]).toContain('<a:off x="0" y="0"/>');
        expect(shapes[0]).toContain('<a:ext cx="12192000" cy="6858000"/>');
      }
    }
  });

  it('keeps child gradients distinct when they share the root gradient fallback color', async () => {
    const outputRoot = fs.mkdtempSync(path.join(process.cwd(), '.slide-root-test-'));
    outputRoots.push(outputRoot);
    const file = path.join(outputRoot, 'child-gradients.pptx');
    const shapes = toShapes([
      root,
      {
        ...root,
        id: 2,
        kind: 'box',
        background: 'rgb(255, 255, 255)',
        backgroundImage: 'linear-gradient(180deg, rgb(255, 255, 255) 0%, rgb(45, 27, 105) 100%)',
      },
      title,
    ]);
    await writeSlidePptx([{ background: 'FFFFFF', shapes }], file, null);
    const zip = await JSZip.loadAsync(fs.readFileSync(file));
    const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
    const exported = xml.match(/<p:sp>.*?<\/p:sp>/gs) ?? [];
    expect(exported).toHaveLength(3);
    expect(exported[0]).toContain('<a:lin ang="2700000" scaled="1"/>');
    expect(exported[1]).toContain('<a:lin ang="5400000" scaled="1"/>');
    expect(exported[1].match(/<a:gs pos=/g)).toHaveLength(2);
    expect(exported[1]).toContain('<a:gs pos="0"><a:srgbClr val="FFFFFF"/></a:gs>');
    expect(exported[2]).not.toContain('<a:gradFill>');
  });
});
