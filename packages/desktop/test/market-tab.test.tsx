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

/**
 * ⭐ BUG-025：点「在罗盘助手中使用」必须**直达对应罗盘助手**（全应用唯一的那条切助手动作）。
 * 这里把那条路打桩，验证的是"到没到"，不是"怎么到"（后者在 `use-select-agent.test.tsx`）。
 */
const selectAgent = vi.fn();
vi.mock('@/hooks/useSelectAgent', () => ({ useSelectAgent: () => selectAgent }));

// 备好助手的编排单独测过（template-install.test.ts），这里只验证界面接线。
// ⚠️ 返回类型必须写全（TemplateInstallOutcome）：推断成 {ok:true; agentId:string} 之后，
//    mockResolvedValueOnce({ok:false, message}) / ({recordWarning}) 会在 typecheck:tests 报错。
// ⚠️ 2026-10-07（质检 P2-4）：忙碌态必须**可注入** —— 以前这里把 `installingId` 钉成常量
//    `null`，于是"安装中按钮禁用 / 双击只算一次"这两条**永远不会被测到**（全盲）。
const installState = vi.hoisted(() => ({
  install: vi.fn(async (): Promise<TemplateInstallOutcome> => ({ ok: true, agentId: 'rongying-tpl-x' })),
  installingIds: new Set<string>(),
  beginInstall: vi.fn(),
  endInstall: vi.fn(),
}));
vi.mock('../src/renderer/layouts/MarketPanel/useTemplateInstall', () => ({
  useTemplateInstall: () => ({
    install: installState.install,
    installingIds: installState.installingIds,
    beginInstall: installState.beginInstall,
    endInstall: installState.endInstall,
  }),
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

function useButton(container: HTMLElement): HTMLButtonElement {
  return container.querySelector('button[data-action="use-in-compass"]') as HTMLButtonElement;
}

describe('MarketTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installState.installingIds = new Set<string>();
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

  it('列出模板：名字、描述、作者、用过的人数、官方徽章', async () => {
    const view = await render();
    expect(view.container.textContent).toContain('爆款内容教练');
    expect(view.container.textContent).toContain('从选题到成稿的内容工作流');
    expect(view.container.textContent).toContain('官方');
    expect(view.container.textContent).toContain('甲');
    expect(view.container.textContent).toContain('12');
    view.unmount();
  });

  it('⭐ 入口只讲「在罗盘助手中使用」：整个市场界面不出现「安装 / 已安装」语义', async () => {
    const view = await render();
    expect(view.container.textContent).not.toContain('安装');
    expect(view.container.textContent).not.toContain('已装');
    expect(document.body.textContent).not.toContain('安装');
    expect(useButton(view.container)?.textContent).toContain(translate('market.useInCompass'));
    // 已在我的模板里用过的（`installed_by_me`）也一样能点：这里不摆"已安装"那种状态
    expect(useButton(view.container)?.disabled).toBe(false);
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

  it('⭐ 点「在罗盘助手中使用」：拉详情 → 备好助手 → 直达对应罗盘助手（不给"安装成功"提示）', async () => {
    const view = await render();
    const button = useButton(view.container);

    await act(async () => {
      button.click();
    });

    // 先拉详情（备好助手要用提示词），再交给备好助手的编排，最后**切到那个助手**
    expect(window.clawwork.marketTemplateDetail).toHaveBeenCalledWith('t-official');
    expect(installState.install).toHaveBeenCalledWith(expect.objectContaining({ id: 't-official' }));
    expect(selectAgent).toHaveBeenCalledWith('rongying-tpl-x');
    // 关键：不再有「安装成功 → 去助手栏看看吧」这一层
    expect(toast.success).not.toHaveBeenCalled();
    view.unmount();
  });

  it('⭐ 备好助手失败 ⇒ 中文提示 + 不跳转，diagnostic 只进日志', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    installState.install.mockResolvedValueOnce({
      ok: false,
      message: '没能打开这个能力，请稍后重试。',
      diagnostic: 'gateway not connected',
    });
    const view = await render();

    await act(async () => {
      useButton(view.container).click();
    });

    const errorTexts = (toast.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
    expect(errorTexts.some((text) => /[一-龥]/.test(text))).toBe(true);
    expect(errorTexts.join(' ')).not.toContain('gateway not connected');
    expect(consoleError).toHaveBeenCalledWith('[market] 备好助手失败:', 'gateway not connected');
    expect(selectAgent).not.toHaveBeenCalled();
    expect(useButton(view.container).disabled).toBe(false);
    view.unmount();
    consoleError.mockRestore();
  });

  it('⭐ install promise reject ⇒ 捕获并给中文失败提示，不跳转', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    installState.install.mockRejectedValueOnce(new Error('gateway exploded'));
    const view = await render();

    await act(async () => {
      useButton(view.container).click();
      await Promise.resolve();
    });

    expect((toast.error as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0]).toBe(
      translate('market.actionFailed'),
    );
    expect(consoleError).toHaveBeenCalledWith('[market] 在罗盘助手中打开异常:', expect.any(Error));
    expect(selectAgent).not.toHaveBeenCalled();
    view.unmount();
    consoleError.mockRestore();
  });

  it('⭐ 详情拿不回来 ⇒ 中文提示，既不备好助手也不跳转', async () => {
    (window.clawwork.marketTemplateDetail as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      errorCode: 'network',
    });
    const view = await render();

    await act(async () => {
      useButton(view.container).click();
    });

    expect((toast.error as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0]).toBe(
      translate('market.loadFailed'),
    );
    expect(installState.install).not.toHaveBeenCalled();
    expect(selectAgent).not.toHaveBeenCalled();
    view.unmount();
  });

  /**
   * ⭐⭐ 2026-10-07（质检 P1-1 / P2-4）：市场链的忙碌态与并发。
   *
   * 三条都是**以前测不到**的：mock 把忙碌态钉成常量 null，真实缺陷（拉详情窗口期
   * 还能再点 ⇒ 双击装两次、记两次账）在测试里全盲。
   */
  it('⭐ 正在准备时那一行按钮禁用并显示「正在准备…」，别的行不受影响', async () => {
    installState.installingIds = new Set(['t-official']);
    const view = await render();

    const buttons = [...view.container.querySelectorAll('button[data-action="use-in-compass"]')];
    expect(buttons).toHaveLength(2);
    expect((buttons[0] as HTMLButtonElement).disabled).toBe(true);
    expect(buttons[0]?.textContent).toContain(translate('market.preparing'));
    expect((buttons[1] as HTMLButtonElement).disabled).toBe(false);
    expect(buttons[1]?.textContent).toContain(translate('market.useInCompass'));
    view.unmount();
  });

  it('⭐ 双击「在罗盘助手中使用」只触发一次 install（入口同步去重）', async () => {
    const view = await render();
    const button = useButton(view.container);

    await act(async () => {
      button.click();
      button.click(); // 同一 tick 的第二次点击：React state 还没更新，必须靠 ref 同步挡住
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(installState.install).toHaveBeenCalledTimes(1);
    expect(installState.beginInstall).toHaveBeenCalledTimes(1);
    expect(installState.beginInstall).toHaveBeenCalledWith('t-official');
    expect(installState.endInstall).toHaveBeenCalledWith('t-official');
    expect(selectAgent).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it('⭐ 备好助手但没拿到助手标识（ok:true 且 agentId 缺失）⇒ 失败文案 + 不跳转', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    installState.install.mockResolvedValueOnce({ ok: true }); // 没有 agentId
    const view = await render();

    await act(async () => {
      useButton(view.container).click();
    });

    expect((toast.error as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0]).toBe(
      translate('market.actionFailed'),
    );
    expect(consoleError).toHaveBeenCalledWith('[market] 备好助手但没拿到助手标识:', 't-official');
    expect(selectAgent).not.toHaveBeenCalled();
    expect(installState.endInstall).toHaveBeenCalledWith('t-official');
    view.unmount();
    consoleError.mockRestore();
  });

  it('⭐ 记账失败 ⇒ 提示一句"次数没记上"（不当作失败），照样直达助手', async () => {
    installState.install.mockResolvedValueOnce({
      ok: true,
      agentId: 'rongying-tpl-x',
      recordWarning: '连不上服务器，请检查网络后重试。',
    });
    const view = await render();

    await act(async () => {
      useButton(view.container).click();
    });

    expect(toast.warning).toHaveBeenCalled();
    expect(selectAgent).toHaveBeenCalledWith('rongying-tpl-x');
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
