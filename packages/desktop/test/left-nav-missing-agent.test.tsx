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
 * ⚠️ 必需：`TopBar → AssistantSwitcher → useGatewaySelector → useGatewayBootstrap
 * → useGatewayDispatcherSetup → lib/session-sync` 这条链在**模块作用域**就抓
 * `getPorts()`，而 electron-adapter 会读 `window.clawwork.*`。没有这个桩，整个套件
 * 在导入期就炸。`vi.hoisted` 保证它跑在**导入之前**。
 */
vi.hoisted(() => {
  (globalThis as { clawwork?: unknown }).clawwork = {};
});

// 真 hook 会在选中的网关上拉一次目录；这里只测界面，掐掉那一跳。
vi.mock('@/hooks/useGatewayBootstrap', () => ({
  fetchAgentsForGateway: vi.fn(async () => undefined),
}));

import TopBar from '../src/renderer/layouts/TopBar';
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

/**
 * 2026-10-28 排版重构：页面导航 / 搜索 / 新建任务 / 助手切换 / 个人资料从 `LeftNav`
 * 搬到顶部导航栏 `TopBar`。缺失助手的契约跟着功能走 —— 所以这份测试渲染 `TopBar`。
 */
function renderTopBar(): { container: HTMLDivElement; unmount: () => void } {
  return render(
    <TooltipProvider>
      <TopBar onOpenAssistantSettings={vi.fn()} onOpenSettings={vi.fn()} />
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
 * 顶部导航栏那一处静默替换。
 *
 * 旧行为：持久选择不在目录里时 `currentAgentId` 回落到 `defaultAgentId`，
 * 于是切换器把**默认助手**显示成「当前助手」、「新建任务」也用它 —— 与欢迎屏同一个病。
 */
describe('TopBar 不拿默认助手冒充当前助手', () => {
  beforeEach(() => {
    window.localStorage.clear();
    setLoadedCatalog(['main']);
    useUiStore.setState({ selectedAgentByGateway: {}, leftNavCollapsed: false, mainView: 'chat' });
    useTaskStore.setState({ tasks: [], activeTaskId: null, pendingNewTask: null });
    useTeamStore.setState({ teams: {}, loadedOnce: true, loading: false });
  });

  it('⭐ 持久选择不在目录里 ⇒ 提示出现，且切换器不再把罗盘显示成当前助手', () => {
    useUiStore.setState({ selectedAgentByGateway: { 'gw-1': 'team-agent-x' } });
    const { container, unmount } = renderTopBar();

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
    const { container, unmount } = renderTopBar();

    expect(container.textContent, '没有缺失就不许出现提示').not.toContain('agent.missingTitle');
    expect(container.querySelector('[data-testid="assistant-switcher"]')?.textContent).toContain(
      'mainArea.compassAssistant',
    );
    unmount();
  });

  it('⭐ 拒绝态下点「新建任务」：交给待发任务的是**原样的 id**，不是默认助手', () => {
    useUiStore.setState({ selectedAgentByGateway: { 'gw-1': 'team-agent-x' } });
    const { container, unmount } = renderTopBar();

    act(() => (container.querySelector('[data-nav="new-task"]') as HTMLElement).click());

    expect(useTaskStore.getState().pendingNewTask?.agentId, '不许换成默认助手').toBe('team-agent-x');
    unmount();
  });
});

/**
 * 排版重构后的结构契约：页面导航 / 搜索 / 新建任务 / 助手切换 / 个人资料都在顶部，
 * 左侧栏只留「收起按钮 + 任务列表」。
 */
describe('顶部导航栏 + 左侧任务列表（2026-10-28 排版重构）', () => {
  beforeEach(() => {
    window.localStorage.clear();
    setLoadedCatalog(['main']);
    useUiStore.setState({ selectedAgentByGateway: {}, leftNavCollapsed: false, mainView: 'chat' });
    useTaskStore.setState({ tasks: [], activeTaskId: null, pendingNewTask: null });
    useTeamStore.setState({ teams: {}, loadedOnce: true, loading: false });
  });

  it('⭐ 页面导航 / 搜索 / 新建任务 / 助手切换都搬到顶部导航栏', () => {
    const { container, unmount } = renderTopBar();
    expect(container.querySelector('[data-testid="top-nav"]'), '页面导航应在顶部').not.toBeNull();
    expect(container.querySelector('input[placeholder="leftNav.searchTasks"]'), '搜索框应在顶部').not.toBeNull();
    expect(container.querySelector('[data-nav="new-task"]'), '新建任务应在顶部').not.toBeNull();
    expect(container.querySelector('[data-testid="assistant-switcher"]'), '助手切换应在顶部').not.toBeNull();
    unmount();
  });

  it('⭐ 左侧栏只剩「收起按钮 + 任务列表」，不再重复放搜索框/导航', () => {
    const { container, unmount } = render(
      <TooltipProvider>
        <LeftNav />
      </TooltipProvider>,
    );
    expect(container.querySelector('[data-action="toggle-left-nav"]'), '收起按钮仍在左栏').not.toBeNull();
    expect(container.querySelector('input[placeholder="leftNav.searchTasks"]'), '搜索框已从左栏移走').toBeNull();
    expect(container.querySelector('[data-testid="top-nav"]'), '页面导航已从左栏移走').toBeNull();
    unmount();
  });

  it('⭐ 窗口仍可从顶部导航栏拖动（顶栏是 drag，交互控件是 no-drag）', () => {
    const { container, unmount } = renderTopBar();
    const drag = container.querySelector('.titlebar-drag') as HTMLElement | null;
    expect(drag, '拖拽区不许丢').not.toBeNull();
    expect(drag!.querySelector('[data-nav="teams"]'), '导航项要在这条拖拽行里').not.toBeNull();
    unmount();
  });
});
