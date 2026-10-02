// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { PUBLIC_MARKET_CLOSED } from '@clawwork/shared';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

import NavMenu from '../src/renderer/layouts/LeftNav/NavMenu';

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
describe('LeftNav NavMenu', () => {
  it('⭐ 按设计稿的顺序渲染，并把图标栏搬来的几项接在后面', () => {
    const { container, unmount } = setup();
    const keys = [...container.querySelectorAll('[data-nav]')].map((el) => el.getAttribute('data-nav'));

    // 客户发行包不带运营/内测入口；那一项只允许内部构建显式打开。
    // ⚠️ `tasks`（最近任务）是 2026-09-20 用户点名加的：**放在「身份中心」上面**
    //    —— 原来那栏在左列最下面、"显示也不全"，改成导航入口 + 右侧全量面板。
    expect(keys).toEqual([
      'search',
      'tasks',
      'identity',
      'teams',
      'skills',
      'agents',
      'bounty',
      'square',
      'creator',
      'usage',
      'growth',
      'cron',
      'files',
      'archived',
      'kb',
      'settings',
    ]);
    unmount();
  });

  it('⭐ 点「最近任务」落到 `tasks` 这个 mainView（它不再是左列最下面那一块）', () => {
    const { container, onSelectView, unmount } = setup();

    clickNav(container, 'tasks');

    expect(onSelectView).toHaveBeenLastCalledWith('tasks');
    unmount();
  });

  it('⭐「最近任务」在「身份中心」上面（用户点名：原来在最下面不好）', () => {
    const { container, unmount } = setup();
    const keys = [...container.querySelectorAll('[data-nav]')].map((el) => el.getAttribute('data-nav'));

    expect(keys.indexOf('tasks')).toBe(keys.indexOf('identity') - 1);
    unmount();
  });

  it('⭐ 图标栏搬来的三项能落到对应页面，客户包没有运营后台入口', () => {
    const { container, onSelectView, unmount } = setup();

    clickNav(container, 'files');
    expect(onSelectView).toHaveBeenLastCalledWith('files');
    clickNav(container, 'archived');
    expect(onSelectView).toHaveBeenLastCalledWith('archived');
    clickNav(container, 'kb');
    expect(onSelectView).toHaveBeenLastCalledWith('kb');
    expect(container.querySelector('[data-nav="betaHub"]')).toBeNull();
    unmount();
  });

  it('⭐「设置」走设置面板（和技能市场一样，不是 mainView）', () => {
    const { container, onSelectView, onOpenSettings, unmount } = setup();

    clickNav(container, 'settings');

    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(onSelectView).not.toHaveBeenCalled();
    unmount();
  });

  it('「设置」在有更新时带角标', () => {
    const plain = setup({ hasUpdate: false });
    expect(plain.container.querySelector('[data-nav="settings"]')!.textContent).not.toContain('•');
    plain.unmount();

    const upd = setup({ hasUpdate: true });
    expect(upd.container.querySelector('[data-nav="settings"]')!.textContent).toContain('•');
    upd.unmount();
  });

  it('每一项都渲染出文案（i18n 键解析到位）', () => {
    const { container, unmount } = setup();
    expect(container.textContent).toContain('leftNav.pages.search');
    expect(container.textContent).toContain('leftNav.identityCenter');
    expect(container.textContent).toContain('leftNav.pages.bounty');
    expect(container.textContent).toContain('cron.title');
    unmount();
  });

  it('点有页面的项 ⇒ 落到对应的 mainView', () => {
    const { container, onSelectView, unmount } = setup();

    clickNav(container, 'identity');
    expect(onSelectView).toHaveBeenLastCalledWith('identity');
    clickNav(container, 'bounty');
    expect(onSelectView).toHaveBeenLastCalledWith('bounty');
    clickNav(container, 'creator');
    expect(onSelectView).toHaveBeenLastCalledWith('creator');
    clickNav(container, 'square');
    expect(onSelectView).toHaveBeenLastCalledWith('community');
    if (!PUBLIC_MARKET_CLOSED) {
      clickNav(container, 'agents');
      expect(onSelectView).toHaveBeenLastCalledWith('market');
    }
    unmount();
  });

  it.runIf(PUBLIC_MARKET_CLOSED)('公开市场关闭：入口**保留可见**但置灰不可点（带说明气泡）', () => {
    const { container, onSelectView, unmount } = setup();
    const agents = container.querySelector('[data-nav="agents"]');

    expect(agents, '入口不许直接删掉 —— 删除会让用户猜"功能没了还是藏了"').not.toBeNull();
    expect((agents as HTMLButtonElement).disabled).toBe(true);
    expect(agents?.getAttribute('aria-disabled')).toBe('true');
    expect(agents?.getAttribute('title')).toBeTruthy();

    // 点了也不许导航（disabled 按钮本来就不派发 click，这里显式钉住后果）。
    clickNav(container, 'agents');
    expect(onSelectView).not.toHaveBeenCalled();
    unmount();
  });

  it('⭐ 点「技能市场」落到 `skills` 这个 mainView（T-a2 起它**不再是**设置里的一节）', () => {
    // ⚠️ 这条**改过**：原来钉的是"走设置面板、不切 mainView"。
    //    改的理由是用户 2026-09-20 的原话：「技能市场点击居然是设置的主页面」
    //    —— 点"市场"落到设置页本身就是被投诉的那个现象。
    //    现在它是个真页面，**顺带**修掉了"这一项永远没有选中态"那个已知缺口
    //    （旧注释写着"要做对得把 settingsSection 也传下来"；变成 view 之后就不需要了）。
    const { container, onSelectView, onOpenSettings, unmount } = setup();

    clickNav(container, 'skills');

    expect(onSelectView).toHaveBeenLastCalledWith('skills');
    expect(onOpenSettings).not.toHaveBeenCalled();
    unmount();
  });

  it('选中态只标一个，且只在设置没开时标', () => {
    const { container, unmount } = setup({ mainView: 'growth', settingsOpen: false });
    const current = [...container.querySelectorAll('[aria-current="page"]')].map((el) => el.getAttribute('data-nav'));
    expect(current).toEqual(['growth']);
    unmount();

    // 设置面板开着时，页面导航整体不处于选中态
    const second = setup({ mainView: 'growth', settingsOpen: true });
    expect(second.container.querySelectorAll('[aria-current="page"]')).toHaveLength(0);
    second.unmount();
  });

  it('「团队」带 Beta 角标，其它项不带', () => {
    const { container, unmount } = setup();
    expect(container.querySelector('[data-nav="teams"]')!.textContent).toContain('Beta');
    expect(container.querySelector('[data-nav="identity"]')!.textContent).not.toContain('Beta');
    unmount();
  });
});
