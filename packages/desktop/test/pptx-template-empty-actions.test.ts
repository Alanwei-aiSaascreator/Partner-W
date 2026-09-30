import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fillTemplateDeck } from '../src/main/docgen/pptx-template/fill';
import { parseTemplateDeck } from '../src/main/docgen/pptx-template/parse';
import { listZipEntries, readZipEntry } from '../src/main/preview/zip-entry';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const TEMPLATES_ROOT = join(PACKAGE_ROOT, 'resources/pptx-templates');
const TEMPLATE_PATH = join(TEMPLATES_ROOT, 'business-deck-v4.pptx');

let outputDir: string;

beforeEach(() => {
  outputDir = mkdtempSync(join(PACKAGE_ROOT, '.pptx-actions-test-'));
});

afterEach(() => {
  if (outputDir) rmSync(outputDir, { recursive: true, force: true });
});

async function fillActions(data: Record<string, string>[]): Promise<Buffer> {
  const parsed = parseTemplateDeck({
    template: 'business-deck-v4',
    slides: data.map((slideData) => ({ templateId: 'actions', data: slideData })),
  });
  if (!parsed.ok) throw new Error(`Invalid actions deck: ${JSON.stringify(parsed.failure)}`);
  const outputPath = await fillTemplateDeck({
    deck: parsed.deck,
    templatesRoot: TEMPLATES_ROOT,
    outputDir,
    outputName: 'actions.pptx',
  });
  return readFileSync(outputPath);
}

function slideXmls(buffer: Buffer): string[] {
  return listZipEntries(buffer)
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry))
    .sort((a, b) => Number(a.match(/(\d+)/)![1]) - Number(b.match(/(\d+)/)![1]))
    .map((entry) => readZipEntry(buffer, entry)!.toString('utf8'));
}

function shapeText(xml: string, name: string): string | null {
  const shape = (xml.match(/<p:sp>[\s\S]*?<\/p:sp>/g) ?? []).find((item) =>
    new RegExp(`<p:cNvPr[^>]*name="${name}"`).test(item),
  );
  if (!shape) return null;
  return (shape.match(/<a:t>(.*?)<\/a:t>/g) ?? []).join('').replace(/<\/?a:t>/g, '');
}

function expectRows(xml: string, rows: number[], present: boolean): void {
  for (const row of rows) {
    expect(shapeText(xml, `ACTION_${row}_NUMBER`) !== null).toBe(present);
    expect(shapeText(xml, `ACTION_RULE_${row}`) !== null).toBe(present);
  }
}

describe('empty action rows in real template output', () => {
  it('removes badges and rules after the three populated rows while keeping content and footer', async () => {
    const [xml] = slideXmls(
      await fillActions([
        { slide_title: 'Action plan', action_1: 'Ship release', action_2: 'Train team', action_3: 'Review results' },
      ]),
    );

    expectRows(xml, [1, 2, 3], true);
    expectRows(xml, [4], false);
    expect(shapeText(xml, 'ACTION_1')).toBe('Ship release');
    expect(shapeText(xml, 'ACTION_2')).toBe('Train team');
    expect(shapeText(xml, 'ACTION_3')).toBe('Review results');
    expect(shapeText(xml, 'ACTION_1_NUMBER')).toBe('01');
    expect(shapeText(xml, 'FOOTER_PAGE_7')).toBe('01');
  });

  it('keeps all four badges and row rules when all four actions are populated', async () => {
    const [xml] = slideXmls(
      await fillActions([
        { slide_title: 'Action plan', action_1: 'One', action_2: 'Two', action_3: 'Three', action_4: 'Four' },
      ]),
    );

    expectRows(xml, [1, 2, 3, 4], true);
    expect([1, 2, 3, 4].map((row) => shapeText(xml, `ACTION_${row}_NUMBER`))).toEqual(['01', '02', '03', '04']);
  });

  it('treats whitespace-only values as an empty row', async () => {
    const [xml] = slideXmls(
      await fillActions([
        {
          slide_title: 'Action plan',
          action_1: 'One',
          action_2: ' \t ',
          owner_2: '  ',
          due_2: '\t',
        },
      ]),
    );

    expectRows(xml, [2], false);
  });

  it('keeps a row when only its owner is populated', async () => {
    const [xml] = slideXmls(await fillActions([{ slide_title: 'Action plan', action_1: 'One', owner_2: 'Taylor' }]));

    expectRows(xml, [2], true);
    expect(shapeText(xml, 'OWNER_2')).toBe('Taylor');
  });

  it('keeps a row when only its due date is populated', async () => {
    const [xml] = slideXmls(await fillActions([{ slide_title: 'Action plan', action_1: 'One', due_2: 'Friday' }]));

    expectRows(xml, [2], true);
    expect(shapeText(xml, 'DUE_2')).toBe('Friday');
  });

  it('handles repeated action slides independently and leaves the source template unchanged', async () => {
    const sourceBefore = readFileSync(TEMPLATE_PATH);
    const slides = slideXmls(
      await fillActions([
        { slide_title: 'First', action_1: 'First action' },
        { slide_title: 'Second', action_1: 'Second action', action_2: 'Another action' },
      ]),
    );

    expect(slides).toHaveLength(2);
    expectRows(slides[0], [1], true);
    expectRows(slides[0], [2, 3, 4], false);
    expectRows(slides[1], [1, 2], true);
    expectRows(slides[1], [3, 4], false);
    expect(shapeText(slides[0], 'ACTION_1')).toBe('First action');
    expect(shapeText(slides[1], 'ACTION_1')).toBe('Second action');
    expect(readFileSync(TEMPLATE_PATH)).toEqual(sourceBefore);
  });
});
