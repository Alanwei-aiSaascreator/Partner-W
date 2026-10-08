import { listZipEntries, readZipEntry } from '../../preview/zip-entry.js';
import type { TemplateDeckSpec } from './parse.js';

const decode = (text: string) =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

function requireFontSize(xml: string, minimum: number, page: number, generatedChartLabels = false): void {
  let checked = 0;
  for (const [paragraph] of xml.matchAll(/<a:p(?:\s[^>]*)?>[\s\S]*?<\/a:p>/g)) {
    const defaults = /<a:pPr\b[^>]*>[\s\S]*?<\/a:pPr>/.exec(paragraph)?.[0] ?? '';
    const inherited = /<a:defRPr\b[^>]*\bsz="(\d+)"/.exec(defaults)?.[1];
    for (const [run] of paragraph.matchAll(/<a:r(?:\s[^>]*)?>[\s\S]*?<\/a:r>/g)) {
      const text = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/.exec(run)?.[1];
      if (!text || !decode(text).trim()) continue;
      const size = /<a:rPr\b[^>]*\bsz="(\d+)"/.exec(run)?.[1] ?? inherited;
      if (!size) throw new Error(`native-font-unresolved:${page}`);
      if (Number(size) < minimum) throw new Error(`native-font-too-small:${page}`);
      checked++;
    }
    if (generatedChartLabels && inherited) {
      if (Number(inherited) < minimum) throw new Error(`native-font-too-small:${page}`);
      checked++;
    }
  }
  if (!checked) throw new Error(`native-font-unresolved:${page}`);
}

export function checkNativePpt(buffer: Buffer, deck: TemplateDeckSpec): void {
  const entries = listZipEntries(buffer);
  const slides = entries.filter((file) => /^ppt\/slides\/slide\d+\.xml$/.test(file));
  if (slides.length !== deck.slides.length) throw new Error('native-page-count-mismatch');
  const read = (file: string) => {
    const bytes = readZipEntry(buffer, file);
    if (!bytes || bytes.length > 2 * 1024 * 1024) throw new Error('native-output-check-failed');
    return bytes.toString('utf8');
  };
  let expectedCharts = 0;
  for (let index = 0; index < deck.slides.length; index++) {
    const slide = deck.slides[index];
    const xml = read(`ppt/slides/slide${index + 1}.xml`);
    const text = [...xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map((match) => decode(match[1])).join('\n');
    if (text.includes('{{') || /<a:normAutofit/.test(xml)) throw new Error('native-placeholder-or-shrink');
    for (const [shape] of xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)) {
      const name = /<p:cNvPr\b[^>]*\bname="([^"]+)"/.exec(shape)?.[1] ?? '';
      const visible = [...shape.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map((m) => decode(m[1])).join('\n');
      if (!visible.trim()) continue;
      const annotation =
        /^FOOTER_|_(?:BRAND|SIDE_LABEL|NUMBER|INDEX)$/.test(name) ||
        ['METRIC_SOURCE', 'ROYIN_SOURCE_NOTE', 'COVER_META_SEPARATOR'].includes(name);
      requireFontSize(shape, annotation ? 900 : /^(?:COVER|SLIDE|CLOSING)_TITLE$/.test(name) ? 3200 : 1800, index + 1);
    }
    for (const [field, value] of Object.entries(slide.data)) {
      if (!value) continue;
      if (!text.includes(value)) throw new Error(`native-field-coverage:${index + 1}:${field}`);
    }
    if (slide.chart) {
      expectedCharts++;
      if (!xml.includes('<c:chart') || !xml.includes('<a:tbl') || !text.includes(slide.chart.unit))
        throw new Error('native-chart-or-table-missing');
      const table = /<a:tbl(?:\s[^>]*)?>[\s\S]*?<\/a:tbl>/.exec(xml)?.[0] ?? '';
      requireFontSize(table, 1800, index + 1);
      const tableRows = [...table.matchAll(/<a:tr\b[^>]*>[\s\S]*?<\/a:tr>/g)].map((row) =>
        [...row[0].matchAll(/<a:tc(?:\s[^>]*)?>[\s\S]*?<\/a:tc>/g)].map((cell) =>
          [...cell[0].matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map((match) => decode(match[1])).join(''),
        ),
      );
      const expectedRows = [
        ['Period', ...slide.chart.data.map((series) => series.name)],
        ...slide.chart.data[0].labels.map((label, row) => [
          label,
          ...slide.chart!.data.map((series) => String(series.values[row])),
        ]),
      ];
      if (JSON.stringify(tableRows) !== JSON.stringify(expectedRows)) throw new Error('native-table-data-mismatch');
      const chartLink = /<c:chart\b[^>]*r:id="([^"]+)"/.exec(xml)?.[1];
      const relations = read(`ppt/slides/_rels/slide${index + 1}.xml.rels`);
      const target = [...relations.matchAll(/<Relationship\b[^>]*\/>/g)].find((match) =>
        match[0].includes(`Id="${chartLink}"`),
      )?.[0];
      const file = /Target="\.\.\/(charts\/[^"<>]+)"/.exec(target ?? '')?.[1];
      if (!file) throw new Error('native-chart-relation-invalid');
      const chartXml = read(`ppt/${file}`);
      const chartText = [...chartXml.matchAll(/<c:(?:catAx|valAx|legend)>[\s\S]*?<\/c:(?:catAx|valAx|legend)>/g)];
      if (chartText.length !== 3) throw new Error('native-chart-text-missing');
      for (const [text] of chartText) requireFontSize(text, 1800, index + 1, true);
      const series = [...chartXml.matchAll(/<c:ser(?:\s[^>]*)?>[\s\S]*?<\/c:ser>/g)];
      if (series.length !== slide.chart.data.length) throw new Error('native-chart-data-mismatch');
      for (let s = 0; s < series.length; s++) {
        const data = slide.chart.data[s],
          raw = series[s][0];
        const numbers = /<c:numCache(?:\s[^>]*)?>[\s\S]*?<\/c:numCache>/.exec(raw)?.[0] ?? '';
        const values = [...numbers.matchAll(/<c:v>([^<]+)<\/c:v>/g)].map((match) => Number(match[1]));
        if (
          JSON.stringify(values) !== JSON.stringify(data.values) ||
          !decode(raw).includes(data.name) ||
          data.labels.some((label) => !decode(raw).includes(label))
        )
          throw new Error('native-chart-data-mismatch');
      }
    }
  }
  if (
    entries.filter((file) => /^ppt\/charts\/chart\d+\.xml$/.test(file)).length !== expectedCharts ||
    entries.filter((file) => /^ppt\/embeddings\/.*\.xlsx$/.test(file)).length !== expectedCharts
  )
    throw new Error('native-chart-count-mismatch');
}
