// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// 只把**拉目录的网络那一下**掐掉；被测的是真 hook、真 store。
vi.mock('@/hooks/useGatewayBootstrap', () => ({
  fetchAgentsForGateway: vi.fn(async () => undefined),
}));

import { useGatewaySelector } from '../src/renderer/hooks/useGatewaySelector';
import { useUiStore } from '../src/renderer/platform';

let captured: ReturnType<typeof useGatewaySelector> | null = null;

/**
 * ⚠️ 两个参数是**两件事**，harness 特意都露出来，免得测试把区别掩盖掉：
 * - `initialAgentId` = "先选中哪个"（可以含推荐/默认的成分）
 * - `requestedAgentId` = **用户点名要的**那个（只有它参与"拒绝并说明"）
 */
function Harness({ initialAgentId, requestedAgentId }: { initialAgentId: string; requestedAgentId?: string }) {
  captured = useGatewaySelector({ initialGatewayId: 'gw-1', initialAgentId, requestedAgentId });
  return null;
}

function render(node: ReactElement): { rerender: (next: ReactElement) => void; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => root.render(node));
  return {
    rerender: (next) => act(() => root.render(next)),
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function setCatalog(agents: string[], defaultId: string): void {
  act(() => {
    useUiStore.setState({
      agentCatalogByGateway: {
        'gw-1': { agents: agents.map((id) => ({ id })) as never, defaultId },
      },
    });
  });
}

describe('useGatewaySelector 拒绝不在本机的请求', () => {
  it('honors a newly requested team manager when the selector remains mounted', () => {
    setCatalog(['main', 'finance-lead'], 'main');
    const view = render(<Harness initialAgentId="main" requestedAgentId="main" />);
    view.rerender(<Harness initialAgentId="finance-lead" requestedAgentId="finance-lead" />);
    expect(captured?.effectiveAgentId).toBe('finance-lead');
    view.unmount();
  });

  it('honors the latest requested manager after a same-gateway catalog arrives late', () => {
    act(() => useUiStore.setState({ agentCatalogByGateway: {} }));
    const view = render(<Harness initialAgentId="main" requestedAgentId="main" />);
    view.rerender(<Harness initialAgentId="finance-lead" requestedAgentId="finance-lead" />);
    expect(captured?.effectiveAgentId).toBe('');
    setCatalog(['main', 'finance-lead'], 'main');
    expect(captured?.effectiveAgentId).toBe('finance-lead');
    view.unmount();
  });

  beforeEach(() => {
    captured = null;
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  it('目录已加载时，请求缺失 ⇒ effectiveAgentId 空、missingRequestedAgentId 有值', () => {
    setCatalog(['main'], 'main');
    const view = render(<Harness initialAgentId="team-agent-x" requestedAgentId="team-agent-x" />);

    expect(captured?.missingRequestedAgentId).toBe('team-agent-x');
    expect(captured?.effectiveAgentId).toBe('');
    view.unmount();
  });

  it('目录还没加载时不许判缺失（行为与今天一字不变）', () => {
    act(() => useUiStore.setState({ agentCatalogByGateway: {} }));
    const view = render(<Harness initialAgentId="team-agent-x" requestedAgentId="team-agent-x" />);

    expect(captured?.missingRequestedAgentId).toBeNull();
    expect(captured?.effectiveAgentId).toBe('');
    view.unmount();
  });

  it('请求在目录里 ⇒ 原样生效，不判缺失', () => {
    setCatalog(['main', 'rongying-video'], 'main');
    const view = render(<Harness initialAgentId="rongying-video" requestedAgentId="rongying-video" />);

    expect(captured?.missingRequestedAgentId).toBeNull();
    expect(captured?.effectiveAgentId).toBe('rongying-video');
    view.unmount();
  });

  /**
   * ⭐⭐ 2026-09-24 独立复核抓到的**误报**（I-1）。
   *
   * 新机器上引导画像会**推荐**一个预置助手，而预置助手是"启动时补装"的：目录已经拉回来、
   * 那个助手还在装的那几十秒里，如果把推荐当成"用户点名要的"，界面就会说
   * 「这个助手不在本机」—— 而它马上就会出现。**推荐不是请求，不参与拒绝。**
   */
  it('⭐ 只有推荐（不是请求）缺失 ⇒ 不算缺失、不误报，照旧回落到默认助手', () => {
    setCatalog(['main'], 'main');
    const view = render(<Harness initialAgentId="rongying-video" />);

    expect(captured?.missingRequestedAgentId, '推荐缺失不许报"不在本机"').toBeNull();
    expect(captured?.effectiveAgentId, '与改动前一致：回落到默认助手').toBe('main');
    view.unmount();
  });

  it('⭐ 目录刷新后请求出现 ⇒ 缺失标记消失（装完了提示就该走）', () => {
    setCatalog(['main'], 'main');
    const ui = () => <Harness initialAgentId="team-agent-x" requestedAgentId="team-agent-x" />;
    const view = render(ui());
    expect(captured?.missingRequestedAgentId).toBe('team-agent-x');

    setCatalog(['main', 'team-agent-x'], 'main');
    view.rerender(ui());

    expect(captured?.missingRequestedAgentId, '目录里已经有了就不许还挂着提示').toBeNull();
    expect(captured?.effectiveAgentId).toBe('team-agent-x');
    view.unmount();
  });

  /**
   * ⭐ 2026-09-24（独立复核 M-6）：选中的网关从列表里消失时，hook 会**内部**回落换网关，
   * 而请求自带的是**旧**网关。两者不一致时拿新网关的目录去判旧网关的请求，就会把
   * "不在**这个**网关上"说成"不在**本机**"。判不了就不判。
   */
  it('⭐ 回落换网关后，不许拿新网关的目录去判旧网关的请求', () => {
    setCatalog(['main'], 'main');
    const ui = () => <Harness initialAgentId="team-agent-x" requestedAgentId="team-agent-x" />;
    const view = render(ui());
    expect(captured?.missingRequestedAgentId).toBe('team-agent-x');

    // 只留下 gw-2，且 gw-2 的目录**也加载过**（只有 main）—— 这才是会误报的形状：
    // 请求属于 gw-1，闸门一旦关掉就会被 gw-2 的目录判成 missing，于是又说一遍"不在本机"。
    // ⚠️ 第一版这条用例把 gw-2 的目录留成"未加载"，于是走的是 loading 路 ⇒ 任何实现都绿 ——
    //    变异电池当场证伪（2026-09-24，R2 未命中），才改成现在这个形状。
    act(() => {
      useUiStore.setState({
        gatewayInfoMap: { 'gw-2': { id: 'gw-2' } } as never,
        defaultGatewayId: 'gw-2',
        agentCatalogByGateway: {
          'gw-1': { agents: [{ id: 'main' }], defaultId: 'main' },
          'gw-2': { agents: [{ id: 'main' }], defaultId: 'main' },
        } as never,
      });
    });
    view.rerender(ui());

    expect(captured?.selectedGwId).toBe('gw-2');
    expect(captured?.missingRequestedAgentId, '属于旧网关的选择不许拿新网关的目录来判').toBeNull();
    // ⚠️ 这里**刻意不**断言 `effectiveAgentId`：它落回**当前网关**的默认助手，
    //    而那半边是**既有行为**（由 `welcome-screen.test.tsx` 的 "uses the destination gateway
    //    default label before stale pending state is normalized" 钉住）。复核建议把它也压成
    //    空串，实测会让那条既有用例红，且"网关本身没了"时用户会更糟 —— 已登记为待拍（见账本）。
    view.unmount();
  });

  /**
   * ⭐ 2026-10-07（质检 P2-2）：默认当前助手 = 网关给的 defaultId（须在目录里）→
   * **缺省固定主罗盘**。老写法 `gwAgents?.defaultId ?? agentCatalog[0]?.id` 会在网关
   * 没给默认值时把**目录里的第一个**能力助手当成默认 —— 与「默认=主罗盘」契约相悖。
   */
  it('⭐ 网关没给默认值时，不拿"目录第一个"顶替：默认固定主罗盘', () => {
    // ⚠️ 这组用例要**显式**钉住网关与目录（上一条用例把 gatewayInfoMap 改成了 gw-2；
    //    只 setCatalog 的话 hook 会把 selectedGwId 回落到 gw-2、读到空目录）。
    act(() => {
      useUiStore.setState({
        gatewayInfoMap: { 'gw-1': { id: 'gw-1' } } as never,
        defaultGatewayId: 'gw-1',
        // 目录顺序刻意把能力助手放前面：老实现（目录第一个）会选它。
        agentCatalogByGateway: {
          'gw-1': { agents: [{ id: 'rongying-content' }, { id: 'main' }], defaultId: '' },
        } as never,
      });
    });
    const view = render(<Harness initialAgentId="" />);

    expect(captured?.defaultAgentId).toBe('main');
    expect(captured?.effectiveAgentId).toBe('main');
    view.unmount();
  });

  it('⭐ 目录里根本没有主罗盘时不冒充：默认留空（effectiveAgentId 也留空）', () => {
    act(() => {
      useUiStore.setState({
        gatewayInfoMap: { 'gw-1': { id: 'gw-1' } } as never,
        defaultGatewayId: 'gw-1',
        agentCatalogByGateway: {
          'gw-1': { agents: [{ id: 'rongying-content' }, { id: 'rongying-video' }], defaultId: '' },
        } as never,
      });
    });
    const view = render(<Harness initialAgentId="" />);

    expect(captured?.defaultAgentId).toBe('');
    expect(captured?.effectiveAgentId).toBe('');
    view.unmount();
  });
});
