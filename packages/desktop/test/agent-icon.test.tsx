// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AgentIcon from '../src/renderer/components/AgentIcon';

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

describe('AgentIcon local avatar lookup', () => {
  const listLocalAvatars = vi.fn();

  beforeEach(() => {
    listLocalAvatars.mockReset();
    Object.defineProperty(window, 'clawwork', {
      configurable: true,
      value: { listLocalAvatars },
    });
  });

  it('本地没有头像时直接用网关头像，不请求必然 404 的 clawwork-avatar URL', async () => {
    listLocalAvatars.mockResolvedValue({ ok: true, result: [] });
    const view = render(
      <AgentIcon gatewayId="gw" agentId="writer" gatewayAvatarUrl="https://example.test/writer.png" />,
    );

    await act(async () => Promise.resolve());

    expect(view.container.querySelector('img')?.getAttribute('src')).toBe('https://example.test/writer.png');
    expect(view.container.innerHTML).not.toContain('clawwork-avatar://');
    view.unmount();
  });

  it('目录确认本地头像存在后才使用自定义协议 URL', async () => {
    listLocalAvatars.mockResolvedValue({ ok: true, result: ['writer'] });
    const view = render(<AgentIcon gatewayId="gw" agentId="writer" emoji="✍️" />);

    await act(async () => Promise.resolve());

    expect(view.container.querySelector('img')?.getAttribute('src')).toBe('clawwork-avatar://gw/writer');
    view.unmount();
  });

  it.each([
    ['main', undefined, 'lucide-compass'],
    ['rongying-content', undefined, 'lucide-pen-line'],
    ['rongying-video', undefined, 'lucide-clapperboard'],
    ['member', 'moderator', 'lucide-network'],
    ['member', 'challenger', 'lucide-shield-check'],
    ['member', 'scribe', 'lucide-notebook-pen'],
  ] as const)('uses a recognizable role icon for %s/%s without custom identity', (agentId, position, iconClass) => {
    const view = render(<AgentIcon agentId={agentId} position={position} />);
    expect(view.container.querySelector(`.${iconClass}`)).not.toBeNull();
    view.unmount();
  });

  it('keeps custom emoji ahead of the role fallback', () => {
    const view = render(<AgentIcon agentId="main" emoji="X" />);
    expect(view.container.textContent).toBe('X');
    expect(view.container.querySelector('svg')).toBeNull();
    view.unmount();
  });

  it('does not treat object prototype names as preset icons', () => {
    const view = render(<AgentIcon agentId="constructor" />);
    expect(view.container.querySelector('.lucide-bot')).not.toBeNull();
    view.unmount();
  });
});
