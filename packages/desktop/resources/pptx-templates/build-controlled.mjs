import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
const templateDirectory = path.dirname(fileURLToPath(import.meta.url));
const emu = (inches) => Math.round(inches * 914400);
const positions = {
  SLIDE_TITLE: [0.67, 0.45, 11.6, 1.05],
  SLIDE_SUBTITLE: [0.67, 1.52, 11.6, 0.62],
  TITLE_ACCENT: [0.67, 2.22, 1.1, 0.04],
  TAKEAWAY_LABEL: [0.67, 2.48, 2, 0.35],
  TAKEAWAY: [0.67, 2.92, 11.6, 1.1],
  INSIGHT_RULE: [0.67, 4.12, 11.6, 0.01],
  COVER_SUBTITLE: [0.67, 3.8, 7.1, 0.85],
  COVER_DATE: [0.67, 5.45, 2.7, 0.35],
  COVER_AUTHOR: [3.8, 5.45, 4.2, 0.35],
  COVER_META_SEPARATOR: [3.48, 5.45, 0.2, 0.35],
  CLOSING_MESSAGE: [0.67, 3.8, 10.5, 1.2],
  CLOSING_RULE: [0.67, 5.25, 1.35, 0.05],
  CLOSING_CONTACT: [0.67, 5.57, 10.5, 0.5],
};
async function main() {
  const original = fs.readFileSync(path.join(templateDirectory, 'business-deck-v4.pptx'));
  const zip = await JSZip.loadAsync(original);
  for (const page of [1, 3, 5, 8]) {
    const entry = `ppt/slides/slide${page}.xml`;
    let xml = await zip.file(entry).async('string');
    xml = xml
      .replace(/<p:sp\b[\s\S]*?<\/p:sp>/g, (shape) => {
        const name = /<p:cNvPr\b[^>]*name="([^"]*)"/.exec(shape)?.[1] || '';
        if (name === 'COVER_SIDE_NOTE') return '';
        const font = /(?:COVER|SLIDE|CLOSING)_TITLE$/.test(name)
          ? 3200
          : /^(?:EVIDENCE_\d$|SLIDE_SUBTITLE|COVER_SUBTITLE|CLOSING_MESSAGE|CLOSING_CONTACT|COVER_DATE|COVER_AUTHOR|METRIC_\d_(?:LABEL|NOTE)|METRIC_SOURCE|TAKEAWAY)/.test(
                name,
              )
            ? 1800
            : name.startsWith('FOOTER_')
              ? 1200
              : null;
        if (font) shape = shape.replace(/\bsz="\d+"/g, `sz="${font}"`);
        shape = shape.replace(/<a:normAutofit\b[^>]*\/>/g, '<a:noAutofit/>');
        const pos =
          positions[name] ||
          (name.startsWith('FOOTER_PAGE_')
            ? [12.0, 7.03, 0.6, 0.27]
            : name.startsWith('FOOTER_BRAND_')
              ? [0.67, 7.03, 3, 0.27]
              : null);
        if (pos) {
          shape = shape
            .replace(/<a:off\b[^>]*\/>/, `<a:off x="${emu(pos[0])}" y="${emu(pos[1])}"/>`)
            .replace(/<a:ext\b[^>]*\/>/, `<a:ext cx="${emu(pos[2])}" cy="${emu(pos[3])}"/>`);
        }
        return shape;
      })
      .replaceAll('C51D78', '087CB8');
    zip.file(entry, xml);
  }
  const output = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  fs.writeFileSync(path.join(templateDirectory, 'business-deck-v5.pptx'), output);
  process.stdout.write(
    JSON.stringify({
      source: crypto.createHash('sha256').update(original).digest('hex'),
      output: crypto.createHash('sha256').update(output).digest('hex'),
      bytes: output.length,
    }) + '\n',
  );
}
main().catch((error) => {
  process.stderr.write(String(error));
  process.exitCode = 1;
});
