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
  selectedGwId: 'gw-1',
  pendingNewTask: null as { gatewayId?: string; agentId?: string; model?: string } | null,
  gatewayState: { agentCatalog: [{ id: 'main' }] as Array<{ id: string }> },
  modelCatalogByGateway: {
    'gw-1': [
      { id: 'deepseek-v4-flash', provider: 'clawrouter', name: 'DeepSeek V4 Flash' },
      { id: 'qwen3.5-plus', provider: 'clawrouter', name: 'Qwen 3.5 Plus' },
    ],
    'gw-2': [
      {
        id: 'clawrouter/deepseek-v4-flash',
        provider: 'clawrouter',
        name: 'Gateway Two DeepSeek',
      },
      { id: 'glm-4.7', provider: 'clawrouter', name: 'GLM 4.7' },
    ],
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
    <T,>(selector: (state: { pendingNewTask: typeof mocks.pendingNewTask }) => T) =>
      selector({ pendingNewTask: mocks.pendingNewTask }),
    { getState: () => ({ pendingNewTask: mocks.pendingNewTask, setPending: mocks.setPending }) },
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
      selectedGwId: mocks.selectedGwId,
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

function render(ui: ReactElement): {
  container: HTMLDivElement;
  rerender: (nextUi: ReactElement) => void;
  unmount: () => void;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => root.render(ui));
  return {
    container,
    rerender: (nextUi) => act(() => root.render(nextUi)),
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
    mocks.pendingNewTask = null;
    mocks.selectedGwId = 'gw-1';
    mocks.gatewayState.agentCatalog = [{ id: 'main' }];
    mocks.selectorOptions = undefined;
  });

  it('opens the assistant recommended by the completed purpose and keeps its model on the pending task', () => {
    mocks.gatewayState.agentCatalog = [{ id: 'main' }, { id: 'rongying-video' }];
    const { container, unmount } = render(
      <WelcomeScreen
        onboardingProfile={{ ...onboardingProfile, useCases: [...onboardingProfile.useCases] }}
        recentPresetIds={[]}
        onSelectPreset={vi.fn()}
        onCustomTask={vi.fn()}
        onAssistantChange={vi.fn()}
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

  it('returns the selected preset and translated prompt from the current assistant workspace', () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const onSelectPreset = vi.fn();
    const { container, unmount } = render(
      <WelcomeScreen
        onboardingProfile={{ ...onboardingProfile, useCases: [...onboardingProfile.useCases] }}
        recentPresetIds={[]}
        onSelectPreset={onSelectPreset}
        onCustomTask={vi.fn()}
        onAssistantChange={vi.fn()}
      />,
    );
    const button = container.querySelector('[data-preset-id="compass:goal-breakdown"]');

    expect(button).toBeDefined();
    mocks.setPending.mockClear();
    act(() => (button as HTMLButtonElement).click());
    expect(mocks.setPending).not.toHaveBeenCalled();
    expect(onSelectPreset).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'compass:goal-breakdown', assistantId: 'main' }),
      'assistantWorkspaces.compass.starters.1.prompt',
    );
    unmount();
  });

  it('shows the real pending model label instead of the commercial default in a two-model catalog', () => {
    mocks.gatewayState.agentCatalog = [{ id: 'main' }, { id: 'rongying-video' }];
    const ui = () => (
      <WelcomeScreen
        onboardingProfile={{ ...onboardingProfile, useCases: [...onboardingProfile.useCases] }}
        recentPresetIds={[]}
        onSelectPreset={vi.fn()}
        onCustomTask={vi.fn()}
        onAssistantChange={vi.fn()}
      />
    );
    const view = render(ui());

    expect(view.container.textContent).toContain('DeepSeek V4 Flash');
    expect(mocks.setPending).toHaveBeenCalledWith(
      expect.objectContaining({ gatewayId: 'gw-1', model: 'deepseek-v4-flash' }),
    );

    mocks.pendingNewTask = {
      gatewayId: 'gw-1',
      agentId: 'rongying-video',
      model: 'qwen3.5-plus',
    };
    mocks.setPending.mockClear();
    view.rerender(ui());

    expect(view.container.textContent).toContain('Qwen 3.5 Plus');
    expect(view.container.textContent).not.toContain('DeepSeek V4 Flash');
    expect(mocks.setPending).not.toHaveBeenCalled();

    const compassButton = [...view.container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('mainArea.compassAssistant'),
    );
    act(() => compassButton?.click());

    expect(mocks.setPending).toHaveBeenCalledWith({
      gatewayId: 'gw-1',
      agentId: 'main',
      model: 'deepseek-v4-flash',
    });
    view.unmount();
  });

  it('preserves a same-scope non-default model on first mount and remount', () => {
    mocks.pendingNewTask = {
      gatewayId: 'gw-1',
      agentId: 'main',
      model: 'qwen3.5-plus',
    };
    const ui = () => (
      <WelcomeScreen
        onboardingProfile={{ ...onboardingProfile, useCases: [] }}
        recentPresetIds={[]}
        onSelectPreset={vi.fn()}
        onCustomTask={vi.fn()}
        onAssistantChange={vi.fn()}
      />
    );

    const firstMount = render(ui());
    expect(firstMount.container.textContent).toContain('Qwen 3.5 Plus');
    expect(mocks.setPending).not.toHaveBeenCalled();
    firstMount.unmount();

    mocks.setPending.mockClear();
    const remount = render(ui());
    expect(remount.container.textContent).toContain('Qwen 3.5 Plus');
    expect(mocks.setPending).not.toHaveBeenCalled();
    remount.unmount();
  });

  it('does not clear a same-scope model while its gateway catalog is still loading', () => {
    const previousCatalog = mocks.modelCatalogByGateway['gw-1'];
    mocks.modelCatalogByGateway['gw-1'] = [];
    mocks.pendingNewTask = {
      gatewayId: 'gw-1',
      agentId: 'main',
      model: 'qwen3.5-plus',
    };
    const { container, unmount } = render(
      <WelcomeScreen
        onboardingProfile={{ ...onboardingProfile, useCases: [] }}
        recentPresetIds={[]}
        onSelectPreset={vi.fn()}
        onCustomTask={vi.fn()}
        onAssistantChange={vi.fn()}
      />,
    );

    expect(container.textContent).toContain('qwen3.5-plus');
    expect(mocks.setPending).not.toHaveBeenCalled();
    unmount();
    mocks.modelCatalogByGateway['gw-1'] = previousCatalog;
  });

  it('uses the destination gateway default label before stale pending state is normalized', () => {
    const ui = () => (
      <WelcomeScreen
        onboardingProfile={{ ...onboardingProfile, useCases: [...onboardingProfile.useCases] }}
        recentPresetIds={[]}
        onSelectPreset={vi.fn()}
        onCustomTask={vi.fn()}
        onAssistantChange={vi.fn()}
      />
    );
    const view = render(ui());

    mocks.pendingNewTask = {
      gatewayId: 'gw-1',
      agentId: 'main',
      model: 'qwen3.5-plus',
    };
    view.rerender(ui());
    expect(view.container.textContent).toContain('Qwen 3.5 Plus');

    mocks.selectedGwId = 'gw-2';
    mocks.setPending.mockClear();
    view.rerender(ui());

    expect(view.container.textContent).toContain('Gateway Two DeepSeek');
    expect(view.container.textContent).not.toContain('Qwen 3.5 Plus');
    expect(view.container.textContent).not.toContain('qwen3.5-plus');
    expect(mocks.setPending).toHaveBeenCalledWith({
      gatewayId: 'gw-2',
      agentId: 'main',
      model: 'clawrouter/deepseek-v4-flash',
    });
    view.unmount();
  });

  it('keeps a starter on the assistant already selected by the purpose', () => {
    mocks.gatewayState.agentCatalog = [{ id: 'main' }, { id: 'rongying-video' }];
    const onSelectPreset = vi.fn();
    const { container, unmount } = render(
      <WelcomeScreen
        onboardingProfile={{ ...onboardingProfile, useCases: [...onboardingProfile.useCases] }}
        recentPresetIds={[]}
        onSelectPreset={onSelectPreset}
        onCustomTask={vi.fn()}
        onAssistantChange={vi.fn()}
      />,
    );
    const button = container.querySelector('[data-testid="assistant-task-preset"]');

    mocks.setPending.mockClear();
    act(() => (button as HTMLButtonElement).click());
    expect(mocks.setPending).not.toHaveBeenCalled();
    expect(mocks.setSelectedAgentId).not.toHaveBeenCalled();
    expect(onSelectPreset).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'video:shooting-script', assistantId: 'rongying-video' }),
      'assistantWorkspaces.video.starters.1.prompt',
    );
    unmount();
  });

  it('shows only recent presets that belong to the active assistant', () => {
    mocks.gatewayState.agentCatalog = [{ id: 'main' }, { id: 'rongying-content' }];
    mocks.pendingNewTask = { gatewayId: 'gw-1', agentId: 'rongying-content' };
    const { container, unmount } = render(
      <WelcomeScreen
        onboardingProfile={{ ...onboardingProfile, useCases: [...onboardingProfile.useCases] }}
        recentPresetIds={['content:short-video-script', 'video:storyboard']}
        onSelectPreset={vi.fn()}
        onCustomTask={vi.fn()}
        onAssistantChange={vi.fn()}
      />,
    );

    expect(container.querySelector('[data-preset-id="content:short-video-script"]')).not.toBeNull();
    expect(container.querySelector('[data-preset-id="video:storyboard"]')).toBeNull();
    unmount();
  });

  it('falls back to the generic welcome for a custom assistant', () => {
    mocks.gatewayState.agentCatalog = [{ id: 'main' }, { id: 'custom-agent' }];
    mocks.pendingNewTask = { gatewayId: 'gw-1', agentId: 'custom-agent' };
    const { container, unmount } = render(
      <WelcomeScreen
        onboardingProfile={{ ...onboardingProfile, useCases: [...onboardingProfile.useCases] }}
        recentPresetIds={['content:short-video-script']}
        onSelectPreset={vi.fn()}
        onCustomTask={vi.fn()}
        onAssistantChange={vi.fn()}
      />,
    );

    expect(container.textContent).toContain('mainArea.welcomeTitle');
    expect(container.querySelector('[data-testid="assistant-task-preset"]')).toBeNull();
    expect(container.textContent).not.toContain('assistantWorkspaces.compass.description');
    unmount();
  });

  it('does not present a separate assistant installation action', () => {
    const onAssistantChange = vi.fn();
    const { container, unmount } = render(
      <WelcomeScreen
        onboardingProfile={{ ...onboardingProfile, useCases: [...onboardingProfile.useCases] }}
        recentPresetIds={[]}
        onSelectPreset={vi.fn()}
        onCustomTask={vi.fn()}
        onAssistantChange={onAssistantChange}
      />,
    );

    expect(container.textContent).not.toContain('presetAgents.install');
    const assistantButton = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('mainArea.compassAssistant'),
    );
    act(() => assistantButton?.click());
    expect(onAssistantChange).toHaveBeenCalledOnce();
    unmount();
  });
});
