import { describe, expect, it } from 'vitest';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { isPendingFencedCode, pendingFencedCodeStarts } from '../src/renderer/lib/markdown-code-pending';

/**
 * 「未闭合围栏」判据（Task 6 / R7 重写为**行数对齐**）。
 *
 * 函数吃的是**解析器给出的**节点跨度（hast position offsets，基于原文）与**代码正文**
 * （容器前缀已被解析器剥掉）。用例按简单文档手工给出与 remark 解析一致的偏移与正文；
 * 真解析链上的接线由 `markdown-streaming-chrome.test.tsx` 覆盖（含总审的两个反例）。
 */
const at = (content: string, from: string): { start: number; end: number } => ({
  start: content.indexOf(from),
  end: content.length,
});

describe('isPendingFencedCode —— 顶层', () => {
  it('未闭合（贴到文档末尾、无闭合行）⇒ true', () => {
    const content = 'para\n```js\nconst a = 1';
    const { start, end } = at(content, '```js');
    expect(isPendingFencedCode(content, start, end, 'const a = 1')).toBe(true);
  });

  it('已闭合 ⇒ false', () => {
    const content = 'para\n```js\nconst a = 1\n```';
    const { start, end } = at(content, '```js');
    expect(isPendingFencedCode(content, start, end, 'const a = 1')).toBe(false);
  });

  it('闭合后还有内容（不贴边）⇒ false', () => {
    const content = '```js\nconst a = 1\n```\n后面还有字';
    const { start, end } = at(content, '```js');
    expect(isPendingFencedCode(content, start, end, 'const a = 1')).toBe(false);
  });

  it('只有开启行（还什么都没写）⇒ true', () => {
    const content = 'para\n```js';
    const { start, end } = at(content, '```js');
    expect(isPendingFencedCode(content, start, end, '')).toBe(true);
  });
});

describe('isPendingFencedCode —— 围栏规则反例（计数法会错的三类）', () => {
  it('4 反引号开启、3 反引号结尾 ⇒ 未闭合（3 个闭合不了 4 个）', () => {
    const content = '````js\n内容里有 ``` 短围栏\n```';
    const { start, end } = at(content, '````js');
    expect(isPendingFencedCode(content, start, end, '内容里有 ``` 短围栏\n```')).toBe(true);
  });

  it('``` 开启、~~~ 结尾 ⇒ 未闭合（字符不同）', () => {
    const content = '```js\nconst a = 1\n~~~';
    const { start, end } = at(content, '```js');
    expect(isPendingFencedCode(content, start, end, 'const a = 1\n~~~')).toBe(true);
  });

  it('4 反引号开启、内容含 3 反引号、4 反引号闭合 ⇒ 已闭合', () => {
    const content = '````js\n内容里有 ``` 短围栏\n````';
    const { start, end } = at(content, '````js');
    expect(isPendingFencedCode(content, start, end, '内容里有 ``` 短围栏')).toBe(false);
  });

  it('缩进代码（无围栏）⇒ false（不是本判据的对象）', () => {
    const content = 'para\n\n    const a = 1';
    const { start, end } = at(content, '    const a = 1');
    expect(isPendingFencedCode(content, start, end, 'const a = 1')).toBe(false);
  });
});

describe('isPendingFencedCode —— 容器反例（R7 总审实跑的两个）', () => {
  it('反例 A：有序列表里**已闭合**的代码块（闭合行带 4 空格缩进）⇒ false', () => {
    const content = '1. item\n\n    ```js\n    const x=1;\n    ```';
    const { start, end } = at(content, '```js');
    // 解析器给出的 codeText 不含容器缩进（这里是 'const x=1;'）
    expect(isPendingFencedCode(content, start, end, 'const x=1;')).toBe(false);
  });

  it('反例 B：**根级**代码正文里的字面量 `> ``` `（不是容器）⇒ 仍判未闭合', () => {
    const content = '```txt\n> ```\nmore';
    const { start, end } = at(content, '```txt');
    // 该围栏在**根级**：闭合行必须是"裸反引号"（可带 ≤3 空格），"> ```" 带 "> " 前缀
    // ⇒ 解析器把它当**代码内容**原样保留（旧实现无条件剥 "> " 会把它错当闭合符）。
    expect(isPendingFencedCode(content, start, end, '> ```\nmore')).toBe(true);
  });

  it('引用容器内未闭合 ⇒ true（行数对齐，不靠剥标记）', () => {
    const content = '> ```js\n> const a = 1';
    const { start, end } = at(content, '```js');
    expect(isPendingFencedCode(content, start, end, 'const a = 1')).toBe(true);
  });

  it('引用容器内已闭合 ⇒ false', () => {
    const content = '> ```js\n> const a = 1\n> ```';
    const { start, end } = at(content, '```js');
    expect(isPendingFencedCode(content, start, end, 'const a = 1')).toBe(false);
  });

  it('⭐ F2：引用内未闭合 + **容器空尾行**（`> `）⇒ 仍判未闭合（尾行不是"块后内容"）', () => {
    const content = '> ```js\n> const a = 1\n> ';
    // 解析器的 code.end.offset 会落在容器空尾行之前（22 = 内容行结束处）
    expect(isPendingFencedCode(content, 2, 22, 'const a = 1')).toBe(true);
  });

  it('⭐ F2：嵌套引用的容器空尾行 ⇒ 同样不误判', () => {
    const content = '> > ```js\n> > const a = 1\n> > ';
    // 解析器的 code.end.offset 落在"内容行之后、容器空尾行之前"（= 尾行起点）
    expect(isPendingFencedCode(content, 4, content.lastIndexOf('> > '), 'const a = 1')).toBe(true);
  });

  it('F2：继续写入（空行后还有真内容）⇒ 未闭合保持', () => {
    const content = '> ```js\n> const a = 1\n> \n> more';
    const { start, end } = at(content, '```js');
    expect(isPendingFencedCode(content, start, end, 'const a = 1\n\nmore')).toBe(true);
  });

  it('F2：真闭合后跟容器空尾行 ⇒ 已闭合（线数法照常生效）', () => {
    const content = '> ```js\n> const a = 1\n> ```\n> ';
    // 闭合围栏结束处的 end（其后只剩容器空尾行）
    const end = content.indexOf('> \n> ', 2) + 3;
    expect(isPendingFencedCode(content, 2, end, 'const a = 1')).toBe(false);
  });
});

describe('isPendingFencedCode —— 防御', () => {
  it('越界/逆序/NaN 一律 false', () => {
    expect(isPendingFencedCode('abc', -1, 3, '')).toBe(false);
    expect(isPendingFencedCode('abc', 2, 1, '')).toBe(false);
    expect(isPendingFencedCode('abc', Number.NaN, 3, '')).toBe(false);
    expect(isPendingFencedCode('abc', 1, 99, '')).toBe(false);
  });
});

/**
 * G2 回归（2026-10-08 集中终审 · P2 必修）：**行数启发式换真实解析器 token**。
 *
 * 旧判据（"原文行数对齐"）在三个形状上失守（同一根因）：引用/嵌套引用的**两行及以上
 * 容器空尾**再次误判；**纯 CR 换行**下已闭合围栏也误判。权威矩阵 44 场景
 * （root/quote/nested-quote/ordered-list × 空尾 0–4 行 × 开/闭 + 四个对照）。
 *
 * ⚠️ 按合同要求：**不用手工捏造的 AST offset**，每个场景都用 `mdast-util-from-markdown`
 * 的真实解析结果取节点跨度与正文。
 */
type MdNode = {
  type: string;
  value?: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MdNode[];
};

function lastCodeNode(source: string): MdNode | undefined {
  const walk = (node: MdNode): MdNode[] => [
    ...(node.type === 'code' ? [node] : []),
    ...(node.children ?? []).flatMap((child) => walk(child)),
  ];
  return walk(fromMarkdown(source) as unknown as MdNode).at(-1);
}

const MATRIX: Array<{ name: string; source: string; expected: boolean }> = [];
for (const spec of [
  { name: 'root', prefix: '', head: '' },
  { name: 'quote', prefix: '> ', head: '' },
  { name: 'nested-quote', prefix: '> > ', head: '' },
  { name: 'ordered-list', prefix: '    ', head: '1. item\n\n' },
]) {
  for (let blanks = 0; blanks <= 4; blanks += 1) {
    for (const closed of [false, true]) {
      const lines = ['```js', 'const a = 1', ...(closed ? ['```'] : []), ...Array(blanks).fill('')];
      MATRIX.push({
        name: `${spec.name}-${closed ? 'closed' : 'open'}-blanks-${blanks}`,
        source: spec.head + lines.map((line) => spec.prefix + line).join('\n'),
        expected: !closed,
      });
    }
  }
}
MATRIX.push(
  { name: 'literal-quote-fence-in-root-code', source: '```txt\n> ```\nmore', expected: true },
  { name: 'short-close', source: '````js\na\n```', expected: true },
  { name: 'mixed-character-close', source: '```js\na\n~~~', expected: true },
  { name: 'pure-CR-closed', source: '```js\ra\r```', expected: false },
);

describe('G2：真实解析器矩阵（44 场景；跨度与正文全部来自 mdast）', () => {
  it.each(MATRIX.map((test) => [test.name, test.source, test.expected] as const))('%s', (_name, source, expected) => {
    const node = lastCodeNode(source);
    const start = node?.position?.start.offset;
    const end = node?.position?.end.offset;
    const actual =
      typeof start === 'number' && typeof end === 'number'
        ? isPendingFencedCode(source, start, end, node?.value ?? '')
        : false;
    expect(actual).toBe(expected);
  });
});

describe('G2：pendingFencedCodeStarts（生产出口）', () => {
  it('引用空尾 4 行 ⇒ 仍是未闭合（围栏起点在集合里）', () => {
    const source = '> ```js\n> const a = 1\n> \n> \n> \n> ';
    expect([...pendingFencedCodeStarts(source)]).toEqual([2]);
  });

  it('嵌套引用空尾 3 行 ⇒ 仍是未闭合', () => {
    const source = '> > ```js\n> > const a = 1\n> > \n> > \n> > ';
    expect([...pendingFencedCodeStarts(source)]).toEqual([4]);
  });

  it('纯 CR 换行、已闭合 ⇒ 空集', () => {
    expect([...pendingFencedCodeStarts('```js\ra\r```')]).toEqual([]);
  });

  it('闭合 + 尾部还有正文 ⇒ 空集（最后一块不是它）', () => {
    expect([...pendingFencedCodeStarts('```js\na\n```\n尾部正文')]).toEqual([]);
  });
});
