// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

import PresetAgentPackControl from '../src/renderer/layouts/MainArea/PresetAgentPackControl';

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

describe('PresetAgentPackControl', () => {
  it('starts setup from the ready state', () => {
    const onInstall = vi.fn();
    const { container, unmount } = render(
      <PresetAgentPackControl status="ready" missingCount={6} completed={0} total={6} onInstall={onInstall} />,
    );

    const button = container.querySelector('button');
    expect(button?.textContent).toContain('presetAgents.install');
    act(() => button?.click());
    expect(onInstall).toHaveBeenCalledOnce();
    unmount();
  });

  it('disables the action while installing', () => {
    const { container, unmount } = render(
      <PresetAgentPackControl status="installing" missingCount={4} completed={2} total={6} onInstall={vi.fn()} />,
    );

    const button = container.querySelector('button');
    expect(button?.disabled).toBe(true);
    expect(button?.textContent).toContain('presetAgents.installing');
    unmount();
  });

  it('offers retry after an incomplete setup', () => {
    const { container, unmount } = render(
      <PresetAgentPackControl
        status="incomplete"
        missingCount={2}
        completed={6}
        total={6}
        error="write denied"
        onInstall={vi.fn()}
      />,
    );

    expect(container.textContent).toContain('presetAgents.incomplete');
    expect(container.querySelector('button')?.textContent).toContain('presetAgents.retry');
    unmount();
  });
});
