// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { PUBLIC_MARKET_CLOSED } from '@clawwork/shared';

vi.mock('@/lib/toast', () => ({ toast: vi.fn() }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

import NavMenu from '../src/renderer/layouts/LeftNav/NavMenu';
import { toast } from '@/lib/toast';

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

function setup(over: Partial<Parameters<typeof NavMenu>[0]> = {}) {
  const onSelectView = vi.fn();
  const onOpenSettings = vi.fn();
  const utils = render(
    <NavMenu
      mainView="chat"
      settingsOpen={false}
      onSelectView={onSelectView}
      onOpenSettings={onOpenSettings}
      hasUpdate={false}
      {...over}
    />,
  );
  return { ...utils, onSelectView, onOpenSettings };
}

const clickNav = (container: HTMLElement, key: string) => {
  const el = container.querySelector(`[data-nav="${key}"]`) as HTMLButtonElement | null;
  if (!el) throw new Error(`找不到导航项 ${key}`);
  act(() => el.click());
};

/**
 * 左侧页面导航（2026-09-19）。
 *
 * ⚠️ 这条**顺序断言是刻意的** —— 顺序就是与老板设计稿的对应关系，
 *    改顺序 = 改设计稿的对齐，应当是一次有意的决定而不是手抖。
 */
describe('LeftNav NavMenu（2026-10-17 晚按设计稿重排）', () => {
  const openMore = (container: HTMLElement) => clickNav(container, 'more');

  /**
   * ⭐ 2026-10-18（用户实测）：「资料库」让位给「智能体市场」。
   *    原来的 `kb` 从顶部挪进「更多」，`agents` 从「更多」提上来 ——
   *    两条入口**都在**，只是层级对调。
   */
  it('⭐ 顶部只留这几行：新建任务 / 团队 / 技能库 / 智能体 / 智能体市场 / 更多', () => {
    const { container, unmount } = setup();
    const keys = [...container.querySelectorAll('[data-nav]')].map((el) => el.getAttribute('data-nav'));
    expect(keys).toEqual(['new-task', 'teams', 'skills', 'experts', 'agents', 'more']);
    unmount();
  });

  it('⭐ 「更多」展开后是全部次级入口（一个都没删，资料库已移入）', () => {
    const { container, unmount } = setup();
    openMore(container);
    const keys = [...container.querySelectorAll('[data-nav]')].map((el) => el.getAttribute('data-nav'));
    expect(keys).toEqual([
      'new-task',
      'teams',
      'skills',
      'experts',
      'agents',
      'more',
      'tasks',
      'identity',
      'kb',
      'bounty',
      'square',
      'creator',
      'usage',
      'growth',
      'cron',
      'files',
      'archived',
    ]);
    unmount();
  });

  it('⭐ 「资料库」入口没丢：从「更多」里仍能落到 kb 页面', () => {
    const { container, onSelectView, unmount } = setup();
    openMore(container);
    clickNav(container, 'kb');
    expect(onSelectView).toHaveBeenLastCalledWith('kb');
    unmount();
  });

  it('⭐ 点「新建任务」走 onNewTask（不再只是搜索框旁的小图标）', () => {
    const onNewTask = vi.fn();
    const { container, unmount } = setup({ onNewTask });
    clickNav(container, 'new-task');
    expect(onNewTask).toHaveBeenCalledOnce();
    unmount();
  });

  it('⭐ 点「最近任务」落到 `tasks` 这个 mainView', () => {
    const { container, onSelectView, unmount } = setup();
    openMore(container);
    clickNav(container, 'tasks');
    expect(onSelectView).toHaveBeenLastCalledWith('tasks');
    unmount();
  });

  it('⭐ 图标栏搬来的三项仍能落到对应页面，客户包没有运营后台入口', () => {
    const { container, onSelectView, unmount } = setup();
    openMore(container);
    clickNav(container, 'files');
    expect(onSelectView).toHaveBeenLastCalledWith('files');
    // 点完一次「更多」会自动收起（选完就走），下一次要重新展开。
    openMore(container);
    clickNav(container, 'archived');
    expect(onSelectView).toHaveBeenLastCalledWith('archived');
    // 「资料库」2026-10-18 移入「更多」⇒ 也要先展开（上一条选完已自动收起）。
    openMore(container);
    clickNav(container, 'kb');
    expect(onSelectView).toHaveBeenLastCalledWith('kb');
    expect(container.querySelector('[data-nav="betaHub"]')).toBeNull();
    unmount();
  });

  it('每一项都渲染出文案（i18n 键解析到位）', () => {
    const { container, unmount } = setup();
    expect(container.textContent).toContain('leftNav.pages.more');
    expect(container.textContent).toContain('leftNav.pages.agentsSimple');
    openMore(container);
    expect(container.textContent).toContain('leftNav.identityCenter');
    expect(container.textContent).toContain('leftNav.pages.bounty');
    expect(container.textContent).toContain('cron.title');
    unmount();
  });

  it('点有页面的项 ⇒ 落到对应的 mainView', () => {
    const { container, onSelectView, unmount } = setup();
    openMore(container);
    clickNav(container, 'identity');
    expect(onSelectView).toHaveBeenLastCalledWith('identity');
    openMore(container);
    clickNav(container, 'bounty');
    expect(onSelectView).toHaveBeenLastCalledWith('identity');
    openMore(container);
    clickNav(container, 'creator');
    expect(onSelectView).toHaveBeenLastCalledWith('creator');
    openMore(container);
    clickNav(container, 'square');
    expect(onSelectView).toHaveBeenLastCalledWith('community');
    if (!PUBLIC_MARKET_CLOSED) {
      // 2026-10-18：`agents` 已是一级入口，不需要先展开「更多」。
      clickNav(container, 'agents');
      expect(onSelectView).toHaveBeenLastCalledWith('market');
    }
    unmount();
  });

  it('⭐ 需求悬赏置灰可点：点击弹「敬请期待」、不导航（用户拍板 2026-10-06）', () => {
    vi.mocked(toast).mockClear();
    const { container, onSelectView, unmount } = setup();
    openMore(container);
    const bounty = container.querySelector('[data-nav="bounty"]') as HTMLButtonElement;
    expect(bounty.disabled).toBe(false);
    expect(bounty.className).toContain('opacity-60');

    clickNav(container, 'bounty');
    expect(toast).toHaveBeenCalledWith(
      'leftNav.bountyComingSoon',
      expect.objectContaining({ id: 'bounty-coming-soon' }),
    );
    expect(onSelectView).not.toHaveBeenCalled();
    unmount();
  });

  it.runIf(PUBLIC_MARKET_CLOSED)('公开市场关闭：入口**保留可见**但置灰不可点（带说明气泡）', () => {
    const { container, onSelectView, unmount } = setup();
    // 2026-10-18：入口已提到顶部一级清单（不依赖「更多」是否展开）。
    const agents = container.querySelector('[data-nav="agents"]');
    expect(agents, '入口不许直接删掉 —— 删除会让用户猜"功能没了还是藏了"').not.toBeNull();
    expect((agents as HTMLButtonElement).disabled).toBe(true);
    expect(agents?.getAttribute('aria-disabled')).toBe('true');
    expect(agents?.getAttribute('title')).toBeTruthy();

    clickNav(container, 'agents');
    expect(onSelectView).not.toHaveBeenCalled();
    unmount();
  });

  it('⭐ 点「技能市场」落到 `skills` 这个 mainView', () => {
    const { container, onSelectView, onOpenSettings, unmount } = setup();
    clickNav(container, 'skills');
    expect(onSelectView).toHaveBeenLastCalledWith('skills');
    expect(onOpenSettings).not.toHaveBeenCalled();
    unmount();
  });

  it('选中态只标一个，且只在设置没开时标', () => {
    const { container, unmount } = setup({ mainView: 'skills', settingsOpen: false });
    const current = [...container.querySelectorAll('[aria-current="page"]')].map((el) => el.getAttribute('data-nav'));
    expect(current).toEqual(['skills']);
    unmount();

    const second = setup({ mainView: 'skills', settingsOpen: true });
    expect(second.container.querySelectorAll('[aria-current="page"]')).toHaveLength(0);
    second.unmount();
  });

  it('「团队」带 Beta 角标，其它项不带', () => {
    const { container, unmount } = setup();
    expect(container.querySelector('[data-nav="teams"]')!.textContent).toContain('Beta');
    expect(container.querySelector('[data-nav="skills"]')!.textContent).not.toContain('Beta');
    unmount();
  });
});

/**
 * 「更多」的收起（2026-10-18 同事批次移植）。
 *
 * 现场：点开「更多」后切到别处（对话 / 其它页 / 任务行），它**不会收起** ——
 * 一整列二级入口摊在左栏，把任务列表挤到看不见（用户反馈"左边栏坏了"）。
 * 规则：① mainView 一变就复位；② 点「更多」以外的地方也收起。
 */
describe('「更多」的收起', () => {
  const openMore = (container: HTMLElement) => clickNav(container, 'more');
  const moreExpanded = (container: HTMLElement) =>
    container.querySelector('[data-testid="left-nav-more-items"]') !== null;

  it('⭐ 点「更多」以外的地方（document mousedown）⇒ 收起', () => {
    const { container, unmount } = setup();
    openMore(container);
    expect(moreExpanded(container)).toBe(true);

    act(() => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(moreExpanded(container)).toBe(false);
    unmount();
  });

  it('⭐ 点「更多」本身不触发点外收起（开合仍是它自己的事）', () => {
    const { container, unmount } = setup();
    openMore(container);
    act(() => {
      (container.querySelector('[data-nav="more"]') as HTMLElement).dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true }),
      );
    });
    expect(moreExpanded(container)).toBe(true);
    unmount();
  });

  it('⭐ mainView 变化 ⇒ 复位', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    const onSelectView = vi.fn();
    const renderAt = (mainView: 'chat' | 'skills') =>
      act(() =>
        root.render(
          <NavMenu
            mainView={mainView}
            settingsOpen={false}
            onSelectView={onSelectView}
            onOpenSettings={vi.fn()}
            hasUpdate={false}
          />,
        ),
      );

    renderAt('chat');
    openMore(container);
    expect(moreExpanded(container)).toBe(true);

    renderAt('skills');
    expect(moreExpanded(container)).toBe(false);

    act(() => root.unmount());
    container.remove();
  });

  it('⭐ 点主入口导航项（新建任务 / 技能库）⇒ 收起', () => {
    const { container, unmount } = setup();
    openMore(container);
    clickNav(container, 'skills');
    expect(moreExpanded(container)).toBe(false);
    unmount();
  });
});
