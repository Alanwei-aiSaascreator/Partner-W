/**
 * 把 `.slide` 求值成元素树。
 *
 * ## ⚠️ 先读这一段：`node:vm` **不是安全边界**
 *
 * Node 官方文档明说 `vm` 不是安全机制，构造得出逃逸的代码。
 * 这里**仍然用它**，理由是输入侧的形状：这段代码是**我们自己的助手**在用户自己的会话里
 * 写出来的，目标产物是用户自己要的一份 PPT —— 与"执行用户上传的不可信脚本"不是一回事。
 * 换句话说：**这不是一道"防攻击者"的闸，是一道"别把正常路径炸掉"的闸。**
 *
 * 真正拦得住的是这三条，缺一不可：
 *
 * 1. **沙箱里没有宿主能力** —— 没有 `require` / `process` / `global` / `Buffer` / `fetch`，
 *    只有 `__h` 一个函数。拿不到 I/O，最多烧 CPU。
 * 2. **有超时** —— `while (true)` 会被 `timeout` 掐掉，不会把主进程挂死。
 * 3. **只求值一个表达式** —— 转换器产出的是 `__h(...)` 表达式，
 *    不是一段可执行脚本（`import` / 语句在语法上就不成立）。
 *
 * ⚠️ **不要**因为"vm 不安全"就把这三条拆了 —— 它们各自独立成立，
 *    合起来才是"即使 vm 被绕过，边界也还在"。
 */
import vm from 'node:vm';
import { SlideDslError, transformSlideJsx, type SlideChild, type SlideElement, type SlideTag } from './dsl.js';

/** 求值预算：正常一页是毫秒级；两秒是给"模型写了很蠢但不算恶意"的循环留的余量。 */
export const SLIDE_EVAL_TIMEOUT_MS = 2_000;

const TAGS: readonly SlideTag[] = ['Slide', 'Box', 'Text', 'Image'];

/** `__h` —— 转换器产出的调用全落到这里，就是一个**建树函数**。 */
function h(tag: unknown, props: Record<string, unknown> | null, ...children: SlideChild[]): SlideElement {
  if (typeof tag !== 'string' || !TAGS.includes(tag as SlideTag)) {
    throw new SlideDslError('dsl-unknown-tag', `unknown tag <${String(tag)}>`);
  }
  // 数组会被 `.map()` 展开成嵌套数组，这里压平；`null`/`undefined`/`false` 是条件渲染的产物，丢掉。
  const flat: SlideChild[] = [];
  const push = (c: SlideChild): void => {
    if (Array.isArray(c)) {
      for (const x of c) push(x as SlideChild);
      return;
    }
    if (c === null || c === undefined || c === false || c === true) return;
    flat.push(c);
  };
  for (const c of children) push(c);

  return { kind: 'element', tag: tag as SlideTag, props: props ?? {}, children: flat };
}

/**
 * 求值 `.slide` 源码，返回根元素。
 *
 * 失败一律抛 `SlideDslError` —— **绝不返回半个树**。
 * 半棵树的后果是产出一份"看起来像样、内容缺一块"的 PPT，比明确失败糟得多。
 */
export function evaluateSlide(source: string): SlideElement[] {
  const expression = transformSlideJsx(source);

  const sandbox: Record<string, unknown> = { __h: h };
  vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });

  let result: unknown;
  try {
    // 包一层括号：产出的是表达式，直接用表达式语句跑会丢掉返回值。
    result = vm.runInContext(`(${expression})`, sandbox, { timeout: SLIDE_EVAL_TIMEOUT_MS });
  } catch (error) {
    if (error instanceof SlideDslError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new SlideDslError('dsl-eval-failed', message);
  }

  // 守卫要收窄成**元素节点**，不是笼统的 SlideNode —— 否则下面读 `.tag` 编不过
  //（SlideNode 的另一支是 `{ kind: 'text'; value }`，没有 tag）。
  const isElement = (n: unknown): n is SlideElement =>
    Boolean(n) && typeof n === 'object' && (n as SlideElement).kind === 'element';
  const pages = (Array.isArray(result) ? result : [result]).filter(isElement);
  if (pages.length === 0) throw new SlideDslError('dsl-no-root', 'evaluation produced no <Slide> element');
  for (const p of pages) {
    if (p.tag !== 'Slide') throw new SlideDslError('dsl-no-root', `top level must be <Slide>, got <${p.tag}>`);
  }
  return pages;
}
