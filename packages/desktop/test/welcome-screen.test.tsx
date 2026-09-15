// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  setPending: vi.fn(),
  setSelectedAgentId: vi.fn(),
  setSelectedGwId: vi.fn(),
  gatewayState: { agentCatalog: [{ id: 'main' }] as Array<{ id: string }> },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

vi.mock('framer-motion', () => ({
  motion: { div: 'div' },
}));

vi.mock('../src/renderer/platform', () => ({
  useTaskStore: Object.assign(
    <T,>(selector: (state: { pendingNewTask: null }) => T) => selector({ pendingNewTask: null }),
    { getState: () => ({ pendingNewTask: null, setPending: mocks.setPending }) },
  ),
}));

vi.mock('../src/renderer/hooks/useGatewaySelector', () => ({
  useGatewaySelector: () => ({
    gateways: [],
    selectedGwId: 'gw-1',
    setSelectedGwId: mocks.setSelectedGwId,
    agentCatalog: mocks.gatewayState.agentCatalog,
    effectiveAgentId: 'main',
    setSelectedAgentId: mocks.setSelectedAgentId,
  }),
}));

vi.mock('../src/renderer/components/AgentIcon', () => ({
  default: () => <span />,
}));

import WelcomeScreen from '../src/renderer/layouts/MainArea/WelcomeScreen';

const onboardingProfile = {
  version: 1 as const,
  userId: 'user-1',
  nickname: '',
  useCases: ['video'] as const,
  customGoal: '',
  completedAt: '2026-09-14T00:00:00.000Z',
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

describe('WelcomeScreen task starters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.gatewayState.agentCatalog = [{ id: 'main' }];
  });

  it('prefills the composer and keeps the current assistant when the specialist is absent', () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const onSelectPrompt = vi.fn();
    const { container, unmount } = render(
      <WelcomeScreen
        onboardingProfile={{ ...onboardingProfile, useCases: [...onboardingProfile.useCases] }}
        onSelectPrompt={onSelectPrompt}
      />,
    );
    const button = [...container.querySelectorAll('button')].find((item) =>
      item.textContent?.includes('mainArea.starters.photography.title'),
    );

    expect(button).toBeDefined();
    mocks.setPending.mockClear();
    act(() => button!.click());
    expect(mocks.setPending).toHaveBeenCalledWith({ gatewayId: 'gw-1', agentId: 'main' });
    expect(onSelectPrompt).toHaveBeenCalledWith('mainArea.starters.photography.prompt');
    unmount();
  });

  it('routes a starter to its installed professional assistant before filling the composer', () => {
    mocks.gatewayState.agentCatalog = [{ id: 'main' }, { id: 'rongying-video' }];
    const onSelectPrompt = vi.fn();
    const { container, unmount } = render(
      <WelcomeScreen
        onboardingProfile={{ ...onboardingProfile, useCases: [...onboardingProfile.useCases] }}
        onSelectPrompt={onSelectPrompt}
      />,
    );
    const button = [...container.querySelectorAll('button')].find((item) =>
      item.textContent?.includes('mainArea.starters.photography.title'),
    );

    mocks.setPending.mockClear();
    act(() => button!.click());
    expect(mocks.setPending).toHaveBeenCalledWith({ gatewayId: 'gw-1', agentId: 'rongying-video' });
    expect(mocks.setSelectedAgentId).toHaveBeenCalledWith('rongying-video');
    expect(onSelectPrompt).toHaveBeenCalledWith('mainArea.starters.photography.prompt');
    unmount();
  });

  it('does not present a separate assistant installation action', () => {
    const { container, unmount } = render(
      <WelcomeScreen
        onboardingProfile={{ ...onboardingProfile, useCases: [...onboardingProfile.useCases] }}
        onSelectPrompt={vi.fn()}
      />,
    );

    expect(container.textContent).not.toContain('presetAgents.install');
    unmount();
  });
});
