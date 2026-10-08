// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import i18n from '../src/renderer/i18n';
import ThinkingCollapse from '../src/renderer/components/ThinkingCollapse';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 思考折叠（2026-10-08 对话可视化改造 · Task 2）。
 *
 * 语义（Codex 审核定稿）：
 * - 标题是**静态**「深度思考」（真实 WorkBuddy 的 `reasoning.title`；不再报"思考了约 N 秒"——
 *   没有可靠测量源就不报秒数）；
 * - `phase='live'`（最新活动=思考）⇒ 自动展开 + 扫光；`done` ⇒ 自动收起 + 停动画；
 * - **尊重用户手动折叠**：同一段里的新 delta 不强行展开；`segment`（core 的思考段号）
 *   变化（工具之后再次思考 ⇒ 新一段）才复位；
 * - 定稿惰性挂载：首次展开前正文不进 DOM（长 CoT 性能；测试按"展开可见"的新语义钉）。
 */
function mount(ui: ReactElement): {
  container: HTMLDivElement;
  rerender: (next: ReactElement) => void;
  unmount: () => void;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => root.render(ui));
  return {
    container,
    rerender: (next) => act(() => root.render(next)),
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

const TEXT = '先看目录，再读入口文件。';

describe('ThinkingCollapse', () => {
  it('live：展开可见、标题为静态「深度思考」且扫光', () => {
    const view = mount(<ThinkingCollapse text={TEXT} phase="live" segment={1} />);
    const root = view.container.querySelector('[data-testid="thinking-collapse"]')!;
    expect(root.className).toContain('thinking-collapse--live');
    expect(root.className).toContain('thinking-collapse--expanded');
    const title = root.querySelector('.thinking-collapse__title')!;
    expect(title.textContent).toBe(i18n.t('chatMessage.thinking.title'));
    expect(title.className).toContain('text-shimmer');
    expect(view.container.textContent).toContain(TEXT);
    view.unmount();
  });

  it('done（同一实例从 live 翻转）：自动收起、停扫光；已挂载的正文保留在 DOM（供收起动画）', () => {
    const view = mount(<ThinkingCollapse text={TEXT} phase="live" segment={1} />);
    view.rerender(<ThinkingCollapse text={TEXT} phase="done" segment={1} />);
    const root = view.container.querySelector('[data-testid="thinking-collapse"]')!;
    expect(root.className).toContain('thinking-collapse--done');
    expect(root.className).toContain('thinking-collapse--collapsed');
    expect(root.querySelector('.thinking-collapse__title')!.className).not.toContain('text-shimmer');
    view.unmount();
  });

  it('定稿直接挂载（历史消息）：正文惰性——展开前不进 DOM，展开后可见，aria-expanded 往返', () => {
    const view = mount(<ThinkingCollapse text={TEXT} phase="done" segment={1} />);
    expect(view.container.querySelector('.thinking-collapse__body')).toBeNull();
    expect(view.container.textContent).not.toContain(TEXT);

    const header = view.container.querySelector('[data-testid="thinking-collapse-header"]')!;
    expect(header.getAttribute('aria-expanded')).toBe('false');
    click(header);
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(view.container.querySelector('.thinking-collapse__body')?.textContent).toBe(TEXT);

    click(header);
    expect(header.getAttribute('aria-expanded')).toBe('false');
    view.unmount();
  });

  it('⭐ 同段尊重手动折叠：用户收起后，同段新 delta 不强行展开', () => {
    const view = mount(<ThinkingCollapse text={TEXT} phase="live" segment={1} />);
    const header = view.container.querySelector('[data-testid="thinking-collapse-header"]')!;
    click(header); // 用户手动收起
    let root = view.container.querySelector('[data-testid="thinking-collapse"]')!;
    expect(root.className).toContain('thinking-collapse--collapsed');

    view.rerender(<ThinkingCollapse text={`${TEXT}\n又想了半句`} phase="live" segment={1} />);
    root = view.container.querySelector('[data-testid="thinking-collapse"]')!;
    expect(root.className, '同一段里的新 delta 不得强行展开').toContain('thinking-collapse--collapsed');
    view.unmount();
  });

  it('⭐ 新段复位：segment 变化（工具后再次思考）⇒ 自动重新展开', () => {
    const view = mount(<ThinkingCollapse text={TEXT} phase="live" segment={1} />);
    const header = view.container.querySelector('[data-testid="thinking-collapse-header"]')!;
    click(header);
    expect(view.container.querySelector('[data-testid="thinking-collapse"]')!.className).toContain(
      'thinking-collapse--collapsed',
    );

    view.rerender(<ThinkingCollapse text={`${TEXT}\n第二段：换个思路`} phase="live" segment={2} />);
    expect(view.container.querySelector('[data-testid="thinking-collapse"]')!.className).toContain(
      'thinking-collapse--expanded',
    );
    view.unmount();
  });

  it('⭐ done→live（工具之后再次思考）：自动重新展开', () => {
    const view = mount(<ThinkingCollapse text={TEXT} phase="done" segment={1} />);
    expect(view.container.querySelector('[data-testid="thinking-collapse"]')!.className).toContain(
      'thinking-collapse--collapsed',
    );
    view.rerender(<ThinkingCollapse text={`${TEXT}\n再想`} phase="live" segment={2} />);
    const root = view.container.querySelector('[data-testid="thinking-collapse"]')!;
    expect(root.className).toContain('thinking-collapse--expanded');
    expect(root.className).toContain('thinking-collapse--live');
    view.unmount();
  });

  it('空文本不渲染', () => {
    const view = mount(<ThinkingCollapse text="   " phase="live" segment={1} />);
    expect(view.container.querySelector('[data-testid="thinking-collapse"]')).toBeNull();
    view.unmount();
  });
});
