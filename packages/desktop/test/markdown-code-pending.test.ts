import { describe, expect, it } from 'vitest';
import { isPendingFencedCode } from '../src/renderer/lib/markdown-code-pending';

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
