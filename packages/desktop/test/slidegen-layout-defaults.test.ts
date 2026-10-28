import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractSlidegenBlocks } from '../src/main/slidegen/blocks';
import { evaluateSlide } from '../src/main/slidegen/evaluate';
import { renderSlide } from '../src/main/slidegen/layout';

function styles(html: string): string[] {
  return [...html.matchAll(/style="([^"]*)"/g)].map((match) => match[1]);
}

describe('slidegen explicit CSS flex and implicit DSL defaults', () => {
  it.each([
    ['Slide', 'flex'],
    ['Slide', 'inline-flex'],
    ['Box', 'flex'],
    ['Box', 'inline-flex'],
  ])('preserves CSS row default for %s with explicit display:%s', (tag, display) => {
    const element = `<${tag} style={{ display: '${display}', alignItems: 'center' }}><Text>Title</Text></${tag}>`;
    const [page] = evaluateSlide(tag === 'Slide' ? element : `<Slide>${element}</Slide>`);
    const actual = styles(renderSlide(page).html)[tag === 'Slide' ? 0 : 1];
    expect(actual).toContain(`display:${display}`);
    expect(actual).toContain('flex-direction:row');
    expect(actual).not.toContain('flex-direction:column');
  });

  it('keeps both implicit Slide and Box as column for existing DSL title stacks', () => {
    const [page] = evaluateSlide('<Slide><Box><Text>Title</Text><Text>Subtitle</Text></Box></Slide>');
    const actual = styles(renderSlide(page).html);
    expect(actual[0]).toContain('display:flex;flex-direction:column');
    expect(actual[1]).toContain('display:flex;flex-direction:column');
  });

  it('keeps an explicitly requested column even when display:flex is explicit', () => {
    const [page] = evaluateSlide('<Slide style={{ display: "flex", flexDirection: "column" }} />');
    expect(styles(renderSlide(page).html)[0]).toContain('display:flex;flex-direction:column');
  });

  it('does not rotate the field deck page 2 cross-axis and move its left text beneath SUMMARY', () => {
    const original = fs.readFileSync(
      new URL('./fixtures/slidegen-field-eight-pages.slidegen', import.meta.url),
      'utf8',
    );
    const extracted = extractSlidegenBlocks(original);
    const pages = evaluateSlide(extracted.decks[0].source);
    expect(pages).toHaveLength(8);
    const html = renderSlide(pages[1]).html;
    const actual = styles(html);
    expect(actual[0]).toContain('display:flex;align-items:center;flex-direction:row');
    expect(html).toContain('margin-left:100px;width:530px;flex-direction:column');
    expect(html).toContain('position:absolute;right:80px;top:170px;width:380px');
    expect(html).toContain('font-size:17px;color:#8B83A3;line-height:1.7');
  });
});
