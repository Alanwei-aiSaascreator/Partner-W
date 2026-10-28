// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

import FirstTaskCompletionCard from '../src/renderer/components/FirstTaskCompletionCard';

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

describe('FirstTaskCompletionCard', () => {
  it('offers file generation when the active task has no artifacts', () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const onContinue = vi.fn();
    const onNewTask = vi.fn();
    const onViewUsage = vi.fn();
    const onGenerateFile = vi.fn();
    const onViewArtifacts = vi.fn();
    const onDismiss = vi.fn();
    const { container, unmount } = render(
      <FirstTaskCompletionCard
        artifactCount={0}
        onContinue={onContinue}
        onNewTask={onNewTask}
        onViewUsage={onViewUsage}
        onGenerateFile={onGenerateFile}
        onViewArtifacts={onViewArtifacts}
        onDismiss={onDismiss}
      />,
    );
    const buttonFor = (text: string) =>
      [...container.querySelectorAll('button')].find((button) => button.textContent?.includes(text));

    expect(container.textContent).toContain('firstTaskCompletion.title');
    expect(container.textContent).toContain('firstTaskCompletion.description');
    expect(buttonFor('taskWorkbench.generateFile')).toBeDefined();
    expect(buttonFor('taskWorkbench.viewArtifacts')).toBeUndefined();
    act(() => buttonFor('firstTaskCompletion.continue')!.click());
    act(() => buttonFor('firstTaskCompletion.newTask')!.click());
    act(() => buttonFor('firstTaskCompletion.viewUsage')!.click());
    act(() => buttonFor('taskWorkbench.generateFile')!.click());
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="firstTaskCompletion.dismiss"]')!.click());

    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(onNewTask).toHaveBeenCalledTimes(1);
    expect(onViewUsage).toHaveBeenCalledTimes(1);
    expect(onGenerateFile).toHaveBeenCalledTimes(1);
    expect(onViewArtifacts).not.toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('offers artifact viewing instead of generation when the active task has artifacts', () => {
    const onGenerateFile = vi.fn();
    const onViewArtifacts = vi.fn();
    const { container, unmount } = render(
      <FirstTaskCompletionCard
        artifactCount={2}
        onContinue={vi.fn()}
        onNewTask={vi.fn()}
        onViewUsage={vi.fn()}
        onGenerateFile={onGenerateFile}
        onViewArtifacts={onViewArtifacts}
        onDismiss={vi.fn()}
      />,
    );
    const buttons = [...container.querySelectorAll('button')];
    const buttonFor = (text: string) => buttons.find((button) => button.textContent?.includes(text));

    expect(buttonFor('taskWorkbench.generateFile')).toBeUndefined();
    const viewArtifacts = buttonFor('taskWorkbench.viewArtifacts');
    expect(viewArtifacts).toBeDefined();
    act(() => viewArtifacts!.click());

    expect(onViewArtifacts).toHaveBeenCalledTimes(1);
    expect(onGenerateFile).not.toHaveBeenCalled();
    unmount();
  });
});
