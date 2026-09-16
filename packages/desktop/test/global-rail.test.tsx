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

import GlobalRail from '../src/renderer/layouts/AppShell/GlobalRail';

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

describe('GlobalRail', () => {
  it('routes every global entry and marks only the active page', () => {
    const onGoHome = vi.fn();
    const onSelectView = vi.fn();
    const onOpenIdentity = vi.fn();
    const onOpenSettings = vi.fn();
    const { container, unmount } = render(
      <GlobalRail
        mainView="files"
        settingsOpen={false}
        activeSettingsSection="general"
        assistantCollapsed={false}
        currentAgentId="main"
        hasUpdate={false}
        onGoHome={onGoHome}
        onSelectView={onSelectView}
        onOpenIdentity={onOpenIdentity}
        onOpenSettings={onOpenSettings}
        onExpandAssistant={vi.fn()}
      />,
    );

    const click = (label: string) => {
      const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
      expect(button).toBeTruthy();
      act(() => button?.click());
    };

    click('leftNav.home');
    click('common.fileManager');
    click('leftNav.usageOverview');
    click('beta.title');
    click('leftNav.identityCenter');
    click('leftNav.appSettings');

    expect(onGoHome).toHaveBeenCalledOnce();
    expect(onSelectView).toHaveBeenNthCalledWith(1, 'files');
    expect(onSelectView).toHaveBeenNthCalledWith(2, 'dashboard');
    expect(onSelectView).toHaveBeenNthCalledWith(3, 'betaHub');
    expect(onOpenIdentity).toHaveBeenCalledOnce();
    expect(onOpenSettings).toHaveBeenCalledOnce();

    const active = [...container.querySelectorAll('button[aria-current="page"]')];
    expect(active).toHaveLength(1);
    expect(active[0]?.getAttribute('aria-label')).toBe('common.fileManager');
    unmount();
  });
});
