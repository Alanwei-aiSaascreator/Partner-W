import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderPptx } from '../src/main/docgen/render-pptx';
import { parseDocgenRequest } from '../src/main/docgen/request';
import { listZipEntries, readZipEntry } from '../src/main/preview/zip-entry';

function parse(slides: unknown[]) {
  const result = parseDocgenRequest({ kind: 'pptx', title: 'Readable deck', slides });
  if (!result.ok) throw new Error(result.error);
  if (result.request.kind !== 'pptx') throw new Error('Unexpected format');
  return result.request;
}

function textOf(xml: string): string[] {
  return [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((match) =>
    match[1]
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&'),
  );
}

function contentPages(buffer: Buffer): string[] {
  return listZipEntries(buffer)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((left, right) => Number(left.match(/slide(\d+)/)?.[1]) - Number(right.match(/slide(\d+)/)?.[1]))
    .slice(1)
    .map((name) => readZipEntry(buffer, name)!.toString('utf8'));
}

function bodyShapes(xml: string): string[] {
  return (xml.match(/<p:sp>[\s\S]*?<\/p:sp>/g) ?? []).filter((shape) => shape.includes('<a:buChar'));
}

describe('readable native PPTX pagination', () => {
  it('preserves twelve bullets across pages instead of shrinking body text below 18pt', async () => {
    const bullets = Array.from({ length: 12 }, (_, index) => `Item ${index + 1}: retain this complete evidence.`);
    const pages = contentPages(await renderPptx(parse([{ title: 'Evidence', bullets }])));
    expect(pages.length).toBeGreaterThan(1);
    const shapes = pages.flatMap(bodyShapes);
    expect(shapes).toHaveLength(pages.length);
    expect(shapes.flatMap(textOf)).toEqual(bullets);
    for (const shape of shapes) {
      const sizes = [...shape.matchAll(/sz="(\d+)"/g)].map((match) => Number(match[1]) / 100);
      expect(sizes.length).toBeGreaterThan(0);
      expect(Math.min(...sizes)).toBeGreaterThanOrEqual(18);
    }
    pages.forEach((xml, index) => expect(textOf(xml)).toContain(`${index + 2} / ${pages.length + 1}`));
  });

  it('splits maximum legal CJK bullets without losing characters, escaping or surrogate pairs', async () => {
    const bullets = Array.from({ length: 12 }, (_, index) => {
      const start = `${index + 1}: <A&B> \u4e2d\u6587\u3002`;
      return start + '\u5185'.repeat(300 - start.length - 2) + '\u{1f680}';
    });
    const request = parse([{ title: 'Coverage', bullets, notes: 'Speaker detail retained once' }]);
    const original = JSON.stringify(request);
    const bytes = await renderPptx(request);
    const pages = contentPages(bytes);
    expect(pages.length).toBeGreaterThan(2);
    expect(pages.flatMap(bodyShapes).flatMap(textOf).join('')).toBe(bullets.join(''));
    expect(
      Math.min(
        ...pages
          .flatMap(bodyShapes)
          .flatMap(textOf)
          .map((text) => Array.from(text).length),
      ),
    ).toBeGreaterThan(80);
    expect(JSON.stringify(request)).toBe(original);
    const notes = listZipEntries(bytes)
      .filter((name) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name))
      .map((name) => readZipEntry(bytes, name)!.toString('utf8'));
    expect(notes.filter((xml) => xml.includes('Speaker detail retained once'))).toHaveLength(1);
    if (process.env.MOFANG_PPTX_PAGINATION_OUT) {
      mkdirSync(process.env.MOFANG_PPTX_PAGINATION_OUT, { recursive: true });
      writeFileSync(join(process.env.MOFANG_PPTX_PAGINATION_OUT, 'readable-cjk-pagination.pptx'), bytes);
    }
  });

  it('keeps the following source page after all continuation pages', async () => {
    const pages = contentPages(
      await renderPptx(
        parse([
          { title: 'Evidence', bullets: Array.from({ length: 12 }, (_, index) => `Original item ${index + 1}`) },
          { title: 'Next chapter', bullets: ['Next source page remains intact'] },
        ]),
      ),
    );
    expect(pages.length).toBeGreaterThan(2);
    expect(textOf(pages.at(-1)!)).toContain('Next chapter');
    expect(textOf(pages.at(-1)!)).toContain('Next source page remains intact');
  });

  it('still refuses malformed headings and line breaks before rendering', async () => {
    await expect(
      renderPptx(
        parse([
          { title: 'Evidence', bullets: Array.from({ length: 12 }, () => '\u5185'.repeat(300)) },
          { title: 'Invalid heading', bullets: ['First line\nSecond line'] },
        ]),
      ),
    ).rejects.toMatchObject({ problem: { code: 'slide-bullet-multiline', page: 2, bullet: 1 } });
  });
});
