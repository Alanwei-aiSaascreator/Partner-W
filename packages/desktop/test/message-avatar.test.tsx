// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MessageAvatar from '../src/renderer/components/MessageAvatar';

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

describe('MessageAvatar local avatar lookup', () => {
  const listLocalAvatars = vi.fn();

  beforeEach(() => {
    listLocalAvatars.mockReset();
    Object.defineProperty(window, 'clawwork', {
      configurable: true,
      value: { listLocalAvatars },
    });
  });

  it('does not request a missing local avatar before falling back to the gateway avatar', async () => {
    listLocalAvatars.mockResolvedValue({ ok: true, result: [] });
    const view = render(
      <MessageAvatar
        role="assistant"
        localAvatarUrl="clawwork-avatar://gw/writer"
        gatewayAvatarUrl="https://example.test/writer.png"
      />,
    );

    await act(async () => Promise.resolve());

    expect(view.container.querySelector('img')?.getAttribute('src')).toBe('https://example.test/writer.png');
    expect(view.container.innerHTML).not.toContain('clawwork-avatar://');
    view.unmount();
  });

  it('uses the local protocol URL only after the main process confirms the file exists', async () => {
    listLocalAvatars.mockResolvedValue({ ok: true, result: ['writer'] });
    const view = render(
      <MessageAvatar role="assistant" localAvatarUrl="clawwork-avatar://gw/writer" agentEmoji="✍️" />,
    );

    await act(async () => Promise.resolve());

    expect(view.container.querySelector('img')?.getAttribute('src')).toBe('clawwork-avatar://gw/writer');
    view.unmount();
  });
});
