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
  it('shows restrained next actions and dispatches each selected action', () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const onContinue = vi.fn();
    const onNewTask = vi.fn();
    const onViewUsage = vi.fn();
    const onDismiss = vi.fn();
    const { container, unmount } = render(
      <FirstTaskCompletionCard
        onContinue={onContinue}
        onNewTask={onNewTask}
        onViewUsage={onViewUsage}
        onDismiss={onDismiss}
      />,
    );
    const buttonFor = (text: string) =>
      [...container.querySelectorAll('button')].find((button) => button.textContent?.includes(text));

    expect(container.textContent).toContain('firstTaskCompletion.title');
    expect(container.textContent).toContain('firstTaskCompletion.description');
    act(() => buttonFor('firstTaskCompletion.continue')!.click());
    act(() => buttonFor('firstTaskCompletion.newTask')!.click());
    act(() => buttonFor('firstTaskCompletion.viewUsage')!.click());
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="firstTaskCompletion.dismiss"]')!.click());

    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(onNewTask).toHaveBeenCalledTimes(1);
    expect(onViewUsage).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    unmount();
  });
});
