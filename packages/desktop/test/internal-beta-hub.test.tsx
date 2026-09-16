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

async function flushAsync(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('InternalBetaHub', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    localStorage.clear();
    window.history.replaceState(null, '', '#/');
    act(() => useBetaStore.getState().resetDemo());
    (window as unknown as { clawwork: Record<string, unknown> }).clawwork = {
      getAppVersion: vi.fn().mockResolvedValue('1.0.0'),
      checkForUpdates: vi.fn().mockResolvedValue({
        hasUpdate: true,
        currentVersion: '1.0.0',
        latestVersion: '1.1.0',
        releaseUrl: 'https://example.com/release',
        releaseNotes: '修复文件交付问题',
      }),
      downloadUpdate: vi.fn().mockResolvedValue({ ok: true }),
      installUpdate: vi.fn().mockResolvedValue({ ok: true }),
      onUpdateDownloadProgress: vi.fn(() => vi.fn()),
      onUpdateDownloaded: vi.fn(() => vi.fn()),
      onUpdateError: vi.fn(() => vi.fn()),
    };
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

  it('uses the Electron updater and shows the real available version', async () => {
    useBetaStore.getState().setActiveModule('updates');
    const { container, unmount } = render(<InternalBetaHub />);
    act(() => container.querySelector<HTMLButtonElement>('[data-action="check-update"]')?.click());
    await flushAsync();
    expect(window.clawwork.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('1.1.0');
    expect(container.textContent).not.toContain('内测模拟升级');
    unmount();
  });

  it('opens only the configured admin console URL', () => {
    useBetaStore.getState().setActiveModule('operations');
    const first = render(<InternalBetaHub />);
    const disabled = first.container.querySelector<HTMLButtonElement>('[data-action="open-admin"]')!;
    expect(disabled.disabled).toBe(true);
    first.unmount();

    vi.stubEnv('VITE_ADMIN_CONSOLE_URL', 'https://admin.example.com/console');
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const second = render(<InternalBetaHub />);
    const enabled = second.container.querySelector<HTMLButtonElement>('[data-action="open-admin"]')!;
    expect(enabled.disabled).toBe(false);
    act(() => enabled.click());
    expect(open).toHaveBeenCalledWith('https://admin.example.com/console', '_blank', 'noopener,noreferrer');
    second.unmount();
  });
});
