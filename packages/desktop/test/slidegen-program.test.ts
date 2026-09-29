import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { evaluateSlide } from '../src/main/slidegen/evaluate';
import { extractSlidegenBlocks } from '../src/main/slidegen/blocks';
import { failureFromError } from '../src/main/slidegen/generate';

describe('slidegen full programs', () => {
  it('preserves palette declarations and adjacent page expressions in source order', () => {
    const pages = evaluateSlide(
      'const C = { bg: "#102030" }; let n = 1; <Slide style={{background:C.bg}}><Text>{n}</Text></Slide> n += 1; <Slide><Text>{n}</Text></Slide>',
    );
    expect(pages).toHaveLength(2);
    expect(pages[0].props.style).toEqual({ background: '#102030' });
    expect(pages.map((page) => page.children[0])).toEqual([
      expect.objectContaining({ children: [1] }),
      expect.objectContaining({ children: [2] }),
    ]);
  });

  it('executes uppercase components, function declarations and map without treating declarations as pages', () => {
    const pages = evaluateSlide(`
      const Footer = ({ n }) => <Text>{n}</Text>;
      function Page({ n }) { return <Slide><Footer n={n}/></Slide>; }
      const unused = <Box/>;
      [1,2,3].map(n => <Page n={n}/>);
    `);
    expect(pages).toHaveLength(3);
    expect(pages.map((page) => page.children[0])).toEqual(
      [1, 2, 3].map((n) => expect.objectContaining({ tag: 'Text', children: [n] })),
    );
  });

  it('does not execute an unused component body or collect its nested Slide as a page', () => {
    expect(evaluateSlide('function Unused(){ throw new Error("do not run"); return <Slide/>; } <Slide/>')).toHaveLength(
      1,
    );
  });

  it('preserves the original field eight-page deck with palette constants and nested map calls', () => {
    const source = fs.readFileSync(new URL('./fixtures/slidegen-field-eight-pages.slidegen', import.meta.url), 'utf8');
    const extracted = extractSlidegenBlocks(source);
    expect(extracted.failures).toEqual([]);
    expect(extracted.decks).toHaveLength(1);
    const pages = evaluateSlide(extracted.decks[0].source);
    expect(pages).toHaveLength(8);
    expect(pages.every((page) => (page.props.style as { background: string }).background === '#0F0A1A')).toBe(true);
    expect(JSON.stringify(pages)).toContain('\u8ba4\u8bc6\u6211');
  });

  it('preserves an undefined identifier in visible failure diagnostics', () => {
    try {
      evaluateSlide('const X = {}; <Slide style={{color:Y.z}}/>');
      throw new Error('expected evaluation failure');
    } catch (error) {
      expect(failureFromError(error)).toMatchObject({
        code: 'slidegen-eval-failed',
        diagnostic: { code: 'dsl-eval-failed', detail: expect.stringContaining('Y is not defined') },
      });
    }
  });

  it('rejects a non-string VM result without invoking its coercion method on the host', () => {
    expect(() =>
      evaluateSlide(
        'const __sgRuntime = { finish: () => ({ toString() { throw new Error("host coercion ran"); } }) }; <Slide/>',
      ),
    ).toThrow('evaluation returned a non-string result');
  });

  it('freezes the runtime entry points before evaluating the deck', () => {
    const pages = evaluateSlide('<Slide><Text>{String(Object.isFrozen(__sgRuntime))}</Text></Slide>');
    expect(pages[0].children[0]).toMatchObject({ children: ['true'] });
  });

  it.each(['process', 'require', 'global', 'Buffer', 'fetch'])(
    'does not expose host %s through declarations',
    (name) => {
      const pages = evaluateSlide(`const value = typeof ${name}; <Slide><Text>{value}</Text></Slide>`);
      expect(pages[0].children[0]).toMatchObject({ children: ['undefined'] });
    },
  );

  it.each([
    '__h.constructor("return process")()',
    'globalThis.constructor.constructor("return process")()',
    'Function("return process")()',
    'eval("1 + 1")',
  ])('rejects dynamic compilation and constructor escape: %s', (expression) => {
    expect(() => evaluateSlide(`const value = ${expression}; <Slide><Text>{String(value)}</Text></Slide>`)).toThrow(
      /Code generation from strings disallowed/,
    );
  });

  it('enforces the same timeout across declarations and page evaluation', () => {
    expect(() => evaluateSlide('while(true) {} <Slide/>')).toThrow(/timed out/);
  }, 10000);

  it('bounds promise microtasks in the same evaluation budget', () => {
    expect(() => evaluateSlide('Promise.resolve().then(() => { while(true) {} }); <Slide/>')).toThrow(/timed out/);
  }, 10000);

  it('serializes getters inside the timeout instead of returning executable objects to the host', () => {
    expect(() => evaluateSlide('const style = { get color() { while(true) {} } }; <Slide style={style}/>')).toThrow(
      /timed out/,
    );
  }, 10000);
});
