// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { StartupReadiness } from '../src/renderer/lib/startup-readiness';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${Object.values(options).join('|')}` : key,
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

import StartupReadinessScreen from '../src/renderer/layouts/StartupReadiness';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const baseReadiness: StartupReadiness = {
  gatewayId: 'gw-1',
  ai: { phase: 'starting' },
  assistants: {
    phase: 'waiting',
    completed: 0,
    total: 6,
    missingIds: [],
  },
  workspaceAvailable: true,
  conversationReady: false,
  isReady: false,
  hasError: false,
};

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

describe('StartupReadinessScreen', () => {
  it('explains AI startup and exposes a busy state', () => {
    const { container, unmount } = render(<StartupReadinessScreen readiness={baseReadiness} onRetry={vi.fn()} />);

    expect(container.firstElementChild?.getAttribute('aria-busy')).toBe('true');
    expect(container.textContent).toContain('startupReadiness.aiStarting');
    expect(container.textContent).toContain('startupReadiness.assistantsWaiting');
    unmount();
  });

  it('renders the real assistant count and current localized role', () => {
    const readiness: StartupReadiness = {
      ...baseReadiness,
      ai: { phase: 'ready' },
      assistants: {
        phase: 'installing',
        completed: 2,
        total: 6,
        currentId: 'rongying-office',
        missingIds: ['rongying-office'],
      },
    };
    const { container, unmount } = render(<StartupReadinessScreen readiness={readiness} onRetry={vi.fn()} />);
    const progress = container.querySelector('[role="progressbar"]');

    expect(progress?.getAttribute('aria-valuenow')).toBe('2');
    expect(progress?.getAttribute('aria-valuemax')).toBe('6');
    expect(container.textContent).toContain('presetAgents.roles.office');
    unmount();
  });

  it('names missing roles and retries after a failure', () => {
    const onRetry = vi.fn();
    const readiness: StartupReadiness = {
      ...baseReadiness,
      ai: { phase: 'ready' },
      assistants: {
        phase: 'error',
        completed: 4,
        total: 6,
        missingIds: ['rongying-research', 'rongying-family'],
        error: 'write denied',
      },
      hasError: true,
    };
    const { container, unmount } = render(<StartupReadinessScreen readiness={readiness} onRetry={onRetry} />);

    expect(container.textContent).toContain('presetAgents.roles.research');
    expect(container.textContent).toContain('presetAgents.roles.family');
    const button = container.querySelector('button');
    act(() => button?.click());
    expect(onRetry).toHaveBeenCalledOnce();
    unmount();
  });

  it('uses explicit ready copy for completed capability rows', () => {
    const readiness: StartupReadiness = {
      ...baseReadiness,
      ai: { phase: 'ready' },
      assistants: {
        phase: 'ready',
        completed: 6,
        total: 6,
        missingIds: [],
      },
      isReady: true,
    };
    const { container, unmount } = render(<StartupReadinessScreen readiness={readiness} onRetry={vi.fn()} />);

    expect(container.textContent).toContain('startupReadiness.aiReady');
    expect(container.textContent).toContain('startupReadiness.assistantsReady');
    expect(container.querySelectorAll('svg').length).toBeGreaterThan(0);
    unmount();
  });
});
