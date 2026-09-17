// @vitest-environment jsdom

import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import zh from '../src/renderer/i18n/locales/zh.json';

function translate(key: string, values?: Record<string, unknown>): string {
  let node: unknown = zh;
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null) return key;
    node = (node as Record<string, unknown>)[part];
  }
  if (typeof node !== 'string') return key;
  if (!values) return node;
  return node.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(values[name] ?? ''));
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate, i18n: { language: 'zh' } }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock('../src/renderer/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import MyTemplatesTab from '../src/renderer/layouts/MarketPanel/MyTemplatesTab';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const draftRow = {
  id: 't-draft',
  name: '我的草稿',
  description: '还没发布',
  category: 'office',
  emoji: '📊',
  instructions: '提示词',
  status: 'draft',
  install_count: 0,
  view_count: 3,
  created_at: '2026-09-17T00:00:00.000Z',
};

const publishedRow = {
  ...draftRow,
  id: 't-pub',
  name: '已发布的',
  status: 'published',
  install_count: 2,
};

async function render(): Promise<{ container: HTMLDivElement; unmount: () => void }> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(<MyTemplatesTab />);
  });
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement | null {
  return ([...container.querySelectorAll('button')].find((b) => b.textContent?.includes(text)) ??
    null) as HTMLButtonElement | null;
}

function cardOf(container: HTMLElement, name: string): HTMLElement | undefined {
  return [...container.querySelectorAll('[data-template]')].find((el) => el.textContent?.includes(name)) as
    | HTMLElement
    | undefined;
}

describe('MyTemplatesTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    Object.assign(window, {
      clawwork: {
        marketMyTemplates: vi.fn(async () => ({ ok: true, result: [draftRow, publishedRow] })),
        marketCreateTemplate: vi.fn(async () => ({ ok: true, result: { id: 'new' } })),
        marketUpdateTemplate: vi.fn(async () => ({ ok: true, result: null })),
        marketSetTemplateStatus: vi.fn(async () => ({ ok: true, result: null })),
        marketDeleteTemplate: vi.fn(async () => ({ ok: true, result: null })),
      },
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('列出我的模板：状态徽章 + 浏览/安装数', async () => {
    const view = await render();
    expect(view.container.textContent).toContain('我的草稿');
    expect(view.container.textContent).toContain(translate('market.statusDraft'));
    expect(view.container.textContent).toContain(translate('market.statusPublished'));
    expect(view.container.textContent).toContain('3'); // 浏览
    expect(view.container.textContent).toContain('2'); // 安装
    view.unmount();
  });

  it('新建：名字或提示词为空时按钮不可点', async () => {
    const view = await render();
    const create = buttonByText(view.container, translate('market.create')) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    view.unmount();
  });

  it('新建：填好后调用后端并刷新', async () => {
    const view = await render();
    const nameInput = view.container.querySelector('input[data-field="new-name"]') as HTMLInputElement;
    const promptInput = view.container.querySelector('textarea[data-field="new-instructions"]') as HTMLTextAreaElement;

    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(nameInput, '新模板');
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set?.call(
        promptInput,
        '你是助手。',
      );
      promptInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const create = buttonByText(view.container, translate('market.create')) as HTMLButtonElement;
    expect(create.disabled).toBe(false);
    await act(async () => create.click());

    expect(window.clawwork.marketCreateTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ name: '新模板', instructions: '你是助手。' }),
    );
    view.unmount();
  });

  it('草稿可以发布，已发布的可以下架', async () => {
    const view = await render();
    const draftCard = cardOf(view.container, '我的草稿')!;
    await act(async () => {
      buttonByText(draftCard, translate('market.publish'))!.click();
    });
    expect(window.clawwork.marketSetTemplateStatus).toHaveBeenCalledWith('t-draft', 'published');

    const pubCard = cardOf(view.container, '已发布的')!;
    await act(async () => {
      buttonByText(pubCard, translate('market.unpublish'))!.click();
    });
    expect(window.clawwork.marketSetTemplateStatus).toHaveBeenCalledWith('t-pub', 'archived');
    view.unmount();
  });

  it('⭐ 已经被安装过的模板：删除按钮禁用并说明原因', async () => {
    const view = await render();
    const pubCard = cardOf(view.container, '已发布的')!;
    const remove = pubCard.querySelector('button[data-action="delete"]') as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    expect(remove.getAttribute('title') ?? '').toContain(translate('market.deleteBlocked'));

    const draftCard = cardOf(view.container, '我的草稿')!;
    expect((draftCard.querySelector('button[data-action="delete"]') as HTMLButtonElement).disabled).toBe(false);
    view.unmount();
  });

  it('没被装过的可以删（确认后调用后端）', async () => {
    const view = await render();
    const draftCard = cardOf(view.container, '我的草稿')!;
    await act(async () => {
      (draftCard.querySelector('button[data-action="delete"]') as HTMLButtonElement).click();
    });
    expect(window.confirm).toHaveBeenCalled();
    expect(window.clawwork.marketDeleteTemplate).toHaveBeenCalledWith('t-draft');
    view.unmount();
  });

  it('编辑：保存调用 market:update', async () => {
    const view = await render();
    const draftCard = cardOf(view.container, '我的草稿')!;
    await act(async () => {
      buttonByText(draftCard, translate('market.edit'))!.click();
    });

    const nameInput = draftCard.querySelector('input[data-field="edit-name"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(nameInput, '改过的名字');
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      buttonByText(draftCard, translate('market.save'))!.click();
    });

    expect(window.clawwork.marketUpdateTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't-draft', name: '改过的名字' }),
    );
    view.unmount();
  });

  it('失败给中文提示，不出现机器码', async () => {
    (window.clawwork.marketMyTemplates as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      errorCode: 'network',
    });
    const view = await render();
    expect(view.container.textContent).toContain(translate('market.loadFailed'));
    expect(view.container.textContent).not.toContain('network');
    view.unmount();
  });
});
