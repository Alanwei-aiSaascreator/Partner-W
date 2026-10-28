import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { toShapes, writeSlidePptx } from '../src/main/slidegen/emit';
import type { MeasuredElement } from '../src/main/slidegen/measure';

const measured: MeasuredElement = {
  id: 1,
  kind: 'box',
  x: 20,
  y: 20,
  w: 400,
  h: 100,
  text: '',
  fontSize: 24,
  fontWeight: '400',
  color: 'rgb(0, 0, 0)',
  textAlign: 'left',
  letterSpacing: 0,
  background: 'rgba(239, 68, 68, 0.06)',
  backgroundImage: 'none',
  borderRadius: 12,
  borderWidth: 1,
  borderColor: 'rgba(239, 68, 68, 0.2)',
  lines: 0,
  occludedBy: null,
};

describe('editable slide color alpha', () => {
  it('keeps the original eight-page deck translucent card fill and border', () => {
    expect(toShapes([measured])[0]).toMatchObject({
      kind: 'rect',
      fill: 'EF4444',
      fillTransparency: 94,
      borderTransparency: 80,
    });
    expect(toShapes([{ ...measured, background: 'rgba(0, 0, 0, 0)', borderWidth: 0 }])).toEqual([]);
  });

  it('preserves translucent text without making fully transparent text visible', () => {
    const text = { ...measured, kind: 'text' as const, text: '透明度', lines: 1 };
    expect(toShapes([{ ...text, color: 'rgba(0, 0, 0, 0.4)' }])[0]).toMatchObject({ transparency: 60 });
    expect(toShapes([{ ...text, color: 'rgba(0, 0, 0, 0)' }])[0]).toMatchObject({ transparency: 100 });
    expect(toShapes([{ ...text, color: 'rgb(0, 0, 0)' }])[0]).not.toHaveProperty('transparency');
  });

  it('writes native alpha into actual PPTX fill, border and text XML', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slide-alpha-test-'));
    try {
      const file = path.join(root, 'alpha.pptx');
      const shapes = toShapes([
        measured,
        {
          ...measured,
          id: 2,
          kind: 'text',
          text: '半透明文字',
          lines: 1,
          color: 'rgba(0, 0, 0, 0.4)',
        },
      ]);
      await writeSlidePptx([{ background: 'FFFFFF', shapes }], file, null);
      const zip = await JSZip.loadAsync(fs.readFileSync(file));
      const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
      expect(xml).toContain('<a:alpha val="6000"/>');
      expect(xml).toContain('<a:alpha val="20000"/>');
      expect(xml).toContain('<a:alpha val="40000"/>');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
