import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { PPTX_TEMPLATE_FILE, PPTX_TEMPLATES } from '../src/main/docgen/pptx-template/catalog';
import { fillTemplateDeck } from '../src/main/docgen/pptx-template/fill';
import { parseTemplateDeck } from '../src/main/docgen/pptx-template/parse';
import { parseDocgenRequest } from '../src/main/docgen/request';
import { listZipEntries, readZipEntry } from '../src/main/preview/zip-entry';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const TEMPLATES_ROOT = join(PACKAGE_ROOT, 'resources/pptx-templates');
const TEMPLATE_PATH = join(TEMPLATES_ROOT, PPTX_TEMPLATE_FILE);
const HEADERS = ['action_header', 'owner_header', 'due_header'] as const;
const SHAPES = ['ACTION_HEADER', 'OWNER_HEADER', 'DUE_HEADER'];
const BASE = { slide_title: 'Cooperation services', action_1: 'Growth strategy' };
const outputs: string[] = [];

afterEach(() => {
  for (const dir of outputs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function parseActions(data: Record<string, string>[]) {
  const request = parseDocgenRequest({
    kind: 'pptx',
    title: 'Cooperation services',
    template: 'business-deck-v4',
    slides: data.map((values) => ({ templateId: 'actions', data: { ...BASE, ...values } })),
  });
  if (!request.ok || request.request.kind !== 'pptx') throw new Error('Invalid PPTX request');
  return parseTemplateDeck(request.request.rawTemplateDeck);
}

async function fillActions(data: Record<string, string>[]): Promise<string[]> {
  const parsed = parseActions(data);
  expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
  if (!parsed.ok) throw new Error('Invalid template deck');
  const outputDir = mkdtempSync(join(PACKAGE_ROOT, '.pptx-header-test-'));
  outputs.push(outputDir);
  const output = await fillTemplateDeck({
    deck: parsed.deck,
    templatesRoot: TEMPLATES_ROOT,
    outputDir,
    outputName: 'headers.pptx',
  });
  const buffer = readFileSync(output);
  return listZipEntries(buffer)
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))
    .map((entry) => readZipEntry(buffer, entry)!.toString('utf8'));
}

function shapeText(xml: string, name: string): string | null {
  const shape = (xml.match(/<p:sp>[\s\S]*?<\/p:sp>/g) ?? []).find((item) =>
    new RegExp(`<p:cNvPr[^>]*name="${name}"`).test(item),
  );
  if (!shape) return null;
  return (shape.match(/<a:t>(.*?)<\/a:t>/g) ?? []).join('').replace(/<\/?a:t>/g, '');
}

function headers(xml: string): (string | null)[] {
  return SHAPES.map((shape) => shapeText(xml, shape));
}

function sourceHeaders(): (string | null)[] {
  const xml = readZipEntry(readFileSync(TEMPLATE_PATH), `ppt/slides/slide${PPTX_TEMPLATES.actions.slide}.xml`);
  if (!xml) throw new Error('Missing actions template');
  const defaults = headers(xml.toString('utf8'));
  for (const value of defaults) {
    expect(value).toBeTruthy();
    expect(value).not.toMatch(/\{\{[^}]+\}\}/);
  }
  return defaults;
}

describe('action header overrides in real template output', () => {
  it('fills all three explicit labels and keeps table values in their columns', async () => {
    const [xml] = await fillActions([
      {
        action_header: 'Service',
        owner_header: 'Audience',
        due_header: 'Delivery',
        owner_1: 'Business teams',
        due_1: 'Workshop + plan',
      },
    ]);
    expect(headers(xml)).toEqual(['Service', 'Audience', 'Delivery']);
    expect(['ACTION_1', 'OWNER_1', 'DUE_1'].map((shape) => shapeText(xml, shape))).toEqual([
      BASE.action_1,
      'Business teams',
      'Workshop + plan',
    ]);
    expect(xml).not.toMatch(/\{\{[^}]+\}\}/);
  });

  it.each<Record<string, string>>([{}, { action_header: '', owner_header: ' \t ', due_header: '\n\r\t ' }])(
    'preserves the source template labels when header overrides are absent or blank: %j',
    async (data) => {
      const defaults = sourceHeaders();
      const [xml] = await fillActions([data]);
      expect(headers(xml)).toEqual(defaults);
      expect(shapeText(xml, 'OWNER_1')).toBe('');
      expect(shapeText(xml, 'DUE_1')).toBe('');
    },
  );

  it.each(HEADERS)('overrides only %s and preserves the other source labels', async (token) => {
    const expected = sourceHeaders();
    expected[HEADERS.indexOf(token)] = 'Custom label';
    const [xml] = await fillActions([{ [token]: 'Custom label' }]);
    expect(headers(xml)).toEqual(expected);
  });

  it('escapes XML in all header overrides as text', async () => {
    const value = '<a:hlinkClick> & label';
    const [xml] = await fillActions([Object.fromEntries(HEADERS.map((token) => [token, value]))]);
    expect(headers(xml)).toEqual(SHAPES.map(() => '&lt;a:hlinkClick&gt; &amp; label'));
    expect(xml).not.toContain('<a:hlinkClick>');
  });

  it('keeps repeated actions pages independent and leaves template bytes unchanged', async () => {
    const source = readFileSync(TEMPLATE_PATH);
    const slides = await fillActions([
      { action_header: 'Service', owner_header: 'Audience', due_header: 'Delivery' },
      {},
      { action_header: 'Next step', owner_header: 'Team', due_header: 'Date' },
    ]);
    expect(slides).toHaveLength(3);
    expect(headers(slides[0])).toEqual(['Service', 'Audience', 'Delivery']);
    expect(headers(slides[1])).toEqual(sourceHeaders());
    expect(headers(slides[2])).toEqual(['Next step', 'Team', 'Date']);
    expect(readFileSync(TEMPLATE_PATH)).toEqual(source);
  });

  it.each(HEADERS)('accepts 40 characters and rejects 41 for %s', (token) => {
    expect(parseActions([{ [token]: 'x'.repeat(40) }]).ok).toBe(true);
    expect(parseActions([{ [token]: 'x'.repeat(41) }])).toEqual({
      ok: false,
      failure: {
        code: 'template-field-too-long',
        format: 'pptx',
        page: 1,
        templateId: 'actions',
        field: token,
        maxChars: 40,
      },
    });
  });

  it('rejects unknown header fields without inferring a label', () => {
    expect(parseActions([{ service_header: 'Service' }])).toEqual({
      ok: false,
      failure: {
        code: 'template-field-unknown',
        format: 'pptx',
        page: 1,
        templateId: 'actions',
        field: 'service_header',
      },
    });
  });
});
