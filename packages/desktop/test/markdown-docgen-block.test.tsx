// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

import MarkdownContent from '../src/renderer/components/MarkdownContent';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render(ui: ReactElement): { container: HTMLDivElement; unmount: () => void } {
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

const DECK_JSON = JSON.stringify(
  { kind: 'pptx', title: '内测汇报', slides: [{ title: '本周进展', bullets: ['方案已出'] }] },
  null,
  2,
);

/**
 * `docgen` 块在聊天区**不该显示成一段 JSON**。
 *
 * 它是"请生成一份演示文稿"的请求（schema 见 `main/docgen/request.ts`）：
 * 把原始 JSON 摊给用户看既是噪音、又像是在请他去编辑它。
 * 真正的东西是客户端渲染出来的 .pptx，出现在右侧「产物」里。
 */
describe('MarkdownContent 对 docgen 块的处理', () => {
  it('⭐ docgen 块渲染成一行卡片，**不含**原始 JSON', () => {
    const { container, unmount } = render(<MarkdownContent content={['```docgen', DECK_JSON, '```'].join('\n')} />);

    expect(container.querySelector('[data-testid="docgen-block"]')).not.toBeNull();
    // ⚠️ DOCX-205 §5.C：静态承诺换成**状态文案**；无 task/message（未挂到具体轮次）⇒ 待处理。
    expect(container.textContent, '卡片文案').toContain('chatMessage.docgenPending');
    expect(container.textContent, '不该把 JSON 摊出来').not.toContain('"kind"');
    expect(container.textContent).not.toContain('内测汇报');
    unmount();
  });

  it('大小写不敏感（模型会写 ```Docgen ）', () => {
    const { container, unmount } = render(<MarkdownContent content={['```Docgen', DECK_JSON, '```'].join('\n')} />);
    expect(container.querySelector('[data-testid="docgen-block"]')).not.toBeNull();
    unmount();
  });

  it('普通代码块照旧渲染成代码（别把别的块也吞了）', () => {
    const content = ['```ts', 'const a = 1;', '```'].join('\n');
    const { container, unmount } = render(<MarkdownContent content={content} />);

    expect(container.querySelector('[data-testid="docgen-block"]')).toBeNull();
    expect(container.textContent).toContain('const a = 1;');
    unmount();
  });

  it('json 块**不**走卡片（只有 docgen 是那个请求；普通 JSON 是用户要看的）', () => {
    const { container, unmount } = render(<MarkdownContent content={['```json', DECK_JSON, '```'].join('\n')} />);

    expect(container.querySelector('[data-testid="docgen-block"]')).toBeNull();
    expect(container.textContent).toContain('内测汇报');
    unmount();
  });
});

const PAGE_JSON = JSON.stringify(
  {
    kind: 'html',
    template: 'brief',
    title: '九月简报',
    sections: [{ kind: 'summary', heading: '结论', paragraphs: ['环比 +12%'] }],
  },
  null,
  2,
);

/**
 * ⭐ `htmlgen` 曾经**漏了这张特判** —— 于是它渲染成一段普通 JSON 代码块，
 * 而代码块是带**复制按钮**的。
 *
 * 对用户来说那就是"这功能不存在，你自己复制吧"。2026-09-27 真机反馈的原话：
 * 「生产 html 文件生产不了，让自己去复制自己做，那要你有何用」——
 * 他看到的正是这个 JSON 块 + 复制按钮。（那条通道本身是通的。）
 *
 * ⇒ **每加一条 fence 通道，都必须在这个 `pre` 处理器里加分支**，否则新通道
 *    在用户侧等于不存在，而且看起来像"产品做不到"。
 */
describe('MarkdownContent 对 htmlgen 块的处理', () => {
  it('⭐ htmlgen 块渲染成一行卡片，**不含**原始 JSON', () => {
    const { container, unmount } = render(<MarkdownContent content={['```htmlgen', PAGE_JSON, '```'].join('\n')} />);

    expect(container.querySelector('[data-testid="htmlgen-block"]')).not.toBeNull();
    // ⚠️ DOCX-205 §5.C：同上 —— 状态文案（无轮次上下文 ⇒ 待处理）。
    expect(container.textContent, '卡片文案').toContain('chatMessage.htmlgenPending');
    expect(container.textContent, '不该把 JSON 摊出来').not.toContain('"kind"');
    expect(container.textContent).not.toContain('九月简报');
    unmount();
  });

  it('⭐ 不许掉进代码块那条路（那条路挂着复制按钮 —— 正是"让你自己复制"）', () => {
    const { container, unmount } = render(<MarkdownContent content={['```htmlgen', PAGE_JSON, '```'].join('\n')} />);

    // 代码块外面是 `<div className="group/code …">`，复制/保存按钮挂在它里面。
    // 命中它就说明我们落到了"普通代码块"分支。
    expect(
      container.querySelector('[class*="group/code"]'),
      'htmlgen 掉进了代码块分支 ⇒ 用户会看到一个复制按钮',
    ).toBeNull();
    unmount();
  });

  it('大小写不敏感（模型会写 ```HtmlGen ）', () => {
    const { container, unmount } = render(<MarkdownContent content={['```HtmlGen', PAGE_JSON, '```'].join('\n')} />);
    expect(container.querySelector('[data-testid="htmlgen-block"]')).not.toBeNull();
    unmount();
  });

  it('两条通道各自成卡，不互相吞', () => {
    const content = ['```docgen', DECK_JSON, '```', '', '```htmlgen', PAGE_JSON, '```'].join('\n');
    const { container, unmount } = render(<MarkdownContent content={content} />);

    expect(container.querySelector('[data-testid="docgen-block"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="htmlgen-block"]')).not.toBeNull();
    unmount();
  });

  it('json 块**不**走 htmlgen 卡片（普通 JSON 是用户要看的）', () => {
    const { container, unmount } = render(<MarkdownContent content={['```json', PAGE_JSON, '```'].join('\n')} />);

    expect(container.querySelector('[data-testid="htmlgen-block"]')).toBeNull();
    expect(container.textContent).toContain('九月简报');
    unmount();
  });
});
