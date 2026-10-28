// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  setPending: vi.fn(),
  updatePending: vi.fn((patch: Record<string, unknown>) => {
    if (mocks.pendingNewTask) mocks.pendingNewTask = { ...mocks.pendingNewTask, ...patch };
  }),
  setSelectedAgentId: vi.fn(),
  setSelectedGwId: vi.fn(),
  setSelectedAgent: vi.fn(),
  setMainView: vi.fn(),
  selectedGwId: 'gw-1',
  pendingNewTask: null as {
    gatewayId?: string;
    agentId?: string;
    model?: string;
    mode?: string;
    tags?: string[];
    teamId?: string;
    ensemble?: boolean;
  } | null,
  gatewayState: { agentCatalog: [{ id: 'main' }] as Array<{ id: string; name?: string }> },
  modelCatalogByGateway: {
    // 2026-10-10 Cephalon 批：商业默认 = glm-5.3-flash（智能档同款）——
    // 夹具目录按**切换后现实**准备（含新默认 + 旧渠道/其它目录项并存）。
    'gw-1': [
      // 2026-10-17 三档按能力分模型：商业默认（智能档）= glm-5.3-flashx。
      { id: 'glm-5.3-flashx', provider: 'clawrouter', name: 'GLM 5.3 FlashX' },
      { id: 'glm-5.3-flash', provider: 'clawrouter', name: 'GLM 5.3 Flash' },
      { id: 'deepseek-v4-flash', provider: 'clawrouter', name: 'DeepSeek V4 Flash' },
      { id: 'qwen3.5-plus', provider: 'clawrouter', name: 'Qwen 3.5 Plus' },
    ],
    'gw-2': [
      {
        // 目的网关的目录里也有商业默认（relay 现网目录含 glm-5.3-flashx）；
        // 这条用例证明"标签取目的网关的那份，不是旧待发态里的"。
        id: 'clawrouter/glm-5.3-flashx',
        provider: 'clawrouter',
        name: 'Gateway Two GLM',
      },
      { id: 'glm-4.7', provider: 'clawrouter', name: 'GLM 4.7' },
    ],
  },
}));

vi.mock('react-i18next', () => ({
  // 带插值时把取值也显示出来（`key({"agentId":"…"})`），否则「提示里点名了哪个助手」
  // 这类断言就只能绑到 key 上、绑不住**值**。
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options ? `${key}(${JSON.stringify(options)})` : key),
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

vi.mock('framer-motion', () => ({
  motion: { div: 'div' },
}));

vi.mock('../src/renderer/platform', () => {
  /**
   * ⭐ 2026-09-24：这里**不再伪造 `useGatewaySelector`**（旧夹具把「未知 id 静默换成
   * `main`」写死在假 hook 里，于是那一刀永远测不出自己的缺陷）。现在跑的是**真 hook**，
   * 这个假 store 只负责把它读得到的东西喂对：
   * - `gatewayInfoMap` 只放**当前**那个网关 —— 于是「选中的网关不在列表里」这条
   *   回落路径与真实现一致（有用例依赖它换到 gw-2）；
   * - `agentCatalogByGateway[当前网关]` 的 `undefined` 与否，就是真 hook 判「目录加载了没」的依据。
   */
  const uiState = () => ({
    modelCatalogByGateway: mocks.modelCatalogByGateway,
    setSelectedAgent: mocks.setSelectedAgent,
    setMainView: mocks.setMainView,
    gatewayInfoMap: { [mocks.selectedGwId]: { id: mocks.selectedGwId } },
    defaultGatewayId: mocks.selectedGwId,
    agentCatalogByGateway: {
      [mocks.selectedGwId]: { agents: mocks.gatewayState.agentCatalog, defaultId: 'main' },
    },
  });

  return {
    useTaskStore: Object.assign(
      <T,>(selector: (state: { pendingNewTask: typeof mocks.pendingNewTask }) => T) =>
        selector({ pendingNewTask: mocks.pendingNewTask }),
      {
        getState: () => ({
          pendingNewTask: mocks.pendingNewTask,
          setPending: mocks.setPending,
          updatePending: mocks.updatePending,
        }),
      },
    ),
    useUiStore: <T,>(selector: (state: ReturnType<typeof uiState>) => T) => selector(uiState()),
  };
});

// 真 hook 会在选中的网关上拉一次目录；测试里掐掉那一跳（被测的不是网络）。
vi.mock('@/hooks/useGatewayBootstrap', () => ({
  fetchAgentsForGateway: vi.fn(async () => undefined),
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
  it('lets a user leave the requested team manager and clears only the pending team scope', () => {
    mocks.gatewayState.agentCatalog = [
      { id: 'main' },
      { id: 'designer', name: '演示设计师' },
      { id: 'finance-lead', name: '融资主管' },
    ];
    mocks.pendingNewTask = {
      gatewayId: 'gw-1',
      agentId: 'finance-lead',
      model: 'qwen3.5-plus',
      teamId: 'finance-team',
      ensemble: false,
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
    const view = render(ui());
    mocks.setPending.mockImplementationOnce((next) => {
      mocks.pendingNewTask = next;
    });
    const designer = Array.from(view.container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('演示设计师'),
    );
    act(() => designer?.click());
    expect(mocks.pendingNewTask).toMatchObject({ agentId: 'designer', gatewayId: 'gw-1' });
    expect(mocks.pendingNewTask?.teamId).toBeUndefined();
    expect(mocks.setSelectedAgent).toHaveBeenCalledWith('gw-1', 'designer');
    expect(
      Array.from(view.container.querySelectorAll('button')).find((button) => button.textContent?.includes('演示设计师'))
        ?.className,
    ).toContain('border-[var(--accent)]');
    mocks.pendingNewTask = {
      gatewayId: 'gw-1',
      agentId: 'finance-lead',
      model: 'qwen3.5-plus',
      teamId: 'finance-team',
      ensemble: false,
    };
    view.rerender(ui());
    expect(
      Array.from(view.container.querySelectorAll('button')).find((button) => button.textContent?.includes('融资主管'))
        ?.className,
    ).toContain('border-[var(--accent)]');
    expect(mocks.pendingNewTask?.teamId).toBe('finance-team');
    view.unmount();
  });

  it('shows a requested manager outside the first three catalog rows without losing pending team context', () => {
    mocks.gatewayState.agentCatalog = [
      { id: 'main' },
      { id: 'analyst', name: '商业分析师' },
      { id: 'designer', name: '演示设计师' },
      { id: 'finance-lead', name: '融资主管' },
    ];
    mocks.pendingNewTask = { gatewayId: 'gw-1', agentId: 'main', model: 'deepseek-v4-flash' };
    const ui = () => (
      <WelcomeScreen
        onboardingProfile={{ ...onboardingProfile, useCases: [] }}
        recentPresetIds={[]}
        onSelectPreset={vi.fn()}
        onCustomTask={vi.fn()}
        onAssistantChange={vi.fn()}
      />
    );
    const view = render(ui());
    mocks.setPending.mockClear();
    mocks.pendingNewTask = {
      gatewayId: 'gw-1',
      agentId: 'finance-lead',
      model: 'qwen3.5-plus',
      teamId: 'finance-team',
      ensemble: false,
    };
    view.rerender(ui());
    const manager = Array.from(view.container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('融资主管'),
    );
    expect(manager).toBeDefined();
    expect(manager?.className).toContain('border-[var(--accent)]');
    expect(mocks.pendingNewTask).toMatchObject({
      agentId: 'finance-lead',
      teamId: 'finance-team',
      ensemble: false,
      model: 'qwen3.5-plus',
    });
    expect(mocks.setPending).not.toHaveBeenCalled();
    view.unmount();
  });

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    mocks.pendingNewTask = null;
    mocks.selectedGwId = 'gw-1';
    mocks.gatewayState.agentCatalog = [{ id: 'main' }];
  });

  it('⭐ 默认当前助手 = 主罗盘（引导画像的六类推荐不再决定当前助手）', () => {
    mocks.gatewayState.agentCatalog = [{ id: 'main' }, { id: 'partner-w-video' }];
    const { container, unmount } = render(
      <WelcomeScreen
        onboardingProfile={{ ...onboardingProfile, useCases: [...onboardingProfile.useCases] }}
        recentPresetIds={[]}
        onSelectPreset={vi.fn()}
        onCustomTask={vi.fn()}
        onAssistantChange={vi.fn()}
      />,
    );

    // 工作台落在罗盘（不是画像推荐过的 video），模型照旧落到待发任务（新商业默认 glm-5.3-flash）。
    expect(container.textContent).toContain('assistantWorkspaces.compass.description');
    expect(container.textContent).not.toContain('assistantWorkspaces.video.description');
    expect(mocks.setSelectedAgent).toHaveBeenCalledWith('gw-1', 'main');
    expect(mocks.setPending).toHaveBeenCalledWith({
      gatewayId: 'gw-1',
      agentId: 'main',
      model: 'glm-5.3-flashx',
    });
    // chip 区只留一级入口（当前罗盘）：预置的 partner-w-video 不再是其中一格（它归「技能与能力」）。
    const chipLabels = [...container.querySelectorAll('button')].map((button) => button.textContent?.trim());
    expect(chipLabels).not.toContain('partner-w-video');
    unmount();
  });

  it('returns the selected preset and translated prompt from the current assistant workspace', () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const onSelectPreset = vi.fn();
    const { container, unmount } = render(
      <WelcomeScreen
        onboardingProfile={{ ...onboardingProfile, useCases: [] }}
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

  it('chip 两级口径：模式档只显示模式名（模型不上屏）；custom 显示真实 pending 模型', () => {
    mocks.gatewayState.agentCatalog = [{ id: 'main' }, { id: 'partner-w-video' }];
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

    // 空待发态：待发档 = 默认档（智能）—— 2026-10-11 用户拍板后**只显示模式名**，
    // 背后跑哪个模型（新商业默认 glm-5.3-flash）是内部实现，不上屏。
    expect(view.container.textContent).toContain('chatInput.mode.smart');
    expect(view.container.textContent).not.toContain('GLM 5.3 Flash');
    // `pending.model` 仍是那条"留痕"（商业默认写到状态层）—— 显示层不上屏不改状态。
    expect(mocks.setPending).toHaveBeenCalledWith(
      expect.objectContaining({ gatewayId: 'gw-1', model: 'glm-5.3-flashx' }),
    );

    // ⚠️ 2026-10-11 两级口径：模式档只显示模式名（模型=内部实现）；
    //    "真实 pending 模型"这一格由 **custom（用户显式选过模型）** 承载（见 useChatSend 同款判据）。
    mocks.pendingNewTask = {
      gatewayId: 'gw-1',
      agentId: 'partner-w-video',
      model: 'qwen3.5-plus',
      mode: 'custom',
    };
    mocks.setPending.mockClear();
    view.rerender(ui());

    expect(view.container.textContent).toContain('Qwen 3.5 Plus');
    expect(view.container.textContent).not.toContain('GLM 5.3 Flash');
    expect(mocks.setPending).not.toHaveBeenCalled();

    const compassButton = [...view.container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('mainArea.compassAssistant'),
    );
    act(() => compassButton?.click());

    expect(mocks.setPending).toHaveBeenCalledWith({
      gatewayId: 'gw-1',
      agentId: 'main',
      model: 'glm-5.3-flashx',
    });
    view.unmount();
  });

  it('preserves a same-scope non-default model on first mount and remount', () => {
    // custom（用户显式选过模型）—— 只有这一档 chip 直接显示 pending.model（模式档显示模式解析模型）。
    mocks.pendingNewTask = {
      gatewayId: 'gw-1',
      agentId: 'main',
      model: 'qwen3.5-plus',
      mode: 'custom',
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

    // 2026-10-11 起模式档 chip 与模型解耦（此待发态无 mode ⇒ 默认智能档）：
    // 目录一个可用模型都没有（还没加载）⇒ 显示可用性层"正在准备模型…"，不显示模型名；
    // "同域模型没被清掉"由上两行状态断言钉住。
    expect(container.textContent).toContain('chatInput.modelsLoading');
    expect(mocks.setPending).not.toHaveBeenCalled();
    expect(mocks.updatePending).not.toHaveBeenCalled();
    unmount();
    mocks.modelCatalogByGateway['gw-1'] = previousCatalog;
  });

  it('adds a loaded default model without replacing same-scope preset tags', () => {
    const previousCatalog = mocks.modelCatalogByGateway['gw-1'];
    mocks.modelCatalogByGateway['gw-1'] = [];
    mocks.pendingNewTask = {
      gatewayId: 'gw-1',
      agentId: 'main',
      tags: ['private', 'assistant-task-preset:compass:goal-breakdown'],
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
    const view = render(ui());

    mocks.modelCatalogByGateway['gw-1'] = previousCatalog;
    mocks.setPending.mockClear();
    mocks.updatePending.mockClear();
    view.rerender(ui());

    expect(mocks.updatePending).toHaveBeenCalledWith({ model: 'glm-5.3-flashx' });
    expect(mocks.setPending).not.toHaveBeenCalled();
    expect(mocks.pendingNewTask?.tags).toEqual(['private', 'assistant-task-preset:compass:goal-breakdown']);
    view.unmount();
  });

  it('uses the destination gateway default label before stale pending state is normalized', () => {
    const ui = () => (
      <WelcomeScreen
        onboardingProfile={{ ...onboardingProfile, useCases: [] }}
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
      mode: 'custom',
      tags: ['private', 'assistant-task-preset:compass:goal-breakdown'],
    };
    view.rerender(ui());
    expect(view.container.textContent).toContain('Qwen 3.5 Plus');

    mocks.selectedGwId = 'gw-2';
    mocks.setPending.mockClear();
    view.rerender(ui());

    // 2026-10-11：切网关后的待发态是全新默认档（智能）⇒ chip 只显示模式名；
    // 目标网关的默认模型（Gateway Two GLM）只进 setPending 负载（下行断言），不再上屏。
    expect(view.container.textContent).toContain('chatInput.mode.smart');
    expect(view.container.textContent).not.toContain('Qwen 3.5 Plus');
    expect(view.container.textContent).not.toContain('qwen3.5-plus');
    expect(mocks.setPending).toHaveBeenCalledWith({
      gatewayId: 'gw-2',
      agentId: 'main',
      model: 'clawrouter/glm-5.3-flashx',
      tags: ['private'],
    });
    view.unmount();
  });

  it('does not carry a preset tag when switching assistants', () => {
    // ⚠️ 切去的是一个**非预置**助手：六类预置已不进 chip 区（见「默认当前助手 = 主罗盘」那条）。
    mocks.gatewayState.agentCatalog = [{ id: 'main' }, { id: 'custom-agent', name: '自定义助手' }];
    mocks.pendingNewTask = {
      gatewayId: 'gw-1',
      agentId: 'main',
      model: 'qwen3.5-plus',
      tags: ['private', 'assistant-task-preset:compass:goal-breakdown'],
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
    mocks.setPending.mockClear();

    const otherButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === '自定义助手',
    );
    act(() => otherButton?.click());

    expect(mocks.setPending).toHaveBeenCalledWith({
      gatewayId: 'gw-1',
      agentId: 'custom-agent',
      model: 'glm-5.3-flashx',
      tags: ['private'],
    });
    unmount();
  });

  it('keeps a starter on the assistant already selected by the user', () => {
    mocks.gatewayState.agentCatalog = [{ id: 'main' }, { id: 'partner-w-video' }];
    // 用户点名要的助手（待发任务）优先于默认罗盘 —— 工作台跟着它走。
    mocks.pendingNewTask = { gatewayId: 'gw-1', agentId: 'partner-w-video' };
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
      expect.objectContaining({ id: 'video:shooting-script', assistantId: 'partner-w-video' }),
      'assistantWorkspaces.video.starters.1.prompt',
    );
    unmount();
  });

  it('shows only recent presets that belong to the active assistant', () => {
    mocks.gatewayState.agentCatalog = [{ id: 'main' }, { id: 'partner-w-content' }];
    mocks.pendingNewTask = { gatewayId: 'gw-1', agentId: 'partner-w-content' };
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

  /**
   * ⭐⭐ 2026-09-21（第二台机器实机）：**欢迎屏是用户第一眼看到的那一屏**。
   *
   * 已知失败会把 `conversationReady` 压成 `false`，于是工作台那一格照旧转圈 + 说
   * 「正在启动 AI 服务」—— 上面一条真话（面板里的「去激活」）与正下方一个转圈**同屏**，
   * 而下面那句恰恰是本任务要消灭的"它还在准备"。
   *
   * ⚠️ 判据是**这一屏自己**（工作台那一格 + 模型那一格）：不许有 spinner、不许出现
   *    「正在启动」/「正在准备模型」，要出现的是那条已知失败的结论与警示图标。
   */
  it('⭐⭐ 已知中转失败时工作台不许转圈、不许说"正在准备"', () => {
    const failureText = 'startupReadiness.relayOrganizationMismatch';
    const { container, unmount } = render(
      <WelcomeScreen
        onboardingProfile={{ ...onboardingProfile, useCases: [] }}
        recentPresetIds={[]}
        onSelectPreset={vi.fn()}
        onCustomTask={vi.fn()}
        onAssistantChange={vi.fn()}
        // 实机的形状：relay 失败 ⇒ `conversationReady = false`（不是"还没准备好"，是**已经有结论**）。
        conversationReady={false}
        failureText={failureText}
      />,
    );

    expect(container.querySelectorAll('.animate-spin'), '不许转圈').toHaveLength(0);
    expect(container.textContent, '不许说"正在启动 AI 服务"').not.toContain('startupReadiness.aiStarting');
    expect(container.textContent, '不许说"正在准备模型…"').not.toContain('chatInput.modelsLoading');
    expect(container.textContent).toContain(failureText);
    // 静态警示图标（与面板同一套）：lucide 的三角形警告，不是 spinner。
    expect(container.querySelectorAll('.lucide-triangle-alert').length, '要有一个警示图标').toBeGreaterThan(0);
    unmount();
  });

  it('⭐ 已知失败且目录里没有可用模型时，模型那一格也不许回落"正在准备模型…"', () => {
    // 换个还没有目录的网关：`defaultModel` 解析不出来 ⇒ 正是那条回落的现场。
    mocks.selectedGwId = 'gw-3';
    const { container, unmount } = render(
      <WelcomeScreen
        onboardingProfile={{ ...onboardingProfile, useCases: [] }}
        recentPresetIds={[]}
        onSelectPreset={vi.fn()}
        onCustomTask={vi.fn()}
        onAssistantChange={vi.fn()}
        conversationReady={false}
        failureText="startupReadiness.relayOrganizationMismatch"
      />,
    );

    expect(container.textContent).not.toContain('chatInput.modelsLoading');
    expect(container.textContent).toContain('chatInput.modelsUnusable');
    unmount();
  });

  /**
   * ⭐⭐ 2026-09-24（层 2 的核心用例）：**不伪造 hook**，跑真 hook + 真 store。
   *
   * 目录里只有 `main`，pending 点名一个不存在的 `team-agent-x`（团队「发起对话」三次点击
   * 可复现的现场）。旧行为把它静默换成 `main`、再把替换结果**写回 pending**，用户看到的
   * 就是「点了却跳到主罗盘」且全程无提示。
   *
   * 判据全部是**用户可见的结果**，不是内部字段。
   */
  it('⭐ 请求的助手不在目录里时：如实说明、不冒充所选助手、pending 不被改写', () => {
    mocks.pendingNewTask = { gatewayId: 'gw-1', agentId: 'team-agent-x' };
    const { container, unmount } = render(
      <WelcomeScreen
        onboardingProfile={{ ...onboardingProfile, useCases: [] }}
        recentPresetIds={[]}
        onSelectPreset={vi.fn()}
        onCustomTask={vi.fn()}
        onAssistantChange={vi.fn()}
      />,
    );

    // 1) 如实说明，而且**点名**是哪一个助手
    expect(container.textContent, '提示要出现').toContain('agent.missingTitle');
    expect(container.textContent, '提示里要点名').toContain('team-agent-x');
    // 2) 罗盘助手**没有**被当成所选助手静默呈现（工作台那一屏不该出现）
    expect(container.textContent, '不许冒充罗盘工作台').not.toContain('assistantWorkspaces.compass.description');
    expect(container.textContent, '不许出现罗盘工作台的起始任务').not.toContain(
      'assistantWorkspaces.compass.starters.1.prompt',
    );
    // 3) pending 没有被改写成替换后的 id（旧行为正是这一步把"用户的选择"改掉的）
    expect(mocks.setPending, '不许把 pending 改写成别的助手').not.toHaveBeenCalled();
    expect(mocks.updatePending).not.toHaveBeenCalled();
    // 4) 落的是**通用欢迎屏**，不是空白
    expect(container.textContent).toContain('mainArea.welcomeTitle');
    // 5) 两条出口都在（措辞里给出下一步，不是干说一句坏消息）
    expect(container.textContent).toContain('agent.missingSwitch');
    expect(container.textContent).toContain('agent.missingOpenTeams');
    unmount();
  });

  /**
   * ⭐⭐ 2026-09-24（复核**复验**指出 I-1 只绑住了 hook、没绑住**接线**）。
   *
   * 变异：把 `requestedAgentId` 从 `pendingNewTask?.agentId` 改回"也带推荐"
   * （`?? preferredAgentId`），83 条测试**全绿**——而那是真的回归：没有待发任务时，
   * 推荐就又被当成"用户点名要的"，新机器装预置助手期间照样误报。
   *
   * 这条用例从**屏幕**上钉住接线：画像推荐 video、目录里还没有 video、pending 为空
   * ⇒ **不许**出现任何"不在本机"的提示。
   */
  it('⭐⭐ 只有画像推荐（用户没点名）时，屏幕上不许出现"不在本机"', () => {
    mocks.gatewayState.agentCatalog = [{ id: 'main' }];
    mocks.pendingNewTask = null;
    const { container, unmount } = render(
      <WelcomeScreen
        onboardingProfile={{ ...onboardingProfile, useCases: [...onboardingProfile.useCases] }}
        recentPresetIds={[]}
        onSelectPreset={vi.fn()}
        onCustomTask={vi.fn()}
        onAssistantChange={vi.fn()}
      />,
    );

    expect(container.textContent, '推荐缺失不是"用户要的助手不在本机"').not.toContain('agent.missingTitle');
    expect(container.textContent, '也不许给"去团队页"那种错出口').not.toContain('agent.missingOpenTeams');
    unmount();
  });

  /**
   * ⚠️ 2026-09-24（独立复核 M-2）：罗盘自己也不在目录里时，"换用罗盘助手"是个**死胡同按钮** ——
   * 一边说"不在本机"、一边给一个指向同样不存在的助手的出口。那时只留"去团队页"。
   */
  /**
   * ⭐ FEAT-01 集成（2026-10-08；**2026-10-11 用户拍板修订**）：**chip 说的是"将要跑什么"**。
   *
   * `createTask` 把新任务的 `mode` 写成默认档（智能），发送路径按 `MODE_POLICY` 对着目录
   * 现解析模型（Cephalon 批起三档统一 `glm-5.3-flash`，只差思考档）。
   *
   * ⚠️ 2026-10-11 用户拍板：**三档模式背后跑哪个模型是内部实现，不再上屏** ——
   *    模式档 chip 只显示模式名（显示层与模型彻底解耦：目录里有没有模式模型、
   *    发送路径回退到 `pending.model` 与否，都不改变"只显示模式名"）。
   *    仅 `custom`（高级：用户显式选过模型）显示模型名。
   */
  it('⭐ FEAT-01（2026-10-11 修订）：智能档只显示模式名，背后模型不上屏', () => {
    const previous = mocks.modelCatalogByGateway['gw-1'];
    mocks.modelCatalogByGateway['gw-1'] = [
      { id: 'deepseek-v4-flash', provider: 'clawrouter', name: 'DeepSeek V4 Flash' },
      { id: 'glm-5.3-flash', provider: 'clawrouter', name: 'GLM 5.3 Flash' },
      { id: 'glm-5.3-flashx', provider: 'clawrouter', name: 'GLM 5.3 FlashX' },
    ];
    const { container, unmount } = render(
      <WelcomeScreen
        onboardingProfile={{ ...onboardingProfile, useCases: [] }}
        recentPresetIds={[]}
        onSelectPreset={vi.fn()}
        onCustomTask={vi.fn()}
        onAssistantChange={vi.fn()}
      />,
    );

    expect(container.textContent, '模式名要出现').toContain('chatInput.mode.smart');
    expect(container.textContent, '背后模型不上屏（2026-10-11 用户拍板）').not.toContain('GLM 5.3 Flash');
    expect(container.textContent, '目录里别的模型（旧默认时代那条）不上屏').not.toContain('DeepSeek V4 Flash');
    // `pending.model` 仍是那条"留痕"（= 商业默认）—— 状态不被显示层改写。
    expect(mocks.setPending).toHaveBeenCalledWith(expect.objectContaining({ model: 'glm-5.3-flashx' }));
    unmount();
    mocks.modelCatalogByGateway['gw-1'] = previous;
  });

  it('⭐ FEAT-01（2026-10-11 修订）：快速档同样只显示模式名（三档 = glm-5.3-flash，不露给用户）', () => {
    const previous = mocks.modelCatalogByGateway['gw-1'];
    mocks.modelCatalogByGateway['gw-1'] = [
      { id: 'glm-5.3-flash', provider: 'clawrouter', name: 'GLM 5.3 Flash' },
      { id: 'qwen3.7-flash', provider: 'clawrouter', name: 'Qwen3.7 Flash' },
    ];
    mocks.pendingNewTask = { gatewayId: 'gw-1', agentId: 'main', mode: 'fast' };
    const { container, unmount } = render(
      <WelcomeScreen
        onboardingProfile={{ ...onboardingProfile, useCases: [] }}
        recentPresetIds={[]}
        onSelectPreset={vi.fn()}
        onCustomTask={vi.fn()}
        onAssistantChange={vi.fn()}
      />,
    );

    expect(container.textContent).toContain('chatInput.mode.fast');
    expect(container.textContent, '模型不上屏').not.toContain('GLM 5.3 Flash');
    unmount();
    mocks.modelCatalogByGateway['gw-1'] = previous;
  });

  it('⭐ 目录里没有模式模型（glm 缺席）也照样只显示模式名 —— 显示层与模型彻底解耦（2026-10-11）', () => {
    const previous = mocks.modelCatalogByGateway['gw-1'];
    mocks.modelCatalogByGateway['gw-1'] = [{ id: 'qwen3.5-plus', provider: 'clawrouter', name: 'Qwen 3.5 Plus' }];
    mocks.pendingNewTask = { gatewayId: 'gw-1', agentId: 'main', mode: 'fast', model: 'qwen3.5-plus' };
    const { container, unmount } = render(
      <WelcomeScreen
        onboardingProfile={{ ...onboardingProfile, useCases: [] }}
        recentPresetIds={[]}
        onSelectPreset={vi.fn()}
        onCustomTask={vi.fn()}
        onAssistantChange={vi.fn()}
      />,
    );

    expect(container.textContent, '模式名照常显示').toContain('chatInput.mode.fast');
    expect(container.textContent, '回退目标（pending.model）也不上屏 —— 模型=内部实现').not.toContain('Qwen 3.5 Plus');
    unmount();
    mocks.modelCatalogByGateway['gw-1'] = previous;
  });

  it('⭐ FEAT-01：高级（指定模型）照旧显示模型名，不受模式显示影响', () => {
    const previous = mocks.modelCatalogByGateway['gw-1'];
    mocks.modelCatalogByGateway['gw-1'] = [
      { id: 'qwen3.7-flash', provider: 'clawrouter', name: 'Qwen3.7 Flash' },
      { id: 'qwen3.5-plus', provider: 'clawrouter', name: 'Qwen 3.5 Plus' },
    ];
    mocks.pendingNewTask = { gatewayId: 'gw-1', agentId: 'main', model: 'qwen3.5-plus', mode: 'custom' };
    const { container, unmount } = render(
      <WelcomeScreen
        onboardingProfile={{ ...onboardingProfile, useCases: [] }}
        recentPresetIds={[]}
        onSelectPreset={vi.fn()}
        onCustomTask={vi.fn()}
        onAssistantChange={vi.fn()}
      />,
    );

    expect(container.textContent).toContain('Qwen 3.5 Plus');
    expect(container.textContent, '高级档不许显示模式名').not.toContain('chatInput.mode.');
    unmount();
    mocks.modelCatalogByGateway['gw-1'] = previous;
  });
  it('⭐ 罗盘自己也不在目录里 ⇒ 不给"换用罗盘助手"这个出口，只留团队页', () => {
    mocks.gatewayState.agentCatalog = [{ id: 'some-other-agent' }];
    mocks.pendingNewTask = { gatewayId: 'gw-1', agentId: 'team-agent-x' };
    const { container, unmount } = render(
      <WelcomeScreen
        onboardingProfile={{ ...onboardingProfile, useCases: [] }}
        recentPresetIds={[]}
        onSelectPreset={vi.fn()}
        onCustomTask={vi.fn()}
        onAssistantChange={vi.fn()}
      />,
    );

    expect(container.textContent).toContain('agent.missingTitle');
    expect(container.textContent, '罗盘不在就别给这个出口').not.toContain('agent.missingSwitch');
    expect(container.textContent, '去团队页恒可用').toContain('agent.missingOpenTeams');
    unmount();
  });
});
