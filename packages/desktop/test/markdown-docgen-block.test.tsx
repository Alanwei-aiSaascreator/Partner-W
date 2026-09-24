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
    expect(container.textContent, '卡片文案').toContain('chatMessage.docgenBlock');
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
