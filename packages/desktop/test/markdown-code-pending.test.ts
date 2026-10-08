import { describe, expect, it } from 'vitest';
import { isPendingFencedCode } from '../src/renderer/lib/markdown-code-pending';

/**
 * 「未闭合围栏」判据的用例矩阵（Codex 审核 Task 6 补充要求的三类容器反例 + 围栏混用反例）。
 *
 * 函数接的是**解析器给出的节点位置**（hast position，基于原文偏移）；这些用例手工给出
 * 该代码节点在原文里的 start/end（与 remark 解析结果一致的常见形状），逐条钉住判据；
 * 真解析链上的接线由 `markdown-streaming-chrome.test.tsx` 覆盖。
 */
const at = (content: string, from: string): { start: number; end: number } => {
  const start = content.indexOf(from);
  return { start, end: content.length };
};

describe('isPendingFencedCode —— 顶层', () => {
  it('未闭合（贴到文档末尾、无闭合行）⇒ true', () => {
    const content = 'para\n```js\nconst a = 1';
    const { start, end } = at(content, '```js');
    expect(isPendingFencedCode(content, start, end)).toBe(true);
  });

  it('已闭合 ⇒ false', () => {
    const content = 'para\n```js\nconst a = 1\n```';
    const { start, end } = at(content, '```js');
    expect(isPendingFencedCode(content, start, end)).toBe(false);
  });

  it('闭合后还有内容（不贴边）⇒ false', () => {
    const content = '```js\nconst a = 1\n```\n后面还有字';
    const { start, end } = at(content, '```js');
    expect(isPendingFencedCode(content, start, end)).toBe(false);
  });
});

describe('isPendingFencedCode —— 围栏规则反例（计数法会错的三类）', () => {
  it('4 反引号开启、3 反引号闭合 ⇒ 未闭合（false 闭合假象必须被拒）', () => {
    const content = '````js\n代码里出现 ``` 三个也不能闭合\n```';
    const { start, end } = at(content, '````js');
    expect(isPendingFencedCode(content, start, end)).toBe(true);
  });

  it('``` 开启、~~~ 闭合 ⇒ 字符不同不算闭合', () => {
    const content = '```js\nconst a = 1\n~~~';
    const { start, end } = at(content, '```js');
    expect(isPendingFencedCode(content, start, end)).toBe(true);
  });

  it('4 反引号开启、内容含 3 反引号、4 反引号闭合 ⇒ 已闭合', () => {
    const content = '````js\n内容里有 ``` 短围栏\n````';
    const { start, end } = at(content, '````js');
    expect(isPendingFencedCode(content, start, end)).toBe(false);
  });

  it('缩进 4 空格的"围栏样"行不算闭合（>3 空格不是闭合行）', () => {
    const content = '```js\nconst a = 1\n    ```\nconst b = 2';
    const { start, end } = at(content, '```js');
    expect(isPendingFencedCode(content, start, end)).toBe(true);
  });

  it('缩进代码（无围栏）⇒ false（不是本判据的对象）', () => {
    const content = 'para\n\n    const a = 1';
    const { start, end } = at(content, '    const a = 1');
    expect(isPendingFencedCode(content, start, end)).toBe(false);
  });
});

describe('isPendingFencedCode —— 容器（引用 / 列表）', () => {
  it('引用内未闭合围栏（贴到末尾）⇒ true', () => {
    const content = '> ```js\n> const a = 1';
    const { start, end } = at(content, '```js');
    expect(isPendingFencedCode(content, start, end)).toBe(true);
  });

  it('引用内已闭合围栏 ⇒ false（闭合行带引用标记也要认出来）', () => {
    const content = '> ```js\n> const a = 1\n> ```';
    const { start, end } = at(content, '```js');
    expect(isPendingFencedCode(content, start, end)).toBe(false);
  });

  it('列表内未闭合围栏（贴到末尾）⇒ true', () => {
    const content = '- 步骤：\n  ```js\n  const a = 1';
    const { start, end } = at(content, '```js');
    expect(isPendingFencedCode(content, start, end)).toBe(true);
  });

  it('⭐ 容器结束后的缩进代码是"最后一个块"：它不是围栏 ⇒ false（不误套）', () => {
    const content = '- 步骤：\n  ```js\n  const a = 1\n  ```\n\n      const indented = 2';
    // 缩进代码节点（最后一个块）：从 '  const indented' 起（hast 会把它作为独立 pre）
    const start = content.indexOf('    const indented');
    expect(isPendingFencedCode(content, start, content.length)).toBe(false);
  });
});

describe('isPendingFencedCode —— 防御', () => {
  it('越界/逆序/NaN 一律 false', () => {
    expect(isPendingFencedCode('abc', -1, 3)).toBe(false);
    expect(isPendingFencedCode('abc', 2, 1)).toBe(false);
    expect(isPendingFencedCode('abc', Number.NaN, 3)).toBe(false);
    expect(isPendingFencedCode('abc', 1, 99)).toBe(false);
  });
});
