import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractSlidegenBlocks } from '../src/main/slidegen/blocks';
import { evaluateSlide } from '../src/main/slidegen/evaluate';

describe('slidegen component text children', () => {
  it('passes literal children to a declared component that renders Text', () => {
    const pages = evaluateSlide(`
      const PageTitle = ({ children }) => <Box><Text>{children}</Text></Box>;
      <Slide><PageTitle>Product introduction</PageTitle></Slide>
    `);
    expect(pages[0].children[0]).toMatchObject({
      tag: 'Box',
      children: [{ tag: 'Text', children: ['Product introduction'] }],
    });
  });

  it('preserves nested component children and ignores JSX comments without inventing text', () => {
    const pages = evaluateSlide(`
      const Caption = ({ children }) => <Text>{children}</Text>;
      const Frame = ({ children }) => <Box>{children}</Box>;
      <Slide><Frame>{/* layout note */}<Caption>{/* before */}Visible{/* after */}</Caption></Frame></Slide>
    `);
    expect(pages[0].children[0]).toMatchObject({
      tag: 'Box',
      children: [{ tag: 'Text', children: ['Visible'] }],
    });
  });

  it.each([
    'const Forward = ({ children }) => <Box>{children}</Box>; <Slide><Forward>must not vanish</Forward></Slide>',
    'const Forward = ({ children }) => children; <Slide><Forward>must not vanish</Forward></Slide>',
    'const Forward = () => "must not vanish"; <Slide><Forward/></Slide>',
    'const Forward = () => 123; <Slide><Forward/></Slide>',
  ])('still rejects text that reaches a built-in non-Text parent: %s', (source) => {
    expect(() => evaluateSlide(source)).toThrow(/text.*inside <Text>/);
  });

  it.each(['Slide', 'Box', 'Image'])('still rejects literal text directly inside built-in %s', (tag) => {
    expect(() => evaluateSlide(`<Slide><${tag}>must not vanish</${tag}></Slide>`)).toThrow(/text.*inside <Text>/);
  });

  it.each([
    [
      'slidegen-field-product-introduction-first.slidegen',
      12,
      'a070b23716353ba5f537bd5badced3f5413c7c3138bc28d9bed4e846a595966d',
    ],
    [
      'slidegen-field-product-introduction.slidegen',
      9,
      '92ad09ae0498c7a43dcd8a9b1415adc8545428906ceafe21856f9404c1311c41',
    ],
  ])(
    'evaluates original source plus one file terminator in %s, preserving component titles',
    (name, pageCount, originalSha) => {
      const fixture = fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
      expect(fixture.endsWith('\n')).toBe(true);
      expect(createHash('sha256').update(fixture.slice(0, -1)).digest('hex')).toBe(originalSha);
      const extracted = extractSlidegenBlocks(fixture);
      expect(extracted.failures).toEqual([]);
      expect(extracted.decks).toHaveLength(1);
      const pages = evaluateSlide(extracted.decks[0].source);
      expect(pages).toHaveLength(pageCount);
      for (const [, title] of fixture.matchAll(/<PageTitle[^>]*>([^<]+)<\/PageTitle>/g)) {
        expect(JSON.stringify(pages)).toContain(title.trim());
      }
      expect(JSON.stringify(pages)).toContain('\u8363\u76c8\u9b54\u65b9');
    },
  );
});
