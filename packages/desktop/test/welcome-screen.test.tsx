// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  setPending: vi.fn(),
  setSelectedAgentId: vi.fn(),
  setSelectedGwId: vi.fn(),
  setSelectedAgent: vi.fn(),
  selectorOptions: undefined as { initialGatewayId?: string; initialAgentId?: string } | undefined,
  gatewayState: { agentCatalog: [{ id: 'main' }] as Array<{ id: string }> },
  modelCatalogByGateway: {
    'gw-1': [{ id: 'deepseek-v4-flash', provider: 'clawrouter', name: 'DeepSeek V4 Flash' }],
  },
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
  useUiStore: <T,>(
    selector: (state: {
      modelCatalogByGateway: typeof mocks.modelCatalogByGateway;
      setSelectedAgent: typeof mocks.setSelectedAgent;
    }) => T,
  ) => selector({ modelCatalogByGateway: mocks.modelCatalogByGateway, setSelectedAgent: mocks.setSelectedAgent }),
}));

vi.mock('../src/renderer/hooks/useGatewaySelector', () => ({
  useGatewaySelector: (options: { initialGatewayId?: string; initialAgentId?: string }) => {
    mocks.selectorOptions = options;
    const effectiveAgentId = mocks.gatewayState.agentCatalog.some((agent) => agent.id === options.initialAgentId)
      ? options.initialAgentId!
      : 'main';
    return {
      gateways: [],
      selectedGwId: 'gw-1',
      setSelectedGwId: mocks.setSelectedGwId,
      agentCatalog: mocks.gatewayState.agentCatalog,
      effectiveAgentId,
      setSelectedAgentId: mocks.setSelectedAgentId,
    };
  },
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

describe('WelcomeScreen assistant workspace', () => {
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    mocks.gatewayState.agentCatalog = [{ id: 'main' }];
    mocks.selectorOptions = undefined;
  });

  it('opens the assistant recommended by the completed purpose and keeps its model on the pending task', () => {
    mocks.gatewayState.agentCatalog = [{ id: 'main' }, { id: 'rongying-video' }];
    const { container, unmount } = render(
      <WelcomeScreen
        onboardingProfile={{ ...onboardingProfile, useCases: [...onboardingProfile.useCases] }}
        onSelectPrompt={vi.fn()}
      />,
    );

    expect(mocks.selectorOptions?.initialAgentId).toBe('rongying-video');
    expect(container.textContent).toContain('presetAgents.roles.video');
    expect(container.textContent).toContain('assistantWorkspaces.video.description');
    expect(mocks.setSelectedAgent).toHaveBeenCalledWith('gw-1', 'rongying-video');
    expect(mocks.setPending).toHaveBeenCalledWith({
      gatewayId: 'gw-1',
      agentId: 'rongying-video',
      model: 'deepseek-v4-flash',
    });
    unmount();
  });

  it('prefills the composer from the current assistant workspace', () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const onSelectPrompt = vi.fn();
    const { container, unmount } = render(
      <WelcomeScreen
        onboardingProfile={{ ...onboardingProfile, useCases: [...onboardingProfile.useCases] }}
        onSelectPrompt={onSelectPrompt}
      />,
    );
    const button = container.querySelector('[data-testid="assistant-starter"]');

    expect(button).toBeDefined();
    mocks.setPending.mockClear();
    act(() => (button as HTMLButtonElement).click());
    expect(mocks.setPending).not.toHaveBeenCalled();
    expect(onSelectPrompt).toHaveBeenCalledWith('assistantWorkspaces.compass.starters.1.prompt');
    unmount();
  });

  it('keeps a starter on the assistant already selected by the purpose', () => {
    mocks.gatewayState.agentCatalog = [{ id: 'main' }, { id: 'rongying-video' }];
    const onSelectPrompt = vi.fn();
    const { container, unmount } = render(
      <WelcomeScreen
        onboardingProfile={{ ...onboardingProfile, useCases: [...onboardingProfile.useCases] }}
        onSelectPrompt={onSelectPrompt}
      />,
    );
    const button = container.querySelector('[data-testid="assistant-starter"]');

    mocks.setPending.mockClear();
    act(() => (button as HTMLButtonElement).click());
    expect(mocks.setPending).not.toHaveBeenCalled();
    expect(mocks.setSelectedAgentId).not.toHaveBeenCalled();
    expect(onSelectPrompt).toHaveBeenCalledWith('assistantWorkspaces.video.starters.1.prompt');
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
