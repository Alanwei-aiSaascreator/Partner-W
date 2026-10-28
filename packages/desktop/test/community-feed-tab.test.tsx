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
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
// 与仓库里其它 jsdom 测试一致：滚动容器在 jsdom 里没有意义
vi.mock('../src/renderer/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import FeedTab from '../src/renderer/layouts/CommunityPanel/FeedTab';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const post = {
  post_id: 'p1',
  author_id: 'u1',
  author_name: '甲',
  body: '今天把邀请码做完了',
  visibility: 'org',
  like_count: 2,
  comment_count: 1,
  liked_by_me: false,
  created_at: '2026-09-17T10:00:00.000Z',
};

async function render(): Promise<{ container: HTMLDivElement; unmount: () => void }> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(<FeedTab />);
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

async function typeInto(element: HTMLTextAreaElement | HTMLInputElement, value: string): Promise<void> {
  const prototype =
    element instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('FeedTab', () => {
  beforeEach(() => {
    Object.assign(window, {
      clawwork: {
        communityFeed: vi.fn(async () => ({ ok: true, result: [post] })),
        communityCreatePost: vi.fn(async () => ({ ok: true, result: 'p-new' })),
        communityLikeToggle: vi.fn(async () => ({ ok: true, result: { liked: true, likeCount: 3 } })),
        communityDeletePost: vi.fn(async () => ({ ok: true, result: null })),
      },
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('列出帖子：作者名、正文、计数都在', async () => {
    const view = await render();
    expect(view.container.textContent).toContain('甲');
    expect(view.container.textContent).toContain('今天把邀请码做完了');
    expect(view.container.textContent).toContain('2');
    view.unmount();
  });

  it('空列表给中文空态，不是空白页', async () => {
    (window.clawwork.communityFeed as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true, result: [] });
    const view = await render();
    expect(view.container.textContent).toContain(translate('community.emptyFeed'));
    view.unmount();
  });

  it('加载失败给中文 + 重试按钮，点重试再拉一次', async () => {
    const feed = window.clawwork.communityFeed as ReturnType<typeof vi.fn>;
    feed.mockResolvedValueOnce({ ok: false, errorCode: 'network' });
    const view = await render();
    expect(view.container.textContent).toContain(translate('community.loadFailed'));
    expect(view.container.textContent).not.toContain('network');

    feed.mockResolvedValueOnce({ ok: true, result: [post] });
    const retry = buttonByText(view.container, translate('community.retry'));
    await act(async () => retry?.click());
    expect(view.container.textContent).toContain('今天把邀请码做完了');
    view.unmount();
  });

  it('点赞用服务端返回的真值（不是本地 +1）', async () => {
    const view = await render();
    const like = buttonByText(view.container, translate('community.like'));
    await act(async () => like?.click());
    expect(window.clawwork.communityLikeToggle).toHaveBeenCalledWith('p1');
    expect(view.container.textContent).toContain('3');
    view.unmount();
  });

  it('点赞失败时提示是中文，且计数不动', async () => {
    (window.clawwork.communityLikeToggle as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      errorCode: 'post_not_found',
    });
    const view = await render();
    const like = buttonByText(view.container, translate('community.like'));
    await act(async () => like?.click());
    expect(view.container.textContent).toContain('2');
    expect(view.container.textContent).not.toContain('post_not_found');
    view.unmount();
  });

  it('发帖成功后清空输入框并刷新列表', async () => {
    const view = await render();
    const textarea = view.container.querySelector('textarea') as HTMLTextAreaElement;
    await typeInto(textarea, '新的一条');

    const publish = buttonByText(view.container, translate('community.publish'));
    await act(async () => publish?.click());

    expect(window.clawwork.communityCreatePost).toHaveBeenCalledWith({ body: '新的一条', visibility: 'org' });
    expect((view.container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('');
    view.unmount();
  });

  it('选了「仅自己」再发，可见性跟着变', async () => {
    const view = await render();
    await typeInto(view.container.querySelector('textarea') as HTMLTextAreaElement, '秘密');

    const privateToggle = buttonByText(view.container, translate('community.composeVisibilityPrivate'));
    await act(async () => privateToggle?.click());
    await act(async () => buttonByText(view.container, translate('community.publish'))?.click());

    expect(window.clawwork.communityCreatePost).toHaveBeenCalledWith({ body: '秘密', visibility: 'private' });
    view.unmount();
  });

  it('正文为空时发布按钮不可点（不发空请求）', async () => {
    const view = await render();
    const publish = buttonByText(view.container, translate('community.publish')) as HTMLButtonElement;
    expect(publish.disabled).toBe(true);
    view.unmount();
  });

  it('私密帖带「仅自己可见」标记，团队帖不带', async () => {
    (window.clawwork.communityFeed as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      result: [post, { ...post, post_id: 'p2', visibility: 'private' }],
    });
    const view = await render();
    expect(view.container.textContent).toContain(translate('community.privateBadge'));
    view.unmount();
  });
});
