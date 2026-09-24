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

function Harness({ initialAgentId }: { initialAgentId: string }) {
  captured = useGatewaySelector({ initialGatewayId: 'gw-1', initialAgentId });
  return null;
}

function render(node: ReactElement): { unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => root.render(node));
  return {
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function setCatalog(agents: string[], defaultId: string): void {
  useUiStore.setState({
    agentCatalogByGateway: {
      'gw-1': { agents: agents.map((id) => ({ id })) as never, defaultId },
    },
  });
}

describe('useGatewaySelector 拒绝不在本机的请求', () => {
  beforeEach(() => {
    captured = null;
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  it('目录已加载时，请求缺失 ⇒ effectiveAgentId 空、missingRequestedAgentId 有值', () => {
    setCatalog(['main'], 'main');
    const view = render(<Harness initialAgentId="team-agent-x" />);

    expect(captured?.missingRequestedAgentId).toBe('team-agent-x');
    expect(captured?.effectiveAgentId).toBe('');
    view.unmount();
  });

  it('目录还没加载时不许判缺失（行为与今天一字不变）', () => {
    useUiStore.setState({ agentCatalogByGateway: {} });
    const view = render(<Harness initialAgentId="team-agent-x" />);

    expect(captured?.missingRequestedAgentId).toBeNull();
    expect(captured?.effectiveAgentId).toBe('');
    view.unmount();
  });

  it('请求在目录里 ⇒ 原样生效，不判缺失', () => {
    setCatalog(['main', 'rongying-video'], 'main');
    const view = render(<Harness initialAgentId="rongying-video" />);

    expect(captured?.missingRequestedAgentId).toBeNull();
    expect(captured?.effectiveAgentId).toBe('rongying-video');
    view.unmount();
  });
});
