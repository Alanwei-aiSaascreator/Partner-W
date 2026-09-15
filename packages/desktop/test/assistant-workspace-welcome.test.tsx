// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { resolveAssistantWorkspace } from '../src/renderer/lib/preset-agents';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

import AssistantWorkspaceWelcome from '../src/renderer/layouts/MainArea/AssistantWorkspaceWelcome';

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

describe('AssistantWorkspaceWelcome', () => {
  it('renders only the selected assistant identity and its four starters', () => {
    const definition = resolveAssistantWorkspace('rongying-content')!;
    const onSelectPrompt = vi.fn();
    const onAddFiles = vi.fn();
    const onAddFolder = vi.fn();
    const { container, unmount } = render(
      <AssistantWorkspaceWelcome
        definition={definition}
        modelLabel="DeepSeek V4 Flash"
        ready
        onSelectPrompt={onSelectPrompt}
        onAddFiles={onAddFiles}
        onAddFolder={onAddFolder}
      />,
    );

    expect(container.textContent).toContain('presetAgents.roles.content');
    expect(container.textContent).toContain('assistantWorkspaces.content.description');
    expect(container.textContent).not.toContain('assistantWorkspaces.ecommerce.description');
    const starterButtons = container.querySelectorAll('[data-testid="assistant-starter"]');
    expect(starterButtons).toHaveLength(4);
    expect(container.textContent).toContain('DeepSeek V4 Flash');
    expect(container.textContent).toContain('startupReadiness.aiReady');

    act(() => (starterButtons[0] as HTMLButtonElement).click());
    expect(onSelectPrompt).toHaveBeenCalledWith('assistantWorkspaces.content.starters.1.prompt');
    act(() => (container.querySelector('[data-testid="welcome-add-files"]') as HTMLButtonElement).click());
    act(() => (container.querySelector('[data-testid="welcome-add-folder"]') as HTMLButtonElement).click());
    expect(onAddFiles).toHaveBeenCalledTimes(1);
    expect(onAddFolder).toHaveBeenCalledTimes(1);
    unmount();
  });
});
