import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { expect, it } from 'vitest';
import { toShapes, writeSlidePptx } from '../src/main/slidegen/emit';
import type { MeasuredElement } from '../src/main/slidegen/measure';

it('preserves the measured font, explicit line height and italic in editable PPTX text', async () => {
  const measured = {
    id: 1,
    kind: 'text',
    x: 20,
    y: 20,
    w: 400,
    h: 100,
    text: '投资计划\n商业计划',
    fontSize: 24,
    fontWeight: '400',
    fontFamily: '"Microsoft YaHei", sans-serif',
    fontStyle: 'italic',
    lineHeight: 36,
    color: 'rgb(0,0,0)',
    textAlign: 'left',
    letterSpacing: 0,
    background: 'rgba(0,0,0,0)',
    backgroundImage: 'none',
    borderRadius: 0,
    borderWidth: 0,
    borderColor: 'rgb(0,0,0)',
    lines: 2,
    occludedBy: null,
  } as MeasuredElement;
  const shapes = toShapes([measured]);
  expect(shapes[0]).toMatchObject({ fontFace: 'Microsoft YaHei', lineSpacing: 27, italic: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slide-style-test-'));
  try {
    const file = path.join(root, 'style.pptx');
    await writeSlidePptx([{ background: 'FFFFFF', shapes }], file, null);
    const zip = await JSZip.loadAsync(fs.readFileSync(file));
    const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
    expect(xml).toContain('typeface="Microsoft YaHei"');
    expect(xml).toContain('<a:spcPts val="2700"/>');
    expect(xml).toContain('i="1"');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
