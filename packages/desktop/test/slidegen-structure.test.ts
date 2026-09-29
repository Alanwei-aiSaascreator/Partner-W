import { describe, expect, it } from 'vitest';
import { SlideDslError, transformSlideJsx } from '../src/main/slidegen/dsl';
import { evaluateSlide } from '../src/main/slidegen/evaluate';
import { extractSlidegenBlocks } from '../src/main/slidegen/blocks';

function parseError(source: string): SlideDslError {
  try {
    transformSlideJsx(source);
  } catch (error) {
    expect(error).toBeInstanceOf(SlideDslError);
    return error as SlideDslError;
  }
  throw new Error('Expected invalid slide markup to be rejected');
}

describe('slidegen structural diagnostics', () => {
  it('rejects the field report sibling text without silently losing it from PPT export', () => {
    const source = [
      '// title: \u56de\u5f52\u7528\u4f8b',
      "<Slide style={{ width: 1280, height: 720, background: '#FFFFFF' }}>",
      '  <Text style={{ fontSize: 20 }} />\u6807\u7b7e',
      '  <Text style={{ fontSize: 20 }}>\u6b63\u6587</Text>',
      '</Slide>',
    ].join('\n');
    expect(parseError(source)).toMatchObject({
      code: 'dsl-text-outside-text',
      offset: source.indexOf('\u6807\u7b7e'),
    });
  });

  it.each([
    '<Slide><Text>body</Slide>',
    '<Slide><Box><Text>body</Box></Text></Slide>',
    '<Slide>{[1].map(() => (<Text>body</Box>))}</Slide>',
  ])('reports the actual mismatched closing name and source offset: %s', (source) => {
    const expectedClose = source.includes('</Box>') ? '</Box>' : '</Slide>';
    expect(parseError(source)).toMatchObject({
      code: 'dsl-close-mismatch',
      message: `expected </Text> but found ${expectedClose}`,
      offset: source.indexOf(expectedClose),
    });
  });

  it('reports a stray closing tag separately from an unknown tag', () => {
    const source = '<Slide /></Slide>';
    expect(parseError(source)).toMatchObject({
      code: 'dsl-stray-close',
      message: 'stray closing tag </Slide>',
      offset: source.indexOf('</Slide>'),
    });
  });

  it.each(['<Slide><Text>body', '<Slide><Text>body</Text'])('locates an unclosed tag: %s', (source) => {
    const expectedOffset = source.includes('</Text') ? source.indexOf('</Text') : source.indexOf('<Text>');
    expect(parseError(source)).toMatchObject({ code: 'dsl-unparsable', offset: expectedOffset });
  });

  it('rejects malformed closing syntax instead of skipping it', () => {
    const source = '<Slide><Text>body</Text extra></Slide>';
    expect(parseError(source)).toMatchObject({ code: 'dsl-unparsable', offset: source.indexOf('</Text') });
  });

  it('keeps self-closing elements and text inside Text unchanged', () => {
    const [slide] = evaluateSlide('<Slide><Text /><Box /><Text>label</Text></Slide>');
    expect(slide.children).toHaveLength(3);
    expect(slide.children[2]).toMatchObject({ tag: 'Text', children: ['label'] });
  });

  it('does not treat closing-tag text in template literals as markup', () => {
    const [slide] = evaluateSlide('<Slide><Text>{`literal </Text> ${1}`}</Text></Slide>');
    expect(slide.children[0]).toMatchObject({ tag: 'Text', children: ['literal </Text> 1'] });
  });

  it.each(['<Slide>{"label"}</Slide>', '<Slide><Box>{[1, 2]}</Box></Slide>'])(
    'rejects expression-produced text outside Text rather than losing it: %s',
    (source) => {
      expect(() => evaluateSlide(source)).toThrowError(expect.objectContaining({ code: 'dsl-text-outside-text' }));
    },
  );

  it.each(['<Slide / >', '<Slide><Text>literal < broken</Text></Slide>'])(
    'rejects invalid syntax without stalling the scanner: %s',
    (source) => {
      expect(parseError(source)).toMatchObject({ code: 'dsl-unparsable', offset: expect.any(Number) });
    },
  );

  it('carries structural diagnostics through block extraction', () => {
    const source = '// title: report\n<Slide><Text>body</Slide>';
    const result = extractSlidegenBlocks('```slidegen\n' + source + '\n```');
    expect(result.decks).toEqual([]);
    expect(result.failures[0].failure).toMatchObject({
      code: 'slidegen-unparsable',
      diagnostic: { code: 'dsl-close-mismatch', offset: source.indexOf('</Slide>') },
    });
  });
});
