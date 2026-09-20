// @vitest-environment jsdom

import { act, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DraftPromptRequest, DraftPromptResolution } from '../src/renderer/components/ChatInput/types';

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
vi.mock('../src/renderer/components/ChatMessage', () => ({
  default: ({ message }: { message: { content: string } }) => <div data-testid="chat-message">{message.content}</div>,
}));
vi.mock('../src/renderer/components/StreamingMessage', () => ({
  default: ({ content }: { content: string }) => <div data-testid="streaming-message">{content}</div>,
}));
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
  activeTurnBySession: {} as Record<string, unknown>,
  // ⚠️ 生产里是 `Set`（`message-store.ts` 的 `processingBySession: Set<string>`）。
  //    桩里原来写成 `{}` —— 那是**保真度不够**：`deriveSessionActivity` 会调
  //    `processingBySession.has(...)`，普通对象上会 TypeError。现在跟着生产写成 Set。
  processingBySession: new Set<string>(),
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

/**
 * ⚠️ 这里原来把 `deriveSessionActivity` **写成常量 `'idle'`** —— 那是保真度不足：
 * 等待态（`waiting`）分支在这个文件里**根本走不到**，于是"等待→流式"那次交接
 * （2026-09-20 报障：头像闪一下）不可能被这里测到。
 * ⇒ 现在只替换**确实有副作用**的那几个，其余（`deriveSessionActivity` /
 *   `pickWaitingSessionKey` / `getTaskSessionKeys`）用**真身**。
 */
vi.mock('@clawwork/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clawwork/core')>();
  return {
    ...actual,
    RUN_PHASE_IDS: [],
    EMPTY_MESSAGES: [],
    activeTurnToMessage: vi.fn(),
    serializeIdentityMd: vi.fn(),
  };
});

import MainArea from '../src/renderer/layouts/MainArea';

/**
 * 发送消息时聊天区**不能整块重挂载**。
 *
 * 2026-09-17 实机反馈：「发送后内容区域会空白约 1 秒」。根因是两处叠加：
 * 1. `MainArea` 给聊天列挂了 `key={chat-${activeTaskId}}`，而新任务的第一条消息会先把
 *    pending 任务 commit 成真任务（`commitPendingTask`）⇒ activeTaskId 从 null 变成 id
 *    ⇒ 整列（含用户刚打字的输入框）被卸载重建；
 * 2. `ChatContent` 里 `showWelcome` 为真时 return 的是另一棵树（欢迎页 + 输入框），
 *    为假时是消息列表 + 输入框 —— 两棵树的**子节点数量不同**，React 只能整块重建。
 *
 * 这里钉住的不变量：**输入框节点与已渲染的消息节点，在发送 / 任务激活前后必须是同一个
 * DOM 节点**（同一节点 = 没被卸载过 = 旧内容持续可见）。
 */

const readiness = {
  gatewayId: 'gw-1',
  ai: { phase: 'ready' },
  assistants: { phase: 'ready', completed: 6, total: 6, missingIds: [] },
  workspaceAvailable: true,
  conversationReady: true,
  isReady: true,
  hasError: false,
} as unknown as Parameters<typeof MainArea>[0]['startupReadiness'];

function profile(userId: string) {
  return {
    version: 1,
    userId,
    nickname: '',
    useCases: ['content'],
    customGoal: '',
    completedAt: '2026-09-14T00:00:00.000Z',
  } as unknown as Parameters<typeof MainArea>[0]['onboardingProfile'];
}

function activeTask() {
  return {
    id: 'task-1',
    sessionKey: 'agent:rongying-content:clawwork:abc:task:task-1',
    sessionId: '',
    title: 'Task 1',
    status: 'active',
    createdAt: '2026-09-17T05:11:54.000Z',
    updatedAt: '2026-09-17T05:11:54.000Z',
    tags: [],
    artifactDir: '',
    gatewayId: 'gw-1',
    agentId: 'rongying-content',
  };
}

function userMessage(id: string, content: string) {
  return {
    id,
    taskId: 'task-1',
    role: 'user',
    content,
    artifacts: [],
    toolCalls: [],
    timestamp: '2026-09-17T05:11:54.000Z',
  };
}

function renderMainArea(): { container: HTMLDivElement; rerender: () => void; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const render = () =>
    root.render(
      <MainArea
        onTogglePanel={vi.fn()}
        onboardingProfile={profile('user-1')}
        startupReadiness={readiness}
        onRetryStartup={vi.fn(async () => undefined)}
      />,
    );
  act(() => render());
  return {
    container,
    rerender: () => act(() => render()),
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe('聊天区在发送时的稳定性', () => {
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
    mocks.goalAnalysis = { status: 'idle', result: null, error: null, retry: vi.fn() };
    messageState.processingBySession = new Set<string>();
    messageState.activeTurnBySession = {};
    Object.assign(window, { clawwork: {} });
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  it('keeps the same composer node when the pending task becomes active on first send', () => {
    const view = renderMainArea();
    const composer = view.container.querySelector('textarea');
    expect(composer).not.toBeNull();

    mocks.tasks = [activeTask()];
    mocks.activeTaskId = 'task-1';
    mocks.pendingNewTask = null;
    mocks.messagesByTask = { 'task-1': [userMessage('msg-1', '帮我做一个教案')] };
    view.rerender();

    expect(view.container.querySelector('textarea')).toBe(composer);
    expect(view.container.querySelector('[data-testid="chat-message"]')?.textContent).toContain('帮我做一个教案');
    view.unmount();
  });

  it('keeps earlier messages mounted when the next message is appended', () => {
    const first = userMessage('msg-1', '第一条消息');
    mocks.messagesByTask = { 'task-1': [first] };
    mocks.activeTaskId = 'task-1';
    mocks.tasks = [activeTask()];

    const view = renderMainArea();
    const rendered = [...view.container.querySelectorAll('[data-testid="chat-message"]')];
    expect(rendered).toHaveLength(1);

    mocks.messagesByTask = { 'task-1': [first, userMessage('msg-2', '第二条消息')] };
    view.rerender();

    const after = [...view.container.querySelectorAll('[data-testid="chat-message"]')];
    expect(after.map((node) => node.textContent)).toEqual(['第一条消息', '第二条消息']);
    // 同一个 DOM 节点 = 第一条消息没有被卸载重建过（用户看不到「突然变空」）
    expect(after[0]).toBe(rendered[0]);
    view.unmount();
  });

  /**
   * 2026-09-20 实机报障：「我发完要求，那个对话头像会消失一下，然后再给我反馈」。
   *
   * 根因：**等待态**渲染的是 `ThinkingIndicator`（它自带一个头像），**内容一到**换成
   * `StreamingMessage`（另一个头像）——两个块各自淡入淡出，同一帧里**两个头像并存**
   * （MutationObserver 实测抓到 `头像=2` + 跳动点=3）。用户看到的就是"头像闪一下"。
   *
   * 修法：等待态也走 `StreamingMessage`、**用同一个 key**，React 复用同一个 DOM 节点。
   * 这条断言守的就是"复用"本身 —— 只要节点还是同一个，头像就不可能闪。
   */
  it('⭐ 等待中 → 收到内容：助手块必须是**同一个 DOM 节点**（否则头像会闪一下）', () => {
    const SESSION = 'agent:rongying-content:clawwork:abc:task:task-1';
    mocks.tasks = [activeTask()];
    mocks.activeTaskId = 'task-1';
    mocks.messagesByTask = { 'task-1': [userMessage('msg-1', '你好')] };
    // 等待中：正在处理，但什么都还没到
    messageState.processingBySession = new Set([SESSION]);
    messageState.activeTurnBySession = {};

    const view = renderMainArea();
    const waiting = view.container.querySelector('[data-testid="streaming-message"]');
    const parentBefore = waiting?.parentElement ?? null;
    if (process.env.DBG)
      console.log(
        'BEFORE-PARENT',
        waiting?.parentElement?.tagName,
        waiting?.parentElement?.className,
        'CHILDREN',
        waiting?.parentElement?.children.length,
        'HTML',
        waiting?.parentElement?.innerHTML?.slice(0, 300),
      );
    expect(waiting, '等待态也应该有一个助手块（头像+名字），而不是另一个组件').not.toBeNull();

    // 第一段内容到了（推理先来）
    messageState.activeTurnBySession = {
      [SESSION]: {
        id: 'turn-1',
        streamingText: '',
        streamingThinking: '正在想…',
        toolCalls: [],
        finalized: false,
        content: '',
        timestamp: '2026-09-20T00:00:00.000Z',
      },
    };
    view.rerender();

    const after = view.container.querySelector('[data-testid="streaming-message"]');
    if (process.env.DBG) {
      let anc = 0;
      let x = after?.parentElement;
      let y = parentBefore;
      while (x && y && x === y) {
        anc++;
        x = x.parentElement;
        y = y.parentElement;
      }
      console.log(
        'SAME-ANCESTOR-DEPTH',
        anc,
        'PARENT-SAME',
        after?.parentElement === parentBefore,
        'DIVERGED-AT',
        x?.tagName,
        x?.className?.slice(0, 60),
        'vs',
        y?.tagName,
        y?.className?.slice(0, 60),
      );
    }
    expect(after, '内容到了之后助手块不能消失').not.toBeNull();
    expect(after, '必须是同一个节点 —— 换了节点就等于头像被卸载重建了一次').toBe(waiting);
    view.unmount();
  });

  /**
   * 等待项用的是**固定哨兵时间戳**（`WAITING_ITEM_TIMESTAMP`），注释里写的理由是
   * 「等待中的那一块永远排在最后（它确实是"此刻正在发生的事"）」。
   *
   * ⚠️ 这条断言刻意用一条**未来**时间戳的消息：写 `Date.now()` 的实现会排到它前面 ⇒
   * 只有这样这条测试才**分得开**两种实现（变异 K8 就是靠它抓到的）。
   */
  it('⭐ 等待中那一块永远排在最后（哨兵时间戳，不是 `Date.now()`）', () => {
    const SESSION = 'agent:rongying-content:clawwork:abc:task:task-1';
    mocks.tasks = [activeTask()];
    mocks.activeTaskId = 'task-1';
    mocks.messagesByTask = {
      'task-1': [{ ...userMessage('msg-1', '你好'), timestamp: '2099-01-01T00:00:00.000Z' }],
    };
    messageState.processingBySession = new Set([SESSION]);
    messageState.activeTurnBySession = {};

    const view = renderMainArea();
    const message = view.container.querySelector('[data-testid="chat-message"]');
    const waiting = view.container.querySelector('[data-testid="streaming-message"]');
    expect(waiting, '等待态该有一个助手块').not.toBeNull();
    expect(message, '那条消息该在').not.toBeNull();
    expect(
      message!.compareDocumentPosition(waiting!) & Node.DOCUMENT_POSITION_FOLLOWING,
      '等待块要排在那条消息**之后**',
    ).toBeTruthy();
    view.unmount();
  });
});
