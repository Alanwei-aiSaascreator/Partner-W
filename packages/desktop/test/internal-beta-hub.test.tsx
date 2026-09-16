// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

import InternalBetaHub from '../src/renderer/features/internal-beta/InternalBetaHub';
import { useBetaStore } from '../src/renderer/features/internal-beta/beta-store';

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

function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('InternalBetaHub', () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState(null, '', '#/');
    act(() => useBetaStore.getState().resetDemo());
  });

  it('exposes every company beta module as direct navigation', () => {
    const { container, unmount } = render(<InternalBetaHub />);
    for (const id of [
      'team',
      'market',
      'bounty',
      'square',
      'creator',
      'game',
      'operations',
      'updates',
      'analytics',
      'compliance',
    ]) {
      expect(container.querySelector(`[data-module="${id}"]`)).toBeTruthy();
    }
    unmount();
  });

  it('allows creating a team and then exposes its invite code', () => {
    const { container, unmount } = render(<InternalBetaHub />);
    const input = container.querySelector<HTMLInputElement>('[aria-label="beta.teamName"]')!;
    act(() => {
      typeInto(input, '销售一组');
    });
    act(() => container.querySelector<HTMLButtonElement>('[data-action="create-team"]')?.click());
    expect(container.textContent).toContain('销售一组');
    expect(container.querySelector('[data-invite-code]')).toBeTruthy();
    unmount();
  });

  it('moves update simulation through checking and available states', () => {
    useBetaStore.getState().setActiveModule('updates');
    const { container, unmount } = render(<InternalBetaHub />);
    act(() => container.querySelector<HTMLButtonElement>('[data-action="check-update"]')?.click());
    expect(useBetaStore.getState().update.status).toBe('available');
    expect(container.textContent).toContain('1.0.1-beta');
    unmount();
  });
});
