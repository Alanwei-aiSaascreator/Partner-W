// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactElement }) => children,
  TooltipTrigger: ({ children }: { children: ReactElement }) => children,
  TooltipContent: ({ children }: { children: ReactElement }) => children,
}));

import LeftNavPrimaryLinks from '../src/renderer/layouts/LeftNav/PrimaryLinks';

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

describe('LeftNavPrimaryLinks', () => {
  it('opens the usage overview from the expanded navigation', () => {
    const onSelect = vi.fn();
    const { container, unmount } = render(
      <LeftNavPrimaryLinks collapsed={false} mainView="chat" onSelect={onSelect} />,
    );

    const usageButton = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('leftNav.usageOverview'),
    );
    expect(usageButton).toBeTruthy();
    act(() => usageButton?.click());
    expect(onSelect).toHaveBeenCalledWith('dashboard');
    unmount();
  });

  it('keeps an accessible active entry when the navigation is collapsed', () => {
    const { container, unmount } = render(<LeftNavPrimaryLinks collapsed mainView="dashboard" onSelect={vi.fn()} />);

    const usageButton = container.querySelector<HTMLButtonElement>('button[aria-label="leftNav.usageOverview"]');
    expect(usageButton).toBeTruthy();
    expect(usageButton?.className).toContain('accent-dim');
    unmount();
  });
});
