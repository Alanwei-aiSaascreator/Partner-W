// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

import Onboarding from '../src/renderer/layouts/Onboarding';

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

describe('Onboarding', () => {
  it('lets a user choose several purposes and complete setup', () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const onComplete = vi.fn();
    const { container, unmount } = render(
      <Onboarding userId="user-1" defaultNickname="小荣" onComplete={onComplete} />,
    );

    const buttonFor = (key: string) =>
      [...container.querySelectorAll('button')].find((button) => button.textContent?.includes(key));

    act(() => {
      buttonFor('onboarding.useCases.content.title')!.click();
      buttonFor('onboarding.useCases.video.title')!.click();
    });
    act(() => {
      buttonFor('onboarding.continue')!.click();
    });

    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        version: 1,
        userId: 'user-1',
        nickname: '小荣',
        useCases: ['content', 'video'],
      }),
    );
    unmount();
  });
});
