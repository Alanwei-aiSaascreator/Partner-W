// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  // ⚠️ 带插值时把取值也显示出来 —— 只回 key 的话 `toContain('agent.missingTitle')`
  //    对**任何** agentId 都成立，绑不住"点名了哪一个"（2026-09-24 独立复核 M-8）。
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options ? `${key}(${JSON.stringify(options)})` : key),
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

/**
 * ⚠️ 必需：`LeftNav → useGatewaySelector → useGatewayBootstrap → useGatewayDispatcherSetup
 * → lib/session-sync` 这条链在**模块作用域**就抓 `getPorts()`，而 electron-adapter 会读
 * `window.clawwork.*`。没有这个桩，整个套件在导入期就炸（`Cannot read properties of
 * undefined (reading 'loadTasks')`），一条用例都跑不起来。
 * `vi.hoisted` 保证它跑在**导入之前**。
 */
vi.hoisted(() => {
  (globalThis as { clawwork?: unknown }).clawwork = {};
});

// 真 hook 会在选中的网关上拉一次目录；这里只测界面，掐掉那一跳。
vi.mock('@/hooks/useGatewayBootstrap', () => ({
  fetchAgentsForGateway: vi.fn(async () => undefined),
}));

import LeftNav from '../src/renderer/layouts/LeftNav';
import { TooltipProvider } from '../src/renderer/components/ui/tooltip';
import { useTaskStore } from '../src/renderer/stores/taskStore';
import { useUiStore } from '../src/renderer/stores/uiStore';
import { useTeamStore } from '../src/renderer/stores/teamStore';

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

function renderLeftNav(): { container: HTMLDivElement; unmount: () => void } {
  // `Tooltip` 平时由应用外壳的 provider 兜着，单独渲染这一列时要自己包一层。
  return render(
    <TooltipProvider>
      <LeftNav onOpenAssistantSettings={vi.fn()} onOpenSettings={vi.fn()} />
    </TooltipProvider>,
  );
}

/** 目录**已加载**（键存在）且只有这些助手。 */
function setLoadedCatalog(ids: string[]): void {
  useUiStore.setState({
    gatewayInfoMap: { 'gw-1': { id: 'gw-1' } as never },
    defaultGatewayId: 'gw-1',
    agentCatalogByGateway: { 'gw-1': { agents: ids.map((id) => ({ id })) as never, defaultId: 'main' } },
  });
}

/**
 * 左栏那一处静默替换（层 2 的第二个现场）。
 *
 * 旧行为：持久选择不在目录里时 `currentAgentId` 回落到 `defaultAgentId`，
 * 于是切换器把**默认助手**显示成「当前助手」、「新建任务」也用它 —— 与欢迎屏同一个病。
 */
describe('LeftNav 不拿默认助手冒充当前助手', () => {
  beforeEach(() => {
    window.localStorage.clear();
    setLoadedCatalog(['main']);
    useUiStore.setState({ selectedAgentByGateway: {}, leftNavCollapsed: false, mainView: 'chat' });
    useTaskStore.setState({ tasks: [], activeTaskId: null, pendingNewTask: null });
    useTeamStore.setState({ teams: {}, loadedOnce: true, loading: false });
  });

  it('⭐ 持久选择不在目录里 ⇒ 提示出现，且切换器不再把罗盘显示成当前助手', () => {
    useUiStore.setState({ selectedAgentByGateway: { 'gw-1': 'team-agent-x' } });
    const { container, unmount } = renderLeftNav();

    expect(container.textContent, '要如实说明').toContain('agent.missingTitle');
    expect(container.textContent, '提示里要点名是哪一个').toContain('team-agent-x');

    const trigger = container.querySelector('[data-testid="assistant-switcher"]');
    expect(trigger?.textContent, '不许把罗盘冒充成当前助手').not.toContain('mainArea.compassAssistant');
    // 退化成组件本来就有（`current === undefined`）的中性态，而不是另一个助手
    expect(trigger?.textContent, '应落成未选中的中性文案').toContain('leftNav.myAssistants');
    unmount();
  });

  it('⭐ 对照：选择在目录里时照常显示，且不出现提示', () => {
    useUiStore.setState({ selectedAgentByGateway: { 'gw-1': 'main' } });
    const { container, unmount } = renderLeftNav();

    expect(container.textContent, '没有缺失就不许出现提示').not.toContain('agent.missingTitle');
    expect(container.querySelector('[data-testid="assistant-switcher"]')?.textContent).toContain(
      'mainArea.compassAssistant',
    );
    unmount();
  });

  /**
   * ⭐ 2026-09-24（独立复核 M-7）：`LeftNav` 的注释声称"「新建任务」把它原样交给待发任务"，
   * 但只绑住了一半（切换器那半有测试）。把 `agentId` 单独换成默认助手，左栏就会
   * 一边说"不在本机"、一边把新建任务派给罗盘，而整套照样全绿。
   */
  it('⭐ 拒绝态下点「新建任务」：交给待发任务的是**原样的 id**，不是默认助手', () => {
    useUiStore.setState({ selectedAgentByGateway: { 'gw-1': 'team-agent-x' } });
    const { container, unmount } = renderLeftNav();

    act(() => (container.querySelector('[data-action="new-task"]') as HTMLElement).click());

    expect(useTaskStore.getState().pendingNewTask?.agentId, '不许换成默认助手').toBe('team-agent-x');
    unmount();
  });
});

/**
 * 左栏顶部（2026-10-18 用户实测）。
 *
 * 现场：标题栏下方先是一大块空白，再是「紫红方标 + 荣盈魔方」一行，然后才是搜索/导航。
 * 标题栏本身已经写了品牌名 ⇒ 重复且把整列压低。
 * 现在的契约：**品牌位不渲染**；顶部不再有 `pt-10` 的空占位；
 * 但窗口仍能从这一列顶部拖动（第一行自己就是 `titlebar-drag`，控件们是 no-drag）。
 */
describe('LeftNav 顶部（去品牌位 + 收紧空白）', () => {
  beforeEach(() => {
    window.localStorage.clear();
    setLoadedCatalog(['main']);
    useUiStore.setState({ selectedAgentByGateway: {}, leftNavCollapsed: false, mainView: 'chat' });
    useTaskStore.setState({ tasks: [], activeTaskId: null, pendingNewTask: null });
    useTeamStore.setState({ teams: {}, loadedOnce: true, loading: false });
  });

  it('⭐ 品牌位不再渲染，顶部没有 40px 空占位', () => {
    const { container, unmount } = renderLeftNav();
    expect(container.querySelector('.left-nav-brand__logo'), '品牌位应已删除').toBeNull();
    expect(container.textContent, '左栏不再重复品牌名').not.toContain('common.appName');

    const root = container.firstElementChild as HTMLElement;
    expect(root.className, '顶部空占位（pt-10）应已收紧').not.toContain('pt-10');
    // 第一条可见行就是搜索框所在的那一行。
    expect(container.querySelector('input[placeholder="leftNav.searchTasks"]')).not.toBeNull();
    unmount();
  });

  it('⭐ 窗口仍可从左栏顶部拖动（第一行是 drag，交互控件是 no-drag）', () => {
    const { container, unmount } = renderLeftNav();
    const drag = container.querySelector('.titlebar-drag') as HTMLElement | null;
    expect(drag, '拖拽区不许连同品牌位一起删掉').not.toBeNull();
    expect(drag!.querySelector('[data-action="toggle-left-nav"]'), '收起按钮要在这条拖拽行里').not.toBeNull();
    // 交互控件自身必须 no-drag，否则点击会被窗口拖动吞掉。
    expect(container.querySelector('[data-action="toggle-left-nav"]')!.className).toContain('titlebar-no-drag');
    unmount();
  });

  it('对照：收纳态同样没有品牌位（收起后只剩图标条）', () => {
    useUiStore.setState({ leftNavCollapsed: true });
    const { container, unmount } = renderLeftNav();
    expect(container.querySelector('.left-nav-brand__logo')).toBeNull();
    expect(container.querySelector('[data-action="toggle-left-nav"]')).not.toBeNull();
    unmount();
  });
});
