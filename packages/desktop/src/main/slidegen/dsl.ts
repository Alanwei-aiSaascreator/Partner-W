/**
 * `.slide` DSL —— **可执行 JSX**，不是静态标记语言。
 *
 * ## 为什么是"可执行"
 *
 * 对标产品（腾讯 WorkBuddy，内置 `@tencent/slidep`）的页面长这样：
 *
 * ```jsx
 * <Box style={{ flexDirection: 'row', gap: 20 }}>
 *   {[['01','业务全景','…'], ['02','落地逻辑','…']].map((it, i) => (
 *     <Box key={i} style={{ width: 548, borderRadius: 14 }}>
 *       <Text style={{ fontSize: 32 }}>{it[0]}</Text>
 *       <Text>{it[1]}</Text>
 *     </Box>
 *   ))}
 * </Box>
 * ```
 *
 * 列表靠 `.map()` 展开、文本靠 `{it[1]}` 插值 ⇒ **必须求值**。
 * 按字面量解析会把 `{it[0]}` 当普通文字（实测：那一页量出 2315px 高的文本框）。
 *
 * ## 为什么不用 esbuild
 *
 * 求值需要 JSX→JS 的转换。最省事的是 esbuild，但它**是原生二进制**、
 * **不在随包产物里**（已核实：`app.asar` 与 `app.asar.unpacked` 都没有），
 * 为它引入一个新的原生依赖要动打包配置 —— 那是本仓库记过坑的地方。
 *
 * ⇒ 所以这里**自己写转换**，但只做**一件事**：把标签结构改写成 `__h(...)` 调用。
 *    `{}` 里的 JS 本身**一个字符都不动**，原样交给 `vm` 里的 V8 去跑。
 *
 * ⚠️ **但 `{}` 里可以再嵌 JSX** —— `[...].map((it) => (<Box>…</Box>))` 就是。
 *    所以表达式内容**也要过一遍同一个扫描器**（`scanJsx`），否则 V8 会对着
 *    裸的 `<Box>` 报 `Unexpected token '<'`。实测：漏了这一步的版本
 *    **每一页凡有列表的都求值失败**，而列表正是这条通道最常用的写法。
 *
 * ## 失败形态
 *
 * 认不出来的一律**抛 `SlideDslError`**，由上层翻成给助手看的失败码 ——
 * **绝不猜**。猜错的后果是产出一份看起来像样、内容却是乱码的 PPT。
 */

export type SlideNode =
  | { kind: 'element'; tag: SlideTag; props: Record<string, unknown>; children: SlideChild[] }
  | { kind: 'text'; value: string };

export type SlideChild = SlideNode | string | number | boolean | null | undefined;

/**
 * **元素**节点（`SlideNode` 的另一支是纯文本）。
 *
 * ⚠️ 单独起这个名字是因为 `evaluateSlide` 只可能返回元素 ——
 *    用宽类型当返回类型，调用方每次读 `.tag` / `.children` 都得自己收窄一遍，
 *    而"它其实只可能是元素"这件事在这里说得清、在调用点说不清。
 */
export type SlideElement = Extract<SlideNode, { kind: 'element' }>;

export type SlideTag = 'Slide' | 'Box' | 'Text' | 'Image';

/** DSL 只认这四个标签。别的（含 HTML 标签）一律拒 —— 这是个封闭集合。 */
const TAGS: readonly SlideTag[] = ['Slide', 'Box', 'Text', 'Image'];

export class SlideDslError extends Error {
  constructor(
    readonly code: 'dsl-unparsable' | 'dsl-unknown-tag' | 'dsl-eval-failed' | 'dsl-no-root',
    message: string,
  ) {
    super(message);
    this.name = 'SlideDslError';
  }
}

const escapeJsString = (s: string): string => JSON.stringify(s);

/** `i` 处是不是一个**我们的**标签的开头（用来把 JSX 与 `a < b` 这种比较区分开）。 */
function tagAt(src: string, i: number): SlideTag | null {
  if (src[i] !== '<') return null;
  for (const tag of TAGS) {
    if (!src.startsWith('<' + tag, i)) continue;
    const after = src[i + 1 + tag.length];
    // 标签名后面必须是分隔符，免得把 `<TextBox>` 认成 `<Text>`
    if (after === undefined || /[\s/>]/.test(after)) return tag;
    // 闭合标签 `</Text>`
    if (src[i + 1] === '/') return tag;
  }
  return null;
}

/**
 * 从 `i`（指向 `{`）读到一个**配平**的 `}`。
 *
 * ⚠️ 必须认字符串 / 模板串 / 注释 —— 否则 `{ 'a}b' }` 这种会提前收尾。
 *    模板串里的 `${ … }` 还要递归数括号。
 * ⚠️ 其中的 JSX 会被**就地转换**（见文件头那段）。
 */
function readBraced(src: string, i: number): { body: string; end: number } {
  if (src[i] !== '{') throw new SlideDslError('dsl-unparsable', `expected { at ${i}`);
  let depth = 0;
  let j = i;
  while (j < src.length) {
    const c = src[j];
    if (c === '"' || c === "'") {
      j += 1;
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') j += 1;
        j += 1;
      }
    } else if (c === '`') {
      j += 1;
      while (j < src.length && src[j] !== '`') {
        if (src[j] === '\\') {
          j += 1;
        } else if (src[j] === '$' && src[j + 1] === '{') {
          // 模板串里的 `${}` 只数括号，不做 JSX 转换（那里极少嵌 JSX）
          const inner = readRawBraced(src, j + 1);
          j = inner.end;
        }
        j += 1;
      }
    } else if (c === '/' && src[j + 1] === '/') {
      while (j < src.length && src[j] !== '\n') j += 1;
    } else if (c === '/' && src[j + 1] === '*') {
      const close = src.indexOf('*/', j + 2);
      j = close < 0 ? src.length : close + 1;
    } else if (c === '{') {
      depth += 1;
    } else if (c === '}') {
      depth -= 1;
      if (depth === 0) {
        // ⭐ 表达式里的 JSX 在这里被转换掉 —— 漏了这步，列表页全废。
        return { body: scanJsx(src.slice(i + 1, j)), end: j };
      }
    }
    j += 1;
  }
  throw new SlideDslError('dsl-unparsable', 'unbalanced { in expression');
}

/** 只数括号、不做 JSX 转换的版本（模板串 `${}` 用）。 */
function readRawBraced(src: string, i: number): { end: number } {
  let depth = 0;
  let j = i;
  while (j < src.length) {
    const c = src[j];
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      j += 1;
      while (j < src.length && src[j] !== q) {
        if (src[j] === '\\') j += 1;
        j += 1;
      }
    } else if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return { end: j };
    }
    j += 1;
  }
  throw new SlideDslError('dsl-unparsable', 'unbalanced { in template literal');
}

/**
 * 扫描一段 JS：把其中的 JSX 元素换成 `__h(...)`，其余**原样保留**。
 *
 * 这是整个转换器的核心，被两处调用：
 *  - 顶层（整个 `.slide` 源码）
 *  - `{}` 内部（表达式里的 JSX）
 */
function scanJsx(src: string, opts: { strict?: boolean; collect?: string[] } = {}): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    // 注释原样带过
    if (src.startsWith('//', i)) {
      const nl = src.indexOf('\n', i);
      out += nl < 0 ? src.slice(i) : src.slice(i, nl);
      i = nl < 0 ? src.length : nl;
      continue;
    }
    if (src.startsWith('/*', i)) {
      const close = src.indexOf('*/', i + 2);
      const end = close < 0 ? src.length : close + 2;
      out += src.slice(i, end);
      i = end;
      continue;
    }
    // 字符串字面量原样带过（`"<Box>"` 不是标签）
    if (src[i] === '"' || src[i] === "'") {
      const q = src[i]!;
      let j = i + 1;
      while (j < src.length && src[j] !== q) {
        if (src[j] === '\\') j += 1;
        j += 1;
      }
      out += src.slice(i, Math.min(j + 1, src.length));
      i = Math.min(j + 1, src.length);
      continue;
    }
    const tag = tagAt(src, i);
    if (tag) {
      // ⚠️ 闭合标签由 parseElement 自己消费，走到这里说明是**开标签**
      if (src[i + 1] === '/') throw new SlideDslError('dsl-unparsable', 'stray closing tag');
      const { code, end } = parseElement(src, i, opts.strict);
      if (opts.collect) opts.collect.push(code);
      else out += code;
      i = end;
      continue;
    }
    // ⭐ **严格模式**：看着像标签却不是我们那四个 ⇒ 拒。
    //    这是在"版面位置"（顶层 / 子节点）才成立的判据 —— 那几个位置出现 `<div>`
    //    一定是助手写错了，放过它只会产出半份版面。
    //    ⚠️ `{}` 表达式里**不能**严格：`{a < b}` 是合法的 JS，误伤它会让正常版面被拒。
    if (opts.strict && looksLikeTag(src, i)) {
      throw new SlideDslError('dsl-unknown-tag', `unknown tag <${readTagName(src, i)}>`);
    }
    out += src[i];
    i += 1;
  }
  return out;
}

/** `i` 处像不像一个标签（`<Name` 且 Name 是标识符、紧跟分隔符）。 */
function looksLikeTag(src: string, i: number): boolean {
  if (src[i] !== '<') return false;
  return /^<\/?[A-Za-z][A-Za-z0-9]*[\s/>]/.test(src.slice(i, i + 40));
}

/** 取出标签名（只用于报错信息）。 */
function readTagName(src: string, i: number): string {
  return (/^<\/?([A-Za-z][A-Za-z0-9]*)/.exec(src.slice(i, i + 40)) ?? [])[1] ?? '?';
}

/** 解析一个元素（`i` 指向 `<`），返回它的 `__h(...)` 代码与结束位置。 */
function parseElement(src: string, i: number, strict = false): { code: string; end: number } {
  const tag = tagAt(src, i);
  if (!tag) throw new SlideDslError('dsl-unknown-tag', 'not a slidegen tag');
  let j = i + 1 + tag.length;

  const attrs: string[] = [];
  for (;;) {
    while (j < src.length && /\s/.test(src[j] ?? '')) j += 1;
    if (src[j] === '/' && src[j + 1] === '>') {
      return { code: `__h(${escapeJsString(tag)}, {${attrs.join(',')}})`, end: j + 2 };
    }
    if (src[j] === '>') {
      j += 1;
      break;
    }
    if (j >= src.length) throw new SlideDslError('dsl-unparsable', `<${tag}> not closed`);

    let attr = '';
    while (j < src.length && /[A-Za-z0-9_$:-]/.test(src[j] ?? '')) {
      attr += src[j];
      j += 1;
    }
    while (j < src.length && /\s/.test(src[j] ?? '')) j += 1;
    if (src[j] === '=') {
      j += 1;
      while (j < src.length && /\s/.test(src[j] ?? '')) j += 1;
      if (src[j] === '{') {
        const { body, end } = readBraced(src, j);
        attrs.push(`${escapeJsString(attr)}: (${body})`);
        j = end + 1;
      } else if (src[j] === '"' || src[j] === "'") {
        const quote = src[j]!;
        const start = j + 1;
        j += 1;
        while (j < src.length && src[j] !== quote) j += 1;
        attrs.push(`${escapeJsString(attr)}: ${escapeJsString(src.slice(start, j))}`);
        j += 1;
      } else {
        throw new SlideDslError('dsl-unparsable', `attribute ${attr} has no value`);
      }
    } else {
      attrs.push(`${escapeJsString(attr)}: true`);
    }
  }

  const kids: string[] = [];
  for (;;) {
    if (j >= src.length) throw new SlideDslError('dsl-unparsable', `</${tag}> missing`);
    if (src[j] === '<' && src[j + 1] === '/') {
      const close = src.indexOf('>', j);
      if (close < 0) throw new SlideDslError('dsl-unparsable', `</${tag}> not closed`);
      j = close + 1;
      break;
    }
    if (tagAt(src, j)) {
      const inner = parseElement(src, j, strict);
      kids.push(inner.code);
      j = inner.end;
      continue;
    }
    // 子节点位置同样严格：`<div>` 这种必须拒，不能当文字吞掉。
    if (strict && looksLikeTag(src, j)) {
      throw new SlideDslError('dsl-unknown-tag', `unknown tag <${readTagName(src, j)}>`);
    }
    if (src[j] === '{') {
      const { body, end } = readBraced(src, j);
      kids.push(`(${body})`); // 里面的 JS 原样（JSX 已在 readBraced 里转好）
      j = end + 1;
      continue;
    }
    let text = '';
    while (j < src.length && src[j] !== '<' && src[j] !== '{') {
      text += src[j];
      j += 1;
    }
    if (text.trim()) kids.push(escapeJsString(text.trim()));
  }

  return { code: `__h(${escapeJsString(tag)}, {${attrs.join(',')}}, ${kids.join(',')})`, end: j };
}

/**
 * JSX → JS 表达式字符串（`__h(...)` 调用）。
 *
 * ⭐ **顶层可以并列多个 `<Slide>`** —— 那就是多页。一栅写 24 页比写 24 个围栏
 * 既短又不容易漏；单页时不必包数组。
 */
export function transformSlideJsx(src: string): string {
  const roots: string[] = [];
  // ⚠️ 顶层**只收根元素**（`collect`）—— 早先的写法是"转完整串再按 `;` 切"，
  //    而相邻两个根之间**没有分隔符**，切分正则永远匹配不上（多页直接语法错）。
  scanJsx(src, { strict: true, collect: roots });
  if (roots.length === 0) throw new SlideDslError('dsl-no-root', 'no <Slide> element found');
  return roots.length === 1 ? roots[0]! : `[${roots.join(',')}]`;
}
