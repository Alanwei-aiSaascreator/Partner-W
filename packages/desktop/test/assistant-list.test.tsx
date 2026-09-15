// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

import AssistantList from '../src/renderer/layouts/LeftNav/AssistantList';

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

describe('AssistantList', () => {
  it('keeps every assistant visible and marks the current assistant', () => {
    const onSelect = vi.fn();
    const { container, unmount } = render(
      <AssistantList
        agents={[
          { id: 'main', name: 'Main' },
          { id: 'rongying-video', name: 'Video' },
          { id: 'custom-helper', name: 'Custom helper' },
        ]}
        selectedAgentId="rongying-video"
        onSelect={onSelect}
      />,
    );

    expect(container.textContent).toContain('mainArea.compassAssistant');
    expect(container.textContent).toContain('presetAgents.roles.video');
    expect(container.textContent).toContain('Custom helper');

    const current = container.querySelector<HTMLButtonElement>('button[aria-current="page"]');
    expect(current?.textContent).toContain('presetAgents.roles.video');

    const custom = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Custom helper'),
    );
    act(() => custom?.click());
    expect(onSelect).toHaveBeenCalledWith('custom-helper');
    unmount();
  });
});
