// @vitest-environment jsdom

import { act, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Artifact } from '@clawwork/shared';
import type { DraftPromptRequest, DraftPromptResolution } from '../src/renderer/components/ChatInput/types';
import type { OnboardingProfile } from '../src/renderer/lib/user-onboarding';
import type { StartupReadiness } from '../src/renderer/lib/startup-readiness';

const mocks = vi.hoisted(() => ({
  handleSend: vi.fn(),
  focus: vi.fn(),
  setPending: vi.fn(),
  setSelectedAgent: vi.fn(),
  pendingNewTask: {
    gatewayId: 'gw-1',
    agentId: 'rongying-content',
    model: 'deepseek-v4-flash',
  } as { gatewayId?: string; agentId?: string; model?: string; tags?: string[] } | null,
  tasks: [] as Array<Record<string, unknown>>,
  activeTaskId: null as string | null,
  messagesByTask: {} as Record<string, Array<Record<string, unknown>>>,
  chatInputDraftRequests: [] as Array<
    | {
        id: string;
        prompt: string;
        source: string;
        presetId?: string;
      }
    | null
    | undefined
  >,
  chatInputSnapshots: [] as Array<{
    draftRequest?: DraftPromptRequest | null;
    onDraftResolved?: (request: DraftPromptRequest, resolution: DraftPromptResolution) => void;
  }>,
  firstTaskFlowSnapshots: [] as Array<{
    artifactCount: number;
    onGenerateFile: () => void;
    onViewArtifacts: () => void;
  }>,
  goalAnalysis: {
    status: 'idle',
    result: null,
    error: null,
    retry: vi.fn(),
  } as Record<string, unknown>,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
  motion: {
    div: ({ children, className }: { children?: ReactNode; className?: string }) => (
      <div className={className}>{children}</div>
    ),
  },
  useReducedMotion: () => true,
}));

vi.mock('../src/renderer/components/ui/button', () => ({
  Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
}));

vi.mock('../src/renderer/components/ui/dialog', () => ({
  Dialog: ({ children, open }: { children: ReactNode; open: boolean }) =>
    open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

vi.mock('../src/renderer/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuItem: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuSub: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuSubContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuSubTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('../src/renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('../src/renderer/components/ui/popover', () => ({
  Popover: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('../src/renderer/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock('../src/renderer/components/semantic/ConfirmDialog', () => ({ default: () => null }));
vi.mock('../src/renderer/components/semantic/ToolbarButton', () => ({
  default: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
}));
vi.mock('../src/renderer/components/AgentIcon', () => ({ default: () => null }));
vi.mock('../src/renderer/components/GatewayInstanceSelector', () => ({ default: () => null }));
vi.mock('../src/renderer/components/MentionPicker', () => ({ default: () => null }));
vi.mock('../src/renderer/components/SlashArgPicker', () => ({ default: () => null }));
vi.mock('../src/renderer/components/SlashCommandDashboard', () => ({ default: () => null }));
vi.mock('../src/renderer/components/SlashCommandMenu', () => ({ default: () => null }));
vi.mock('../src/renderer/components/ToolsCatalog', () => ({ default: () => null }));
vi.mock('../src/renderer/components/VoiceIntroDialog', () => ({ default: () => null }));
vi.mock('../src/renderer/components/ChatInput/TaskMaterials', () => ({ default: () => null }));

vi.mock('../src/renderer/components/ChatInput', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/components/ChatInput')>();
  const RealChatInput = actual.default;
  return {
    ...actual,
    default: (props: React.ComponentProps<typeof RealChatInput>) => {
      mocks.chatInputDraftRequests.push(props.draftRequest);
      mocks.chatInputSnapshots.push({
        draftRequest: props.draftRequest,
        onDraftResolved: props.onDraftResolved,
      });
      return <RealChatInput {...props} />;
    },
  };
});
vi.mock('../src/renderer/components/ChatMessage', () => ({ default: () => null }));
vi.mock('../src/renderer/components/StreamingMessage', () => ({ default: () => null }));
vi.mock('../src/renderer/components/ThinkingIndicator', () => ({ default: () => null }));
vi.mock('../src/renderer/components/ImageLightbox', () => ({ default: () => null }));
vi.mock('../src/renderer/components/FilePreviewModal', () => ({ default: () => null }));
vi.mock('../src/renderer/components/ConnectionBanner', () => ({ default: () => null }));
vi.mock('../src/renderer/components/EnsembleAgentBar', () => ({ default: () => null }));
vi.mock('../src/renderer/components/data-display/DataTable', () => ({ default: () => null }));
vi.mock('../src/renderer/components/semantic/EmptyState', () => ({ default: () => null }));
vi.mock('../src/renderer/components/semantic/StatusTag', () => ({ default: () => null }));
vi.mock('../src/renderer/components/semantic/WindowTitlebar', () => ({ default: () => null }));
vi.mock('../src/renderer/layouts/FileBrowser', () => ({ default: () => null }));
vi.mock('../src/renderer/layouts/CronPanel', () => ({ default: () => null }));
vi.mock('../src/renderer/layouts/TeamsPanel', () => ({ default: () => null }));
vi.mock('../src/renderer/layouts/Dashboard', () => ({ default: () => null }));
vi.mock('../src/renderer/features/internal-beta/InternalBetaHub', () => ({ default: () => null }));
vi.mock('../src/renderer/layouts/MainArea/StartupReadinessPanel', () => ({ default: () => null }));

vi.mock('../src/renderer/layouts/MainArea/FirstTaskCompletionFlow', () => ({
  default: (props: {
    artifactCount: number;
    onContinue: () => void;
    onGenerateFile: () => void;
    onViewArtifacts: () => void;
  }) => {
    mocks.firstTaskFlowSnapshots.push(props);
    return (
      <>
        <button type="button" data-testid="first-task-continue" onClick={props.onContinue}>
          continue
        </button>
        <button type="button" data-testid="result-generate" onClick={props.onGenerateFile}>
          generate
        </button>
        <button type="button" data-testid="result-view" onClick={props.onViewArtifacts}>
          view
        </button>
      </>
    );
  },
}));

vi.mock('../src/renderer/hooks/useVoiceInput', () => ({
  useVoiceInput: () => ({
    isSupported: false,
    isListening: false,
    isTranscribing: false,
    isIntroOpen: false,
    errorCode: null,
    handleKeyDown: vi.fn(),
    handleKeyUp: vi.fn(),
    confirmIntro: vi.fn(),
    dismissIntro: vi.fn(),
    startFromTrigger: vi.fn(),
    stopListening: vi.fn(),
  }),
}));

vi.mock('../src/renderer/components/ChatInput/useAttachments', () => ({
  useAttachments: () => ({
    pendingAttachments: [],
    setPendingAttachments: vi.fn(),
    removeAttachment: vi.fn(),
    handlePaste: vi.fn(),
  }),
}));

vi.mock('../src/renderer/components/ChatInput/useTaskMaterials', () => ({
  useTaskMaterials: () => ({
    sources: [],
    selectedImportedFiles: [],
    selectedImportedPaths: new Set<string>(),
    importedFiles: [],
    loadSourceFiles: vi.fn(),
    clearSelectedImportedFiles: vi.fn(),
    markImportedFileMissing: vi.fn(),
    toggleImportedFile: vi.fn(),
    revokeSource: vi.fn(),
    importFiles: vi.fn(),
    grantFolder: vi.fn(),
  }),
}));

vi.mock('../src/renderer/components/ChatInput/useMentionPicker', () => ({
  useMentionPicker: () => ({
    mentionVisible: false,
    mentionQuery: '',
    mentionIndex: 0,
    setMentionIndex: vi.fn(),
    mentionTab: 'tasks',
    setMentionTab: vi.fn(),
    selectedTasks: [],
    setSelectedTasks: vi.fn(),
    selectedArtifacts: [],
    setSelectedArtifacts: vi.fn(),
    selectedLocalFiles: [],
    setSelectedLocalFiles: vi.fn(),
    mentionItemsRef: { current: [] },
    updateMentionPicker: vi.fn(),
    closeMentionPicker: vi.fn(),
    commitMention: vi.fn(),
    removeSelectedTask: vi.fn(),
    removeSelectedArtifact: vi.fn(),
    removeSelectedLocalFile: vi.fn(),
    handleMentionItemsChange: vi.fn(),
    selectedAgents: [],
    setSelectedAgents: vi.fn(),
    removeSelectedAgent: vi.fn(),
  }),
}));

vi.mock('../src/renderer/components/ChatInput/useSlashAutocomplete', () => ({
  useSlashAutocomplete: () => ({
    slashMenuVisible: false,
    setSlashMenuVisible: vi.fn(),
    slashCommands: [],
    slashIndex: 0,
    setSlashIndex: vi.fn(),
    dashboardOpen: false,
    setDashboardOpen: vi.fn(),
    argPickerVisible: false,
    argPickerCommand: null,
    argPickerOptions: [],
    argPickerIndex: 0,
    setArgPickerIndex: vi.fn(),
    updateSlashMenu: vi.fn(),
    commitSlashCommand: vi.fn(),
    commitArgOption: vi.fn(),
    closeArgPicker: vi.fn(),
  }),
}));

vi.mock('../src/renderer/components/ChatInput/useChatSend', () => ({
  useChatSend: () => ({
    isGenerating: false,
    aborting: false,
    isOffline: false,
    activeTask: null,
    currentModel: '',
    currentThinking: 'off',
    modelAvailability: 'available',
    toolsCatalog: null,
    modelLabel: 'DeepSeek V4 Flash',
    currentModelEntry: undefined,
    modelsByProvider: {},
    taskGwId: null,
    quotaBlock: null,
    setQuotaBlocked: vi.fn(),
    quotaDegrade: false,
    setQuotaDegrade: vi.fn(),
    switchToFallbackModel: vi.fn(),
    handleSend: mocks.handleSend,
    handleModelQuickSend: vi.fn(),
    handleThinkingQuickSend: vi.fn(),
    handleAbort: vi.fn(),
    handleToolSelect: vi.fn(),
  }),
}));

const taskState = {
  get activeTaskId() {
    return mocks.activeTaskId;
  },
  get tasks() {
    return mocks.tasks;
  },
  get pendingNewTask() {
    return mocks.pendingNewTask;
  },
  startNewTask: vi.fn(),
  updatePending: vi.fn((patch: Record<string, unknown>) => {
    if (mocks.pendingNewTask) mocks.pendingNewTask = { ...mocks.pendingNewTask, ...patch };
  }),
};

const uiState = {
  sendShortcut: 'enter',
  mainView: 'chat',
  settingsOpen: false,
  messageLayout: 'centered',
  defaultGatewayId: 'gw-1',
  rightPanelOpen: false,
  agentCatalogByGateway: {
    'gw-1': {
      defaultId: 'main',
      agents: [
        { id: 'main', name: 'Compass' },
        { id: 'rongying-content', name: 'Content' },
        { id: 'rongying-video', name: 'Video' },
      ],
    },
  },
  modelCatalogByGateway: {
    'gw-1': [{ id: 'deepseek-v4-flash', provider: 'clawrouter', name: 'DeepSeek V4 Flash' }],
  },
  setSettingsOpen: vi.fn(),
  setMainView: vi.fn(),
  setRightPanelOpen: vi.fn(),
  setSelectedAgent: mocks.setSelectedAgent,
  toggleMessageLayout: vi.fn(),
};

const messageState = {
  get messagesByTask() {
    return mocks.messagesByTask;
  },
  activeTurnBySession: {},
  processingBySession: {},
  highlightedMessageId: null,
  setHighlightedMessage: vi.fn(),
  runPhaseBySession: {},
  // B10：MainArea 会读它决定"给不给重试按钮"。手写的 store 桩**必须跟着长**，
  // 缺一个字段就是整屏聊天区渲染崩掉（这里是桩的保真度问题，不是产品代码的问题）。
  retryableErrorBySession: {},
};

const roomState = { rooms: {} };

vi.mock('../src/renderer/platform', () => {
  const useTaskStore = Object.assign(<T,>(selector: (state: typeof taskState) => T) => selector(taskState), {
    getState: () => ({ ...taskState, setPending: mocks.setPending }),
  });
  return {
    useTaskStore,
    useUiStore: <T,>(selector: (state: typeof uiState) => T) => selector(uiState),
    useMessageStore: <T,>(selector: (state: typeof messageState) => T) => selector(messageState),
    useRoomStore: <T,>(selector: (state: typeof roomState) => T) => selector(roomState),
  };
});

vi.mock('../src/renderer/stores/commercialStore', () => ({
  useCommercialStore: <T,>(selector: (state: { overview: null; load: () => Promise<void> }) => T) =>
    selector({ overview: null, load: vi.fn(async () => undefined) }),
}));

vi.mock('../src/renderer/stores/usageStore', () => ({
  useUsageStore: <T,>(selector: (state: Record<string, unknown>) => T) =>
    selector({
      sessionUsage: null,
      cost: null,
      status: null,
      loading: false,
      fetchUsage: vi.fn(),
      startAutoRefresh: vi.fn(),
      stopAutoRefresh: vi.fn(),
    }),
}));

const settingsState = { load: vi.fn(), updateSettings: vi.fn(), settings: null };
vi.mock('../src/renderer/stores/settingsStore', () => {
  const useSettingsStore = <T,>(selector: (state: typeof settingsState) => T) => selector(settingsState);
  useSettingsStore.getState = () => settingsState;
  return { useSettingsStore };
});

vi.mock('../src/renderer/hooks/useGatewaySelector', () => ({
  useGatewaySelector: () => {
    const effectiveAgentId = mocks.pendingNewTask?.agentId ?? 'main';
    return {
      gateways: [],
      selectedGwId: 'gw-1',
      setSelectedGwId: vi.fn(),
      agentCatalog: uiState.agentCatalogByGateway['gw-1'].agents,
      effectiveAgentId,
      setSelectedAgentId: vi.fn(),
    };
  },
}));

vi.mock('../src/renderer/features/goal-routing/useGoalAnalysis', () => ({
  useGoalAnalysis: () => mocks.goalAnalysis,
}));

vi.mock('../src/renderer/hooks/useQuotaRefreshOnTurnEnd', () => ({
  useQuotaRefreshOnTurnEnd: vi.fn(),
}));

vi.mock('../src/renderer/hooks/useGatewayBootstrap', () => ({
  fetchAgentsForGateway: vi.fn(async () => undefined),
}));

vi.mock('@clawwork/core', () => ({
  RUN_PHASE_IDS: [],
  EMPTY_MESSAGES: [],
  activeTurnToMessage: vi.fn(),
  deriveSessionActivity: () => 'idle',
  getTaskSessionKeys: (task: { sessionKey?: string } | undefined) => (task?.sessionKey ? [task.sessionKey] : []),
  serializeIdentityMd: vi.fn(),
}));

import { ChatContent, createDraftPromptRequest } from '../src/renderer/layouts/MainArea';
import { loadRecentAssistantTasks, recordRecentAssistantTask } from '../src/renderer/lib/assistant-task-history';
import { useFileStore } from '../src/renderer/stores/fileStore';

const readiness: StartupReadiness = {
  gatewayId: 'gw-1',
  ai: { phase: 'ready' },
  assistants: { phase: 'ready', completed: 6, total: 6, missingIds: [] },
  workspaceAvailable: true,
  conversationReady: true,
  isReady: true,
  hasError: false,
};

function profile(userId: string, customGoal = ''): OnboardingProfile {
  return {
    version: 1,
    userId,
    nickname: '',
    useCases: ['content'],
    customGoal,
    completedAt: '2026-09-14T00:00:00.000Z',
  };
}

function renderFlow(onboardingProfile = profile('user-1')): {
  container: HTMLDivElement;
  rerender: (nextProfile: OnboardingProfile) => void;
  unmount: () => void;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const renderWith = (nextProfile: OnboardingProfile) =>
    root.render(
      <ChatContent
        onboardingProfile={nextProfile}
        startupReadiness={readiness}
        onRetryStartup={vi.fn(async () => undefined)}
      />,
    );
  act(() => renderWith(onboardingProfile));
  return {
    container,
    rerender: (nextProfile) => act(() => renderWith(nextProfile)),
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function textarea(container: HTMLElement): HTMLTextAreaElement {
  const element = container.querySelector('textarea');
  if (!(element instanceof HTMLTextAreaElement)) throw new Error('textarea not found');
  return element;
}

function click(container: ParentNode, selector: string): void {
  const element = container.querySelector(selector);
  if (!(element instanceof HTMLButtonElement)) throw new Error(`button not found: ${selector}`);
  act(() => element.click());
}

function clickText(label: string): void {
  const element = [...document.body.querySelectorAll('button')].find((button) => button.textContent === label);
  if (!(element instanceof HTMLButtonElement)) throw new Error(`button not found: ${label}`);
  act(() => element.click());
}

describe('assistant task workbench draft flow', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    vi.clearAllMocks();
    mocks.pendingNewTask = {
      gatewayId: 'gw-1',
      agentId: 'rongying-content',
      model: 'deepseek-v4-flash',
      tags: ['private'],
    };
    mocks.tasks = [];
    mocks.activeTaskId = null;
    mocks.messagesByTask = {};
    mocks.chatInputDraftRequests = [];
    mocks.chatInputSnapshots = [];
    mocks.firstTaskFlowSnapshots = [];
    mocks.goalAnalysis = { status: 'idle', result: null, error: null, retry: vi.fn() };
    useFileStore.setState({ artifacts: [], selectedArtifactId: null });
    vi.spyOn(HTMLTextAreaElement.prototype, 'focus').mockImplementation(mocks.focus);
    Object.assign(window, {
      clawwork: {
        checkWhisper: vi.fn(async () => ({ available: false })),
        requestMicrophonePermission: vi.fn(async () => ({ status: 'granted' })),
      },
    });
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates a typed content preset request, applies it to the real composer, and records only after resolution', () => {
    const view = renderFlow();
    expect(loadRecentAssistantTasks('user-1')).toEqual([]);

    click(view.container, '[data-preset-id="content:short-video-script"]');

    expect(textarea(view.container).value).toBe('assistantWorkspaces.content.starters.3.prompt');
    expect(loadRecentAssistantTasks('user-1').map((item) => item.presetId)).toEqual(['content:short-video-script']);
    expect(mocks.pendingNewTask?.tags).toEqual(['private', 'assistant-task-preset:content:short-video-script']);
    expect(mocks.handleSend).not.toHaveBeenCalled();
    view.unmount();
  });

  it('does not record a cancelled preset request or change the existing draft', () => {
    const view = renderFlow();
    textarea(view.container).value = 'Keep my draft';

    click(view.container, '[data-preset-id="content:short-video-script"]');
    expect(loadRecentAssistantTasks('user-1')).toEqual([]);
    clickText('common.cancel');

    expect(textarea(view.container).value).toBe('Keep my draft');
    expect(loadRecentAssistantTasks('user-1')).toEqual([]);
    expect(mocks.pendingNewTask?.tags).toEqual(['private']);
    expect(mocks.handleSend).not.toHaveBeenCalled();
    view.unmount();
  });

  it.each([
    ['taskWorkbench.appendDraft', 'Keep my draft\n\nassistantWorkspaces.content.starters.3.prompt'],
    ['taskWorkbench.replaceDraft', 'assistantWorkspaces.content.starters.3.prompt'],
  ])('records an accepted conflict once for the active user via %s', (action, expectedDraft) => {
    const storageWrite = vi.spyOn(Storage.prototype, 'setItem');
    const view = renderFlow();
    textarea(view.container).value = 'Keep my draft';

    click(view.container, '[data-preset-id="content:short-video-script"]');
    clickText(action);

    expect(textarea(view.container).value).toBe(expectedDraft);
    expect(loadRecentAssistantTasks('user-1').map((item) => item.presetId)).toEqual(['content:short-video-script']);
    expect(loadRecentAssistantTasks('user-2')).toEqual([]);
    expect(mocks.pendingNewTask?.tags).toEqual(['private', 'assistant-task-preset:content:short-video-script']);
    expect(storageWrite).toHaveBeenCalledTimes(1);
    expect(storageWrite.mock.calls[0]?.[0]).toContain('user-1');
    expect(mocks.handleSend).not.toHaveBeenCalled();
    view.unmount();
  });

  it('keeps only the most recently accepted canonical preset on a pending task', () => {
    const view = renderFlow();

    click(view.container, '[data-preset-id="content:topic-planning"]');
    click(view.container, '[data-preset-id="content:short-video-script"]');
    clickText('taskWorkbench.replaceDraft');

    expect(mocks.pendingNewTask?.tags).toEqual(['private', 'assistant-task-preset:content:short-video-script']);
    view.unmount();
  });

  it('reloads isolated recent history when the active user changes', () => {
    recordRecentAssistantTask('user-1', 'content:short-video-script', undefined, '2026-09-15T00:00:00.000Z');
    recordRecentAssistantTask('user-2', 'content:long-form-writing', undefined, '2026-09-16T00:00:00.000Z');
    const view = renderFlow(profile('user-1'));

    expect(
      view.container.querySelector('[data-testid="assistant-task-recent-preset"]')?.getAttribute('data-preset-id'),
    ).toBe('content:short-video-script');

    view.rerender(profile('user-2'));

    expect(
      view.container.querySelector('[data-testid="assistant-task-recent-preset"]')?.getAttribute('data-preset-id'),
    ).toBe('content:long-form-writing');
    expect(view.container.querySelector('[data-preset-id="content:short-video-script"]')).not.toBeNull();
    view.unmount();
  });

  it('switches workbenches without leaking content presets into another assistant', () => {
    const view = renderFlow();
    expect(view.container.querySelector('[data-preset-id="content:short-video-script"]')).not.toBeNull();

    mocks.pendingNewTask = { gatewayId: 'gw-1', agentId: 'rongying-video', model: 'deepseek-v4-flash' };
    view.rerender(profile('user-1'));

    expect(view.container.querySelector('[data-preset-id="content:short-video-script"]')).toBeNull();
    expect(view.container.querySelector('[data-preset-id="video:shooting-script"]')).not.toBeNull();
    view.unmount();
  });

  it('focuses for a custom task without changing or sending the existing draft', () => {
    const view = renderFlow();
    textarea(view.container).value = 'Keep my draft';

    click(view.container, '[data-testid="assistant-task-custom"]');

    expect(textarea(view.container).value).toBe('Keep my draft');
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(loadRecentAssistantTasks('user-1')).toEqual([]);
    expect(mocks.pendingNewTask?.tags).toEqual(['private']);
    expect(mocks.focus).toHaveBeenCalledTimes(1);
    expect(mocks.handleSend).not.toHaveBeenCalled();
    view.unmount();
  });

  it('revokes a conflicting preset when the account changes and never records either user', () => {
    const view = renderFlow(profile('user-a'));
    const composer = textarea(view.container);
    composer.value = 'Account A draft';
    click(view.container, '[data-preset-id="content:short-video-script"]');
    const oldAppend = [...document.body.querySelectorAll('button')].find(
      (button) => button.textContent === 'taskWorkbench.appendDraft',
    );
    expect(oldAppend).toBeInstanceOf(HTMLButtonElement);
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();

    view.rerender(profile('user-b'));

    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    act(() => (oldAppend as HTMLButtonElement).click());
    expect(composer.value).toBe('Account A draft');
    expect(loadRecentAssistantTasks('user-a')).toEqual([]);
    expect(loadRecentAssistantTasks('user-b')).toEqual([]);
    expect(mocks.handleSend).not.toHaveBeenCalled();
    view.unmount();
  });

  it.each([
    ['assistant', { gatewayId: 'gw-1', agentId: 'rongying-video', model: 'deepseek-v4-flash' }],
    ['gateway', { gatewayId: 'gw-2', agentId: 'rongying-content', model: 'deepseek-v4-flash' }],
  ])('revokes a conflicting preset when the %s changes', (_scope, nextPendingTask) => {
    const view = renderFlow(profile('user-1'));
    const composer = textarea(view.container);
    composer.value = 'Scoped draft';
    click(view.container, '[data-preset-id="content:short-video-script"]');
    const oldReplace = [...document.body.querySelectorAll('button')].find(
      (button) => button.textContent === 'taskWorkbench.replaceDraft',
    );
    expect(oldReplace).toBeInstanceOf(HTMLButtonElement);
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    const pendingSnapshot = mocks.chatInputSnapshots.filter((snapshot) => snapshot.draftRequest).at(-1);
    expect(pendingSnapshot?.draftRequest).toBeDefined();

    mocks.pendingNewTask = nextPendingTask;
    act(() => pendingSnapshot?.onDraftResolved?.(pendingSnapshot.draftRequest as DraftPromptRequest, 'replaced'));
    expect(composer.value).toBe('Scoped draft');
    expect(loadRecentAssistantTasks('user-1')).toEqual([]);
    view.rerender(profile('user-1'));

    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    act(() => (oldReplace as HTMLButtonElement).click());
    expect(composer.value).toBe('Scoped draft');
    expect(loadRecentAssistantTasks('user-1')).toEqual([]);
    expect(mocks.handleSend).not.toHaveBeenCalled();
    view.unmount();
  });

  it('rejects a preset resolution from another active task in the same agent and gateway scope', () => {
    mocks.activeTaskId = 'task-a';
    mocks.tasks = [
      { id: 'task-a', sessionKey: 'agent:rongying-content:clawwork:task:task-a', gatewayId: 'gw-1' },
      { id: 'task-b', sessionKey: 'agent:rongying-content:clawwork:task:task-b', gatewayId: 'gw-1' },
    ];
    const view = renderFlow(profile('user-1'));
    const composer = textarea(view.container);
    composer.value = 'Task A draft';
    click(view.container, '[data-preset-id="content:short-video-script"]');
    const pendingSnapshot = mocks.chatInputSnapshots.filter((snapshot) => snapshot.draftRequest).at(-1);
    expect(pendingSnapshot?.draftRequest).toBeDefined();

    mocks.activeTaskId = 'task-b';
    act(() => pendingSnapshot?.onDraftResolved?.(pendingSnapshot.draftRequest as DraftPromptRequest, 'replaced'));

    expect(loadRecentAssistantTasks('user-1')).toEqual([]);
    expect(composer.value).toBe('Task A draft');
    expect(mocks.handleSend).not.toHaveBeenCalled();
    view.unmount();
  });

  it('routes goal starters and first-task follow-ups through their typed sources', () => {
    expect(createDraftPromptRequest(1, 'Goal prompt', 'goal-routing')).toEqual({
      id: 'draft-request-1',
      prompt: 'Goal prompt',
      source: 'goal-routing',
    });
    expect(createDraftPromptRequest(2, 'Follow-up prompt', 'first-task-follow-up')).toEqual({
      id: 'draft-request-2',
      prompt: 'Follow-up prompt',
      source: 'first-task-follow-up',
    });

    mocks.goalAnalysis = {
      status: 'ready',
      result: {
        kind: 'preset',
        assistantId: 'rongying-content',
        summary: 'Content',
        reason: 'Reason',
        model: 'deepseek-v4-flash',
        starters: ['Goal prompt'],
      },
      error: null,
      retry: vi.fn(),
    };
    const goalView = renderFlow(profile('user-1', 'Grow content'));
    clickText('Goal prompt');
    expect(textarea(goalView.container).value).toBe('Goal prompt');
    expect(mocks.chatInputDraftRequests.filter(Boolean).at(-1)).toMatchObject({
      prompt: 'Goal prompt',
      source: 'goal-routing',
    });
    goalView.unmount();

    mocks.chatInputDraftRequests = [];
    mocks.activeTaskId = 'task-1';
    mocks.tasks = [{ id: 'task-1', sessionKey: 'agent:main:clawwork:task:task-1', gatewayId: 'gw-1' }];
    mocks.messagesByTask = {
      'task-1': [
        { id: 'm1', role: 'user', content: 'Question', timestamp: '2026-09-14T00:00:01.000Z' },
        { id: 'm2', role: 'assistant', content: 'Answer', timestamp: '2026-09-14T00:00:02.000Z' },
      ],
    };
    const followUpView = renderFlow();
    click(followUpView.container, '[data-testid="first-task-continue"]');
    expect(textarea(followUpView.container).value).toBe('firstTaskCompletion.continuePrompt');
    expect(mocks.chatInputDraftRequests.filter(Boolean).at(-1)).toMatchObject({
      prompt: 'firstTaskCompletion.continuePrompt',
      source: 'first-task-follow-up',
    });
    expect(mocks.handleSend).not.toHaveBeenCalled();
    followUpView.unmount();
  });

  it('uses the completed task preset follow-up copy without sending automatically', () => {
    mocks.activeTaskId = 'task-1';
    mocks.tasks = [
      {
        id: 'task-1',
        sessionKey: 'agent:rongying-content:clawwork:task:task-1',
        gatewayId: 'gw-1',
        tags: ['private', 'assistant-task-preset:content:short-video-script'],
      },
    ];
    mocks.messagesByTask = completedMessages('task-1');
    const view = renderFlow();

    click(view.container, '[data-testid="first-task-continue"]');

    expect(textarea(view.container).value).toBe('assistantWorkspaces.content.starters.3.followUpPrompt');
    expect(mocks.chatInputDraftRequests.filter(Boolean).at(-1)).toMatchObject({
      prompt: 'assistantWorkspaces.content.starters.3.followUpPrompt',
      source: 'first-task-follow-up',
    });
    expect(mocks.handleSend).not.toHaveBeenCalled();
    view.unmount();
  });

  it('falls back to the generic follow-up for an unknown preset tag', () => {
    mocks.activeTaskId = 'task-1';
    mocks.tasks = [
      {
        id: 'task-1',
        sessionKey: 'agent:main:clawwork:task:task-1',
        gatewayId: 'gw-1',
        tags: ['assistant-task-preset:content:unknown'],
      },
    ];
    mocks.messagesByTask = completedMessages('task-1');
    const view = renderFlow();

    click(view.container, '[data-testid="first-task-continue"]');

    expect(textarea(view.container).value).toBe('firstTaskCompletion.continuePrompt');
    expect(mocks.handleSend).not.toHaveBeenCalled();
    view.unmount();
  });

  it('falls back to the generic follow-up when the tagged preset belongs to another assistant', () => {
    mocks.activeTaskId = 'task-1';
    mocks.tasks = [
      {
        id: 'task-1',
        sessionKey: 'agent:main:clawwork:task:task-1',
        gatewayId: 'gw-1',
        agentId: 'main',
        tags: ['assistant-task-preset:content:short-video-script'],
      },
    ];
    mocks.messagesByTask = completedMessages('task-1');
    const view = renderFlow();

    click(view.container, '[data-testid="first-task-continue"]');

    expect(textarea(view.container).value).toBe('firstTaskCompletion.continuePrompt');
    expect(mocks.handleSend).not.toHaveBeenCalled();
    view.unmount();
  });

  it('requests a result-action draft without sending or creating an artifact', () => {
    mocks.activeTaskId = 'task-1';
    mocks.tasks = [{ id: 'task-1', sessionKey: 'agent:main:clawwork:task:task-1', gatewayId: 'gw-1' }];
    mocks.messagesByTask = completedMessages('task-1');
    const unrelatedArtifact = makeArtifact({ id: 'other', taskId: 'task-2' });
    useFileStore.setState({ artifacts: [unrelatedArtifact], selectedArtifactId: null });
    const view = renderFlow();

    expect(mocks.firstTaskFlowSnapshots.at(-1)?.artifactCount).toBe(0);
    click(view.container, '[data-testid="result-generate"]');

    expect(textarea(view.container).value).toBe('taskWorkbench.generateFilePrompt');
    expect(mocks.chatInputDraftRequests.filter(Boolean).at(-1)).toMatchObject({
      prompt: 'taskWorkbench.generateFilePrompt',
      source: 'result-action',
    });
    expect(mocks.handleSend).not.toHaveBeenCalled();
    expect(useFileStore.getState().artifacts).toEqual([unrelatedArtifact]);
    view.unmount();
  });

  it('revokes a conflicting result-action request when the active task changes within the same owner scope', () => {
    mocks.activeTaskId = 'task-a';
    mocks.tasks = [
      { id: 'task-a', sessionKey: 'agent:main:clawwork:task:task-a', gatewayId: 'gw-1', agentId: 'main' },
      { id: 'task-b', sessionKey: 'agent:main:clawwork:task:task-b', gatewayId: 'gw-1', agentId: 'main' },
    ];
    mocks.messagesByTask = {
      ...completedMessages('task-a'),
      ...completedMessages('task-b'),
    };
    const view = renderFlow();
    textarea(view.container).value = 'Task A draft';

    click(view.container, '[data-testid="result-generate"]');
    const oldReplace = [...document.body.querySelectorAll('button')].find(
      (button) => button.textContent === 'taskWorkbench.replaceDraft',
    );
    expect(oldReplace).toBeInstanceOf(HTMLButtonElement);
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();

    mocks.activeTaskId = 'task-b';
    view.rerender(profile('user-1'));

    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    const taskBComposer = textarea(view.container);
    taskBComposer.value = 'Task B draft';
    act(() => (oldReplace as HTMLButtonElement).click());
    expect(taskBComposer.value).toBe('Task B draft');
    expect(mocks.handleSend).not.toHaveBeenCalled();
    view.unmount();
  });

  it('opens artifacts and selects the newest artifact from only the active task', () => {
    mocks.activeTaskId = 'task-1';
    mocks.tasks = [{ id: 'task-1', sessionKey: 'agent:main:clawwork:task:task-1', gatewayId: 'gw-1' }];
    mocks.messagesByTask = completedMessages('task-1');
    const older = makeArtifact({ id: 'older', createdAt: '2026-09-16T08:00:00.000Z' });
    const unrelated = makeArtifact({ id: 'other-task', taskId: 'task-2', createdAt: '2026-09-17T10:00:00.000Z' });
    const newest = makeArtifact({ id: 'newest', createdAt: '2026-09-17T09:00:00.000Z' });
    useFileStore.setState({ artifacts: [older, unrelated, newest], selectedArtifactId: null });
    const view = renderFlow();

    expect(mocks.firstTaskFlowSnapshots.at(-1)?.artifactCount).toBe(2);
    click(view.container, '[data-testid="result-view"]');

    expect(uiState.setRightPanelOpen).toHaveBeenCalledWith(true);
    expect(useFileStore.getState().selectedArtifactId).toBe('newest');
    view.unmount();
  });

  it('sorts missing, empty, and invalid artifact dates behind valid dates', () => {
    mocks.activeTaskId = 'task-1';
    mocks.tasks = [{ id: 'task-1', sessionKey: 'agent:main:clawwork:task:task-1', gatewayId: 'gw-1' }];
    mocks.messagesByTask = completedMessages('task-1');
    const missing = makeArtifact({ id: 'missing-date' });
    delete (missing as Partial<Artifact>).createdAt;
    const empty = makeArtifact({ id: 'empty-date', createdAt: '' });
    const invalid = makeArtifact({ id: 'invalid-date', createdAt: 'not-a-date' });
    const valid = makeArtifact({ id: 'valid-date', createdAt: '2026-09-17T09:00:00.000Z' });
    useFileStore.setState({ artifacts: [missing, empty, invalid, valid], selectedArtifactId: null });
    const view = renderFlow();

    click(view.container, '[data-testid="result-view"]');

    expect(useFileStore.getState().selectedArtifactId).toBe('valid-date');
    view.unmount();
  });

  it('keeps store order when artifact dates are equal', () => {
    mocks.activeTaskId = 'task-1';
    mocks.tasks = [{ id: 'task-1', sessionKey: 'agent:main:clawwork:task:task-1', gatewayId: 'gw-1' }];
    mocks.messagesByTask = completedMessages('task-1');
    const first = makeArtifact({ id: 'first', createdAt: '2026-09-17T09:00:00.000Z' });
    const second = makeArtifact({ id: 'second', createdAt: '2026-09-17T09:00:00.000Z' });
    useFileStore.setState({ artifacts: [first, second], selectedArtifactId: null });
    const view = renderFlow();

    click(view.container, '[data-testid="result-view"]');

    expect(useFileStore.getState().selectedArtifactId).toBe('first');
    view.unmount();
  });

  it('does not open or select artifacts when the active task has none', () => {
    mocks.activeTaskId = 'task-1';
    mocks.tasks = [{ id: 'task-1', sessionKey: 'agent:main:clawwork:task:task-1', gatewayId: 'gw-1' }];
    mocks.messagesByTask = completedMessages('task-1');
    useFileStore.setState({ artifacts: [makeArtifact({ id: 'other', taskId: 'task-2' })], selectedArtifactId: null });
    const view = renderFlow();

    expect(mocks.firstTaskFlowSnapshots.at(-1)?.onViewArtifacts).toEqual(expect.any(Function));
    click(view.container, '[data-testid="result-view"]');

    expect(uiState.setRightPanelOpen).not.toHaveBeenCalled();
    expect(useFileStore.getState().selectedArtifactId).toBeNull();
    view.unmount();
  });
});

function makeArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: 'artifact-1',
    taskId: 'task-1',
    messageId: 'message-1',
    type: 'file',
    name: 'report.pdf',
    filePath: 'report.pdf',
    localPath: 'task-1/report.pdf',
    mimeType: 'application/pdf',
    size: 2048,
    createdAt: '2026-09-16T08:00:00.000Z',
    availability: 'available',
    ...overrides,
  };
}

function completedMessages(taskId: string): Record<string, Array<Record<string, unknown>>> {
  return {
    [taskId]: [
      { id: 'm1', role: 'user', content: 'Question', timestamp: '2026-09-14T00:00:01.000Z' },
      { id: 'm2', role: 'assistant', content: 'Answer', timestamp: '2026-09-14T00:00:02.000Z' },
    ],
  };
}
