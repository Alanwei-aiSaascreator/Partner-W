// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { toastSpy, tSpy, refreshAgentsSpy } = vi.hoisted(() => ({
  toastSpy: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
  tSpy: vi.fn((key: string, _params?: unknown) => key),
  refreshAgentsSpy: vi.fn<(gatewayId: string, options?: { force?: boolean }) => Promise<void>>(async () => undefined),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: tSpy }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));
vi.mock('@/lib/toast', () => ({ toast: toastSpy }));
vi.mock('@/hooks/useGatewayBootstrap', () => ({ fetchAgentsForGateway: refreshAgentsSpy }));

import { useSelectRecommendedAssistant } from '../src/renderer/hooks/useSelectRecommendedAssistant';
import { useUiStore } from '../src/renderer/stores/uiStore';
import { useTaskStore } from '../src/renderer/stores/taskStore';

/**
 * ⭐⭐ 「目标分析推荐的助手」这条入口（2026-09-29）。
 *
 * 这是**第三个**绕过 `resolveRequestedAgent` 判据的入口（另两个在 `IdentityCenter`）：
 * 推荐面板把推荐的 agentId 直接交给 `setSelectedAgent` + `setPending`，
 * 于是用户点的是一个盘上不存在的助手，界面**静默**换成目录里的第一个
 * （也就是「点了 A 进去的是罗盘助手」那一族，`[[team-agent-404-405-brief]]` 的层 2）。
 *
 * ⚠️ 为什么把它抽成 hook：这段判断原来埋在 `MainArea/index.tsx` 的一个 `useCallback` 里，
 * 而渲染整个 `MainArea` 需要网关/启动自检/引导画像一大串状态 —— **没人测得动它**，
 * 所以它是三个入口里唯一一个连测试都没有的。抽出来才守得住。
 */
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let pick!: (agentId: string, gatewayId: string) => Promise<boolean>;
const onDone = vi.fn();

function Probe(): ReactElement {
  pick = useSelectRecommendedAssistant(onDone);
  return <span />;
}

function render(ui: ReactElement): { unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => root.render(ui));
  return {
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

const catalog = (agents: string[]) => ({ agents: agents.map((id) => ({ id }) as never), defaultId: agents[0] ?? '' });

beforeEach(() => {
  vi.clearAllMocks();
  refreshAgentsSpy.mockImplementation(async () => undefined);
  window.localStorage.clear();
  useTaskStore.setState({ pendingNewTask: null, activeTaskId: null });
  useUiStore.setState({
    defaultGatewayId: 'gw-1',
    agentCatalogByGateway: { 'gw-1': catalog(['main', 'partner-w-ecommerce']) },
    selectedAgentByGateway: { 'gw-1': 'main' },
  });
});

describe('useSelectRecommendedAssistant', () => {
  it('⭐ 推荐的助手不在本机 ⇒ 不切、不设待发任务、如实说明', async () => {
    useUiStore.setState({ agentCatalogByGateway: { 'gw-1': catalog(['main']) } });
    const { unmount } = render(<Probe />);

    await act(async () => {
      await pick('team-agent-x', 'gw-1');
    });

    expect(useUiStore.getState().selectedAgentByGateway['gw-1'], '不许静默换人').toBe('main');
    expect(useTaskStore.getState().pendingNewTask, '不许留个开不出来的待发任务').toBeNull();
    expect(onDone, '什么都没做，就别收尾').not.toHaveBeenCalled();
    expect(toastSpy.error, '要如实说明').toHaveBeenCalledWith('agent.missingTitle');
    unmount();
  });

  it('对照：推荐的助手装着 ⇒ 切它、设待发任务、收尾', async () => {
    const { unmount } = render(<Probe />);

    await act(async () => {
      await pick('partner-w-ecommerce', 'gw-1');
    });

    expect(useUiStore.getState().selectedAgentByGateway['gw-1']).toBe('partner-w-ecommerce');
    expect(useTaskStore.getState().pendingNewTask?.agentId).toBe('partner-w-ecommerce');
    expect(onDone).toHaveBeenCalled();
    expect(toastSpy.error).not.toHaveBeenCalled();
    unmount();
  });

  it('⭐ 目录**还没拉回来** ⇒ 刷新完成前零副作用，确认安装后才切', async () => {
    useUiStore.setState({ agentCatalogByGateway: {} });
    let release!: () => void;
    refreshAgentsSpy.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = () => {
            useUiStore.setState({ agentCatalogByGateway: { 'gw-1': catalog(['main', 'partner-w-ecommerce']) } });
            resolve();
          };
        }),
    );
    const { unmount } = render(<Probe />);

    let pending!: Promise<boolean>;
    act(() => {
      pending = pick('partner-w-ecommerce', 'gw-1');
    });
    expect(useUiStore.getState().selectedAgentByGateway['gw-1'], '刷新未完成时不许提前切').toBe('main');
    expect(useTaskStore.getState().pendingNewTask).toBeNull();

    await act(async () => {
      release();
      await pending;
    });

    expect(refreshAgentsSpy).toHaveBeenCalledWith('gw-1', { force: true });
    expect(useUiStore.getState().selectedAgentByGateway['gw-1']).toBe('partner-w-ecommerce');
    expect(toastSpy.error).not.toHaveBeenCalled();
    unmount();
  });

  it('⭐ loading 刷新失败 ⇒ 不切、不设待发、不误报助手缺失', async () => {
    useUiStore.setState({ agentCatalogByGateway: {} });
    refreshAgentsSpy.mockRejectedValueOnce(new Error('offline'));
    const { unmount } = render(<Probe />);

    await act(async () => {
      await pick('partner-w-ecommerce', 'gw-1');
    });

    expect(useUiStore.getState().selectedAgentByGateway['gw-1']).toBe('main');
    expect(useTaskStore.getState().pendingNewTask).toBeNull();
    expect(onDone).not.toHaveBeenCalled();
    expect(toastSpy.error).toHaveBeenCalledWith('errors.failed');
    unmount();
  });

  /**
   * ⭐⭐ **刚建好的助手不许被拒**（2026-09-29 自查抓到的真错）。
   *
   * `MainArea.handleCreateCustomAssistant` 的时序是：
   * `await fetchAgentsForGateway(force)` → **立刻**调这个 handler。
   * 而**正在执行的那个闭包是上一次渲染时的** —— 它捕获的目录是**刷新前**的，
   * 于是"刚创建出来的助手"会被判成"不在本机"、被拒绝，
   * 用户看到的是「这个助手不在本机」：**他刚建好就被告知不存在**。
   *
   * ⇒ 判据必须**在调用那一刻**读 store（`getState()`），不能读渲染时捕获的那份。
   */
  it('⭐ 目录在本轮渲染之后才更新（刚建完助手）⇒ 必须按**最新**目录判，不许拒绝', async () => {
    const { unmount } = render(<Probe />);

    /**
     * ⚠️ 关键是**先抓住当前这个闭包，再更新目录** —— 真实代码正是这么调的：
     * `handleCreateCustomAssistant` 里 `await fetchAgentsForGateway(force)` 之后调的是
     * **它自己闭包里那个** `handleSelectRecommendedAssistant`（上一轮渲染的），
     * 即使 store 已更新、组件已重渲，那个局部变量**仍然指向旧的**。
     *
     * （我第一版没抓住闭包，ProbE 每次渲染都会重写 `pick`，
     *   于是测到的是新回调 —— 测试**通过了**，但那个通过是假的。）
     */
    const captured = pick;
    act(() => {
      useUiStore.setState({ agentCatalogByGateway: { 'gw-1': catalog(['main', 'brand-new-agent']) } });
    });

    await act(async () => {
      await captured('brand-new-agent', 'gw-1');
    });

    expect(toastSpy.error, '刚建好的助手被判成"不在本机" = 告诉他创建失败了').not.toHaveBeenCalled();
    expect(useUiStore.getState().selectedAgentByGateway['gw-1']).toBe('brand-new-agent');
    expect(onDone).toHaveBeenCalled();
    unmount();
  });

  it('⭐ 在途期间默认网关从 gw-1 切到 gw-2，仍必须把助手和待发任务留在 gw-1', async () => {
    useUiStore.setState({
      agentCatalogByGateway: {
        'gw-1': catalog(['main', 'brand-new-agent']),
        'gw-2': catalog(['main', 'brand-new-agent']),
      },
      selectedAgentByGateway: { 'gw-1': 'main', 'gw-2': 'main' },
    });
    const { unmount } = render(<Probe />);
    const captured = pick;
    act(() => useUiStore.setState({ defaultGatewayId: 'gw-2' }));

    await act(async () => {
      await captured('brand-new-agent', 'gw-1');
    });

    expect(useUiStore.getState().selectedAgentByGateway['gw-1']).toBe('brand-new-agent');
    expect(useUiStore.getState().selectedAgentByGateway['gw-2']).toBe('main');
    expect(useTaskStore.getState().pendingNewTask).toMatchObject({ gatewayId: 'gw-1', agentId: 'brand-new-agent' });
    unmount();
  });
});
