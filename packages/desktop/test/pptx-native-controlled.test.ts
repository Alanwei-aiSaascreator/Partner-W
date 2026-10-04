import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';
import { parseTemplateDeck } from '../src/main/docgen/pptx-template/parse';
import { fillTemplateDeck } from '../src/main/docgen/pptx-template/fill';
import { checkNativePpt } from '../src/main/docgen/pptx-template/check';

const templatesRoot = join(import.meta.dirname, '../resources/pptx-templates');
const fixture = (slides: unknown[]) => ({ template: 'business-deck-v5', slides });
const chart = {
  type: 'bar',
  unit: 'CNY 10k',
  data: [
    { name: 'Revenue', labels: ['Jul', 'Aug', 'Sep'], values: [120, 135, 150] },
    { name: 'Cost', labels: ['Jul', 'Aug', 'Sep'], values: [96, 105, 114] },
  ],
};
const chartSlide = {
  templateId: 'metrics',
  data: { slide_title: 'Quarterly results', value_1: '405', label_1: 'Revenue' },
  chart,
};
const scratch: string[] = [];
afterEach(() => scratch.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

describe('controlled native template route', () => {
  it('keeps v5 rejected by the default parser', () => {
    expect(parseTemplateDeck(fixture([chartSlide])).ok).toBe(false);
  });

  it('admits the bounded library chart data only in the controlled route', () => {
    const parsed = parseTemplateDeck(fixture([chartSlide]), { controlledNative: true });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.deck.slides[0].chart).toEqual(chart);
  });

  it('rejects different category labels, unknown chart options and missing units', () => {
    for (const bad of [
      { ...chart, data: [chart.data[0], { ...chart.data[1], labels: ['Wrong', 'Aug', 'Sep'] }] },
      { ...chart, unit: '' },
      { ...chart, x: 1 },
      { ...chart, data: [{ ...chart.data[0], values: [120, NaN, 150] }] },
    ]) {
      expect(parseTemplateDeck(fixture([{ ...chartSlide, chart: bad }]), { controlledNative: true }).ok).toBe(false);
    }
  });

  it('returns explicit capacity diagnostics instead of shrinking or dropping text', () => {
    const parsed = parseTemplateDeck(
      fixture([{ templateId: 'insight', data: { slide_title: 'Capacity', evidence_1: 'x'.repeat(151) } }]),
      { controlledNative: true },
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.failure).toMatchObject({ code: 'template-field-too-long', field: 'evidence_1' });
  });

  it('exports editable chart/table and removes inherited metric decoration', async () => {
    const parsed = parseTemplateDeck(
      fixture([
        { templateId: 'cover', data: { cover_title: 'Controlled check' } },
        {
          ...chartSlide,
          data: { ...chartSlide.data, source_or_note: chartSlide.data.slide_title },
        },
      ]),
      { controlledNative: true },
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const outputDir = mkdtempSync(join(tmpdir(), 'native-template-check-'));
    scratch.push(outputDir);
    const file = await fillTemplateDeck({ deck: parsed.deck, templatesRoot, outputDir, outputName: 'chart.pptx' });
    const zip = await JSZip.loadAsync(readFileSync(file));
    const xml = await zip.file('ppt/slides/slide2.xml')!.async('string');
    expect(xml).toContain('<c:chart');
    expect(xml).toContain('<a:tbl');
    const tableXml = xml.match(/<a:tbl>[\s\S]*?<\/a:tbl>/)![0];
    const tableSizes = [...tableXml.matchAll(/<a:rPr\b[^>]*\bsz="(\d+)"/g)].map((match) => Number(match[1]));
    expect(tableSizes.length).toBeGreaterThan(0);
    expect(Math.min(...tableSizes)).toBeGreaterThanOrEqual(1800);
    expect((xml.match(/<a:tr\b/g) ?? []).length).toBe(4);
    for (const value of ['Jul', 'Aug', 'Sep', '120', '135', '150', '96', '105', '114'])
      expect(xml).toContain(`<a:t>${value}</a:t>`);
    expect(parsed.deck.slides[1].chart).toEqual(chart);
    expect(xml).not.toContain('METRIC_1_VALUE');
    expect(xml).toContain('02');
    expect(xml).not.toContain('{{');
    expect(xml).toContain('name="ROYIN_SOURCE_NOTE"');
    const chartEntry = Object.keys(zip.files).find((name) => /^ppt\/charts\/chart\d+\.xml$/.test(name))!;
    const chartXml = await zip.file(chartEntry)!.async('string');
    const visibleChartText = [...chartXml.matchAll(/<c:(?:catAx|valAx|legend)>[\s\S]*?<\/c:(?:catAx|valAx|legend)>/g)];
    expect(visibleChartText).toHaveLength(3);
    for (const [xml] of visibleChartText) {
      const sizes = [...xml.matchAll(/<a:defRPr\b[^>]*\bsz="(\d+)"/g)].map((match) => Number(match[1]));
      expect(sizes.length).toBeGreaterThan(0);
      expect(Math.min(...sizes)).toBeGreaterThanOrEqual(1800);
    }
    expect(chartXml).toContain('Revenue');
    expect(chartXml).toContain('150');
    expect(Object.keys(zip.files).some((name) => /^ppt\/embeddings\/.*\.xlsx$/.test(name))).toBe(true);
    expect(() => checkNativePpt(readFileSync(file), parsed.deck)).not.toThrow();
    zip.file(
      'ppt/slides/slide2.xml',
      xml.replace(/<p:sp>[\s\S]*?<\/p:sp>/g, (shape) =>
        shape.includes('name="SLIDE_TITLE"') ? shape.replace(/\bsz="3200"/g, 'sz="900"') : shape,
      ),
    );
    const repeatedNote = await zip.generateAsync({ type: 'nodebuffer' });
    expect(() => checkNativePpt(repeatedNote, parsed.deck)).toThrow('native-font-too-small');
    zip.file('ppt/slides/slide2.xml', xml.replace(tableXml, tableXml.replace(/\bsz="1800"/g, 'sz="1125"')));
    const unreadable = await zip.generateAsync({ type: 'nodebuffer' });
    expect(() => checkNativePpt(unreadable, parsed.deck)).toThrow('native-font-too-small');
    zip.file('ppt/slides/slide2.xml', xml.replace(/<a:tr\b[\s\S]*?<\/a:tr>/, ''));
    const damaged = await zip.generateAsync({ type: 'nodebuffer' });
    expect(() => checkNativePpt(damaged, parsed.deck)).toThrow('native-table-data-mismatch');
  });

  it('accepts the fixed cover metadata separator without relaxing body fonts', async () => {
    const parsed = parseTemplateDeck(
      fixture([{ templateId: 'cover', data: { cover_title: 'Full cover', date: '2026-10-02', author: 'QA' } }]),
      { controlledNative: true },
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const outputDir = mkdtempSync(join(tmpdir(), 'native-cover-check-'));
    scratch.push(outputDir);
    const file = await fillTemplateDeck({ deck: parsed.deck, templatesRoot, outputDir, outputName: 'cover.pptx' });
    expect(() => checkNativePpt(readFileSync(file), parsed.deck)).not.toThrow();
    const zip = await JSZip.loadAsync(readFileSync(file));
    const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
    expect(xml).toContain('name="COVER_META_SEPARATOR"');
    expect(xml).toContain('<a:t>/</a:t>');
  });

  it('rejects combined chart metric text that exceeds its shared text box', () => {
    const parsed = parseTemplateDeck(
      fixture([
        {
          ...chartSlide,
          data: { slide_title: 'Capacity', label_1: '标'.repeat(24), value_1: '405', note_1: '注'.repeat(24) },
        },
      ]),
      { controlledNative: true },
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok)
      expect(parsed.failure).toMatchObject({ code: 'template-field-too-long', field: 'metric_1', maxChars: 40 });
  });

  it('does not retain the unverified offline capability claim in the shared controlled cover', async () => {
    const zip = await JSZip.loadAsync(readFileSync(join(templatesRoot, 'business-deck-v5.pptx')));
    expect(await zip.file('ppt/slides/slide1.xml')!.async('string')).not.toContain('离线可用');
  });

  it('removes empty insight labels and retains all supplied text at readable sizes', async () => {
    const parsed = parseTemplateDeck(
      fixture([
        {
          templateId: 'insight',
          data: {
            slide_title: 'Long text',
            evidence_1: 'Required first paragraph',
            evidence_2: 'Required second paragraph',
          },
        },
      ]),
      { controlledNative: true },
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const outputDir = mkdtempSync(join(tmpdir(), 'native-template-check-'));
    scratch.push(outputDir);
    const file = await fillTemplateDeck({ deck: parsed.deck, templatesRoot, outputDir, outputName: 'text.pptx' });
    const zip = await JSZip.loadAsync(readFileSync(file));
    const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
    expect(xml).toContain('Required first paragraph');
    expect(xml).toContain('Required second paragraph');
    expect(xml).not.toContain('TAKEAWAY_LABEL');
    expect(xml).not.toContain('EVIDENCE_3_NUMBER');
    expect(xml).toContain('sz="1800"');
    expect(xml).toContain('sz="3200"');
    expect(xml).not.toContain('<a:normAutofit');
    zip.file(
      'ppt/slides/slide1.xml',
      xml.replace(/<p:sp>[\s\S]*?<\/p:sp>/g, (shape) =>
        shape.includes('name="EVIDENCE_1"')
          ? shape
              .replace(/(<a:(?:rPr|defRPr)\b[^>]*?)\s+sz="\d+"/g, '$1')
              .replace(/<a:endParaRPr\b[^>]*\/>/g, '<a:endParaRPr sz="1800"/>')
          : shape,
      ),
    );
    const unresolved = await zip.generateAsync({ type: 'nodebuffer' });
    expect(() => checkNativePpt(unresolved, parsed.deck)).toThrow('native-font-unresolved');
    zip.file(
      'ppt/slides/slide1.xml',
      xml.replace(/<p:sp>[\s\S]*?<\/p:sp>/g, (shape) =>
        shape.includes('name="EVIDENCE_1"') ? shape.replace(/\bsz="1800"/g, 'sz="1125"') : shape,
      ),
    );
    const unreadable = await zip.generateAsync({ type: 'nodebuffer' });
    expect(() => checkNativePpt(unreadable, parsed.deck)).toThrow('native-font-too-small');
  });
});
