// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntryPreparationFacts } from '../src/renderer/lib/entry-preparation';
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));
import EntryPreparation from '../src/renderer/layouts/EntryPreparation';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const facts: EntryPreparationFacts = {
  scopeKey: 'A',
  currentScopeKey: 'A',
  accountUserId: 'A',
  entitlement: { userId: 'A', licenseId: 'L', orgId: 'O', status: 'active', expiresAt: null },
  runtime: { ok: true },
  startup: {
    gatewayId: 'local-runtime',
    relayPhase: 'ready',
    ai: { phase: 'ready' },
    assistants: { phase: 'ready', completed: 6, total: 6, missingIds: [] },
    workspaceAvailable: true,
    conversationReady: true,
    isReady: true,
    hasError: false,
    composerBlocked: false,
  },
};
const disposers: (() => void)[] = [];
function render(ui: ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(ui));
  disposers.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return { container, rerender: (ui: ReactElement) => act(() => root.render(ui)) };
}
const callbacks = () => ({
  onContinue: vi.fn(async () => {}),
  onRetry: vi.fn(async () => {}),
  onChangeAccount: vi.fn(async () => {}),
  onChooseWorkspace: vi.fn(),
});
afterEach(() => {
  disposers.splice(0).forEach((fn) => fn());
  vi.useRealTimers();
});
describe('EntryPreparation', () => {
  it('keeps continue disabled after time and animation completion without actual relay readiness', async () => {
    vi.useFakeTimers();
    const cb = callbacks();
    const pending = { ...facts, startup: { ...facts.startup, relayPhase: 'running' as const } };
    const { container } = render(<EntryPreparation facts={pending} {...cb} />);
    const button = container.querySelector<HTMLButtonElement>('[data-entry-continue]');
    expect(button).not.toBeNull();
    expect(button?.disabled).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(120000);
      container.querySelector('[data-entry-animation]')?.dispatchEvent(new Event('animationend', { bubbles: true }));
    });
    expect(button?.disabled).toBe(true);
    expect(cb.onContinue).not.toHaveBeenCalled();
  });
  it('shows ready without auto navigation and waits for explicit continue', async () => {
    const cb = callbacks();
    const { container } = render(<EntryPreparation facts={facts} {...cb} />);
    expect(container.textContent).toContain('entryPreparation.ready');
    expect(cb.onContinue).not.toHaveBeenCalled();
    const button = container.querySelector<HTMLButtonElement>('[data-entry-continue]');
    expect(button?.disabled).toBe(false);
    await act(async () => button?.click());
    expect(cb.onContinue).toHaveBeenCalledTimes(1);
  });
  it.each([
    'process-exited',
    'ready-timeout',
    'port-occupied',
    'auth-rejected',
    'state-migration-blocked',
    'unknown',
  ] as const)('shows %s with a real restart instruction instead of ineffective retry', async (reason) => {
    const cb = callbacks();
    const failed = { ...facts, runtime: { ok: false as const, reason } };
    const { container } = render(<EntryPreparation facts={failed} {...cb} />);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('entryPreparation.runtimeRestartRequired');
    expect(container.textContent).toContain('entryPreparation.needsAttention');
    expect(container.querySelector('[data-entry-retry]')).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('[data-entry-continue]')?.disabled).toBe(true);
    expect(cb.onRetry).not.toHaveBeenCalled();
    expect(container.querySelector('[data-entry-account]')).not.toBeNull();
    expect(container.querySelector('[data-entry-workspace]')).not.toBeNull();
  });
  it('keeps retry available for service configuration failures after a successful local boot', async () => {
    const cb = callbacks();
    const failed = {
      ...facts,
      startup: {
        ...facts.startup,
        relayPhase: 'retryable-error' as const,
        relayFailure: { kind: 'retryable' as const, errorCode: 'transport' as const },
      },
    };
    const { container } = render(<EntryPreparation facts={failed} {...cb} />);
    await act(async () => container.querySelector<HTMLButtonElement>('[data-entry-retry]')?.click());
    expect(cb.onRetry).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="alert"]')?.textContent).not.toContain(
      'entryPreparation.runtimeRestartRequired',
    );
  });
  it('keeps the known runtime cause when a concurrent final check rejects', async () => {
    const cb = callbacks();
    let reject!: (reason: Error) => void;
    cb.onContinue.mockImplementationOnce(
      () =>
        new Promise<void>((_, r) => {
          reject = r;
        }),
    );
    const { container, rerender } = render(<EntryPreparation facts={facts} {...cb} />);
    await act(async () => container.querySelector<HTMLButtonElement>('[data-entry-continue]')?.click());
    rerender(<EntryPreparation facts={{ ...facts, runtime: { ok: false, reason: 'port-occupied' } }} {...cb} />);
    await act(async () => reject(new Error('private check failure')));
    const alert = container.querySelector('[role="alert"]')?.textContent;
    expect(alert).toContain('startupReadiness.gatewayPortOccupied');
    expect(alert).toContain('entryPreparation.runtimeRestartRequired');
    expect(alert).not.toContain('entryPreparation.recheckFailed');
    expect(alert).not.toContain('private check failure');
    expect(container.querySelector('[data-entry-retry]')).toBeNull();
  });
  it('rejects a failed final recheck without leaving and releases the button for retry', async () => {
    const cb = callbacks();
    cb.onContinue.mockRejectedValueOnce(new Error('private backend detail'));
    const { container } = render(<EntryPreparation facts={facts} {...cb} />);
    await act(async () => container.querySelector<HTMLButtonElement>('[data-entry-continue]')?.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('entryPreparation.recheckFailed');
    expect(container.textContent).not.toContain('private backend detail');
    expect(container.querySelector<HTMLButtonElement>('[data-entry-continue]')?.disabled).toBe(false);
  });
});

it('clears old busy state on scope replacement and ignores the old action completion', async () => {
  const cb = callbacks();
  let resolve!: () => void;
  cb.onContinue.mockImplementationOnce(
    () =>
      new Promise<void>((r) => {
        resolve = r;
      }),
  );
  const { container, rerender } = render(<EntryPreparation facts={facts} {...cb} />);
  await act(async () => container.querySelector<HTMLButtonElement>('[data-entry-continue]')?.click());
  const factsB = { ...facts, scopeKey: 'B', currentScopeKey: 'B' };
  rerender(<EntryPreparation facts={factsB} {...cb} />);
  expect(container.querySelector<HTMLButtonElement>('[data-entry-continue]')?.disabled).toBe(false);
  await act(async () => resolve());
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
