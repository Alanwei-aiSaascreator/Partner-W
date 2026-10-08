// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import '../src/renderer/i18n';
import MarkdownContent from '../src/renderer/components/MarkdownContent';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 流式正文的"镀铬件"（2026-10-08 对话可视化改造 · Task 6）：
 * ① 光标接真类 `.stream-cursor`（旧 `.animate-stream-cursor` 已定义为死代码，同时删掉）；
 * ② **未闭合代码块**由解析器源位置判定（`markdown-code-pending.ts`），标识打在实际那个
 *    代码块容器上（`data-code-pending`）——容器（引用/列表/多代码块）由解析器负责。
 */
function mount(ui: ReactElement): { container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => root.render(ui));
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

const pendingOf = (container: HTMLElement): Element[] =>
  Array.from(container.querySelectorAll('[data-code-pending="true"]'));

describe('MarkdownContent 流式镀铬件', () => {
  it('showCursor ⇒ 渲染 .stream-cursor；非流式不渲染', () => {
    const live = mount(<MarkdownContent content="正在写" showCursor />);
    expect(live.container.querySelector('.stream-cursor')).not.toBeNull();
    live.unmount();

    const settled = mount(<MarkdownContent content="写完了" />);
    expect(settled.container.querySelector('.stream-cursor')).toBeNull();
    settled.unmount();
  });

  it('未闭合围栏（流式）⇒ 该代码块容器带 data-code-pending；闭合后移除', () => {
    const open = mount(<MarkdownContent content={'先说一句\n```js\nconst a = 1'} showCursor />);
    const marks = pendingOf(open.container);
    expect(marks).toHaveLength(1);
    expect(marks[0]!.textContent).toContain('const a = 1');
    open.unmount();

    const closed = mount(<MarkdownContent content={'先说一句\n```js\nconst a = 1\n```'} showCursor />);
    expect(pendingOf(closed.container)).toHaveLength(0);
    closed.unmount();
  });

  it('非流式（定稿）不做占位 —— 半截代码不会留在界面上', () => {
    const view = mount(<MarkdownContent content={'```js\nconst a = 1'} />);
    expect(pendingOf(view.container)).toHaveLength(0);
    view.unmount();
  });

  it('引用内未闭合围栏也会被标出（容器由解析器负责）', () => {
    const view = mount(<MarkdownContent content={'> ```js\n> const a = 1'} showCursor />);
    expect(pendingOf(view.container)).toHaveLength(1);
    view.unmount();
  });

  it('⭐ 引用里多个代码块：只标最后一个未闭合的那一块', () => {
    const content = '> ```js\n> const a = 1\n> ```\n>\n> ```py\n> b = 2';
    const view = mount(<MarkdownContent content={content} showCursor />);
    const marks = pendingOf(view.container);
    expect(marks).toHaveLength(1);
    expect(marks[0]!.textContent).toContain('b = 2');
    view.unmount();
  });

  it('docgen 请求卡不套通用代码样式（即使围栏未闭合）', () => {
    const content = '```docgen\n{"kind":"pptx"';
    const view = mount(<MarkdownContent content={content} showCursor />);
    expect(view.container.querySelector('[data-testid="docgen-block"]')).not.toBeNull();
    expect(pendingOf(view.container)).toHaveLength(0);
    view.unmount();
  });
});
