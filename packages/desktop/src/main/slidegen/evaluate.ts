import vm from 'node:vm';
import { isNativeError } from 'node:util/types';
import { SlideDslError, transformSlideJsx, type SlideElement } from './dsl.js';

export const SLIDE_EVAL_TIMEOUT_MS = 2_000;

const TREE_RUNTIME = String.raw`
const __sgRuntime = (() => {
  const pages = [];
  const serialize = JSON.stringify.bind(JSON);
  const fail = (code, message) => { throw Object.assign(new Error(message), { slideDslCode: code }); };
  const h = (tag, props, ...children) => {
    if (typeof tag === 'function') return tag({ ...(props || {}), children });
    if (!['Slide', 'Box', 'Text', 'Image'].includes(tag)) fail('dsl-unknown-tag', 'unknown element tag');
    const flat = [];
    const push = (child) => {
      if (Array.isArray(child)) { child.forEach(push); return; }
      if (child == null || typeof child === 'boolean') return;
      if (tag !== 'Text' && (typeof child === 'number' || (typeof child === 'string' && child.trim()))) {
        fail('dsl-text-outside-text', 'text expressions must be inside <Text>...</Text>');
      }
      flat.push(child);
    };
    children.forEach(push);
    return { kind: 'element', tag, props: props || {}, children: flat };
  };
  const collect = (evaluate, index) => {
    try {
      const push = (value) => {
        if (Array.isArray(value)) { value.forEach(push); return; }
        if (!value || typeof value !== 'object' || value.kind !== 'element') return;
        if (value.tag !== 'Slide') fail('dsl-no-root', 'top level must be <Slide>, got <' + value.tag + '>');
        pages.push(value);
      };
      push(evaluate());
    } catch (error) {
      if (error && error.slideDslCode) throw error;
      fail('dsl-eval-failed', 'expression ' + index + ': ' + String(error));
    }
  };
  const failure = (error) => {
    try {
      return serialize({ error: { code: error && error.slideDslCode || 'dsl-eval-failed', message: String(error) } });
    } catch {
      return '{"error":{"code":"dsl-eval-failed","message":"expression evaluation failed"}}';
    }
  };
  return Object.freeze({ h, collect, finish: () => serialize({ pages }), failure });
})();
const __h = __sgRuntime.h;
const __collect = __sgRuntime.collect;
`;

export function evaluateSlide(source: string): SlideElement[] {
  const program = transformSlideJsx(source);
  const sandbox = vm.createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false },
    microtaskMode: 'afterEvaluate',
  });
  let serialized: unknown;
  try {
    serialized = vm.runInContext(
      `(() => { ${TREE_RUNTIME}\ntry {\n${program}\nreturn __sgRuntime.finish();\n} catch (error) { return __sgRuntime.failure(error); } })()`,
      sandbox,
      { timeout: SLIDE_EVAL_TIMEOUT_MS, filename: 'slidegen-program.js' },
    );
  } catch (error) {
    throw new SlideDslError('dsl-eval-failed', isNativeError(error) ? error.message : 'evaluation failed');
  }
  if (typeof serialized !== 'string') {
    throw new SlideDslError('dsl-eval-failed', 'evaluation returned a non-string result');
  }
  const result = JSON.parse(serialized) as {
    pages?: SlideElement[];
    error?: { code: SlideDslError['code']; message: string };
  };
  if (result.error) throw new SlideDslError(result.error.code, result.error.message);
  if (!result.pages?.length) throw new SlideDslError('dsl-no-root', 'evaluation produced no <Slide> element');
  return result.pages;
}
