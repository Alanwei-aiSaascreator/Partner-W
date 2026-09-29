// @vitest-environment jsdom

import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import zh from '../src/renderer/i18n/locales/zh.json';
import { toast } from 'sonner';

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

// 安装编排单独测过（template-install.test.ts），这里只验证界面接线
// ⚠️ 返回类型必须写全（TemplateInstallOutcome）：推断成 {ok:true; agentId:string} 之后，
//    mockResolvedValueOnce({ok:false, message}) / ({recordWarning}) 会在 typecheck:tests 报错。
const install = vi.fn(async (): Promise<TemplateInstallOutcome> => ({ ok: true, agentId: 'rongying-tpl-x' }));
vi.mock('../src/renderer/layouts/MarketPanel/useTemplateInstall', () => ({
  useTemplateInstall: () => ({ install, installingId: null as string | null }),
}));

import type { TemplateInstallOutcome } from '../src/renderer/lib/template-install';
import MarketTab from '../src/renderer/layouts/MarketPanel/MarketTab';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const officialRow = {
  id: 't-official',
  name: '爆款内容教练',
  description: '从选题到成稿的内容工作流',
  category: 'content',
  emoji: '📣',
  is_official: true,
  author_name: '官方',
  install_count: 12,
  view_count: 30,
  installed_by_me: false,
};

const orgRow = {
  id: 't-org',
  name: '同事的模板',
  description: '别人的作品',
  category: 'research',
  emoji: '🔎',
  is_official: false,
  author_name: '甲',
  install_count: 1,
  view_count: 2,
  installed_by_me: true,
};

const detailRow = {
  ...officialRow,
  instructions: '你是内容创作教练。',
  is_mine: false,
  status: 'published',
};

async function render(): Promise<{ container: HTMLDivElement; unmount: () => void }> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(<MarketTab />);
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

describe('MarketTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(window, {
      clawwork: {
        marketTemplates: vi.fn(async () => ({ ok: true, result: [officialRow, orgRow] })),
        marketTemplateDetail: vi.fn(async () => ({ ok: true, result: detailRow })),
        marketTemplateInstalled: vi.fn(async () => ({ ok: true, result: { installCount: 13 } })),
      },
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('列出模板：名字、描述、作者、安装数、官方徽章', async () => {
    const view = await render();
    expect(view.container.textContent).toContain('爆款内容教练');
    expect(view.container.textContent).toContain('从选题到成稿的内容工作流');
    expect(view.container.textContent).toContain('官方');
    expect(view.container.textContent).toContain('甲');
    expect(view.container.textContent).toContain('12');
    view.unmount();
  });

  it('已安装的显示「已安装」且按钮禁用', async () => {
    const view = await render();
    const installedCard = [...view.container.querySelectorAll('[data-template]')].find((el) =>
      el.textContent?.includes('同事的模板'),
    );
    const button = installedCard?.querySelector('button[data-action="install"]') as HTMLButtonElement;
    expect(button.textContent).toContain(translate('market.installed'));
    expect(button.disabled).toBe(true);
    view.unmount();
  });

  it('切分类会把 category 带给后端', async () => {
    const view = await render();
    await act(async () => {
      buttonByText(view.container, translate('market.categoryResearch'))?.click();
    });
    const calls = (window.clawwork.marketTemplates as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.at(-1)?.[0]).toMatchObject({ category: 'research' });
    view.unmount();
  });

  it('搜索会把 query 带给后端（带防抖）', async () => {
    const view = await render();
    const input = view.container.querySelector('input[type="search"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(input, '教练');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });

    const calls = (window.clawwork.marketTemplates as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.at(-1)?.[0]).toMatchObject({ query: '教练' });
    view.unmount();
  });

  it('点卡片看详情：带出提示词全文', async () => {
    const view = await render();
    await act(async () => {
      ([...view.container.querySelectorAll('[data-template]')][0] as HTMLElement)?.click();
    });
    expect(window.clawwork.marketTemplateDetail).toHaveBeenCalledWith('t-official');
    expect(view.container.textContent).toContain('你是内容创作教练。');
    view.unmount();
  });

  it('⭐ 安装：拉详情 → 真安装 → 变成「已安装」并提示成功', async () => {
    const view = await render();
    const installButton = [...view.container.querySelectorAll('button[data-action="install"]')].find((b) =>
      b.textContent?.includes(translate('market.install')),
    ) as HTMLButtonElement;

    await act(async () => {
      installButton.click();
    });

    // 先拉详情（安装要用提示词），再交给 install 编排
    expect(window.clawwork.marketTemplateDetail).toHaveBeenCalledWith('t-official');
    expect(install).toHaveBeenCalledWith(expect.objectContaining({ id: 't-official' }));
    expect(toast.success).toHaveBeenCalled();
    // 同上：只断言这一张卡片，别借用另一张本来已安装的状态
    const card = [...view.container.querySelectorAll('[data-template]')].find((el) =>
      el.textContent?.includes('爆款内容教练'),
    );
    expect(card?.querySelector('button[data-action="install"]')?.textContent).toContain(translate('market.installed'));
    view.unmount();
  });

  it('⭐ 安装失败 ⇒ 主提示只显示中文，technical diagnostic 只进日志', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    install.mockResolvedValueOnce({
      ok: false,
      message: '安装没成功，请稍后重试。',
      diagnostic: 'gateway not connected',
    });
    const view = await render();
    const installButton = [...view.container.querySelectorAll('button[data-action="install"]')].find((b) =>
      b.textContent?.includes(translate('market.install')),
    ) as HTMLButtonElement;

    await act(async () => {
      installButton.click();
    });

    const errorTexts = (toast.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
    expect(errorTexts.some((text) => /[一-龥]/.test(text))).toBe(true);
    expect(errorTexts.join(' ')).not.toContain('gateway not connected');
    expect(consoleError).toHaveBeenCalledWith('[market] 助手安装失败:', 'gateway not connected');
    // ⚠️ 只能断言**这一张卡片**：列表里另一张本来就是"已安装"，
    //    对整个容器做 not.toContain('已安装') 会因为别人的状态而永远失败
    expect(installButton.textContent).not.toContain(translate('market.installed'));
    expect(installButton.disabled).toBe(false);
    view.unmount();
    consoleError.mockRestore();
  });

  it('⭐ install promise reject ⇒ 捕获并给中文失败提示', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    install.mockRejectedValueOnce(new Error('gateway exploded'));
    const view = await render();
    const installButton = [...view.container.querySelectorAll('button[data-action="install"]')].find((b) =>
      b.textContent?.includes(translate('market.install')),
    ) as HTMLButtonElement;

    await act(async () => {
      installButton.click();
      await Promise.resolve();
    });

    expect((toast.error as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0]).toBe(
      translate('market.installFailed'),
    );
    expect(consoleError).toHaveBeenCalledWith('[market] 助手安装请求异常:', expect.any(Error));
    expect(installButton.textContent).not.toContain(translate('market.installed'));
    view.unmount();
    consoleError.mockRestore();
  });

  it('⭐ 记账失败 ⇒ 助手装好了但提示一句"次数没记上"（不当作失败）', async () => {
    install.mockResolvedValueOnce({ ok: true, agentId: 'x', recordWarning: '连不上服务器，请检查网络后重试。' });
    const view = await render();
    const installButton = [...view.container.querySelectorAll('button[data-action="install"]')].find((b) =>
      b.textContent?.includes(translate('market.install')),
    ) as HTMLButtonElement;

    await act(async () => {
      installButton.click();
    });

    expect(toast.warning).toHaveBeenCalled();
    const card = [...view.container.querySelectorAll('[data-template]')].find((el) =>
      el.textContent?.includes('爆款内容教练'),
    );
    expect(card?.querySelector('button[data-action="install"]')?.textContent).toContain(translate('market.installed'));
    view.unmount();
  });

  it('空列表给中文空态', async () => {
    (window.clawwork.marketTemplates as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true, result: [] });
    const view = await render();
    expect(view.container.textContent).toContain(translate('market.empty'));
    view.unmount();
  });

  it('加载失败给中文 + 重试', async () => {
    const list = window.clawwork.marketTemplates as ReturnType<typeof vi.fn>;
    list.mockResolvedValueOnce({ ok: false, errorCode: 'network' });
    const view = await render();
    expect(view.container.textContent).toContain(translate('market.loadFailed'));

    list.mockResolvedValueOnce({ ok: true, result: [officialRow] });
    await act(async () => {
      buttonByText(view.container, translate('market.retry'))?.click();
    });
    expect(view.container.textContent).toContain('爆款内容教练');
    view.unmount();
  });
});
