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

vi.mock('framer-motion', () => {
  // ⚠️ 必须把 `data-testid` 之类的**普通 props 透传下去**：只转发 `className` 的假 div 会让
  //    `[data-testid="assistant-block"]` 永远查不到 —— 于是"块不见了"这种假红，掩盖真问题。
  //    （同样的自伤形状：假组件每次返回新类型 ⇒ React 每渲染都当换组件卸载重建。）
  const MOTION_ONLY = new Set(['initial', 'animate', 'exit', 'transition', 'variants', 'whileHover', 'whileTap']);
  const div = ({ children, ...rest }: { children?: ReactNode } & Record<string, unknown>) => (
    <div {...Object.fromEntries(Object.entries(rest).filter(([key]) => !MOTION_ONLY.has(key)))}>{children}</div>
  );
  return {
    AnimatePresence: ({ children }: { children: ReactNode }) => children,
    motion: { div },
    useReducedMotion: () => true,
  };
});

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
  DropdownMenuSeparator: () => <hr />,
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
// 只有**用户/系统**消息还走 `ChatMessage`；助手那一格现在统一是 `AssistantBlock`
//（真身 —— 它带真头像，那正是本文件要盯的东西），身体里的组件不必桩。
vi.mock('../src/renderer/components/ChatMessage', () => ({
  default: ({ message }: { message: { content: string } }) => <div data-testid="chat-message">{message.content}</div>,
}));
vi.mock('../src/renderer/components/ThinkingIndicator', () => ({ default: () => null }));
vi.mock('../src/renderer/components/ImageLightbox', () => ({ default: () => null }));
vi.mock('../src/renderer/components/FilePreviewModal', () => ({ default: () => null }));
vi.mock('../src/renderer/components/ConnectionBanner', () => ({ default: () => null }));
vi.mock('../src/renderer/components/EnsembleAgentBar', () => ({ default: () => null }));
// 「团队协作」条读团队会议 store（`features/team-meeting/instance` 会拉整个 platform 端口）。
// 这个文件只测"发送不重建节点"，把条本身钉成 null —— 它有自己的 `team-collab-bar.test.tsx`。
vi.mock('../src/renderer/features/team-meeting/TeamCollabBar', () => ({ default: () => null }));
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
    // BUG-028：离开一段对话时输入框会调它清暂存附件（桩必须跟着长）。
    clearAttachments: vi.fn(),
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
    removeImportedFileReference: vi.fn(),
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

/**
 * ⚠️ 这个桩原来把 `modelAvailability` **写死成 `'available'`** —— 那是**从来不存在**的取值
 * （真身联合是 `'service-starting' | 'models-loading' | 'catalog-failed' | 'empty' | 'ready'`）。
 * 写死的值不会跟着产品走：产品把"目录取不到"单列成一档之后，桩照样报 `'available'` ⇒
 * 「store → 可用性 → 输入框文案」这条链子在这个文件里**根本跑不到真身**（新加的用例就是
 * 这么红起来的：DOM 里只有模型名，没有任何状态文案）。
 * ⇒ 桩改成**现算**：用真身 `deriveModelAvailability`，输入取真实 store 桩的状态。
 */
vi.mock('../src/renderer/components/ChatInput/useChatSend', async () => {
  const { deriveModelAvailability } = await import('../src/renderer/components/ChatInput/model-availability');
  const { relayModelsFrom } = await import('../src/renderer/components/ChatInput/model-families');
  const { deriveGatewayDisplayPhase } = await import('../src/renderer/lib/gateway-display-phase');
  const availabilityFor = (gatewayId: string | null) => {
    const rawCatalog = gatewayId ? uiState.modelCatalogByGateway[gatewayId] : undefined;
    return deriveModelAvailability({
      gatewayId,
      gatewayStatus: gatewayId ? uiState.gatewayStatusMap[gatewayId] : undefined,
      rawCatalog,
      catalogFailed: gatewayId ? uiState.modelCatalogFailureByGateway[gatewayId] === true : false,
      modelCount: relayModelsFrom(rawCatalog ?? []).length,
    });
  };
  /**
   * ⚠️ 这个桩**必须跟真身同一条规则**，否则这一格测的是桩、不是产品。
   *
   * 原来这里写死 `isOffline: false`，而且**根本没给 `gatewayDisplayPhase`**（缺字段 ⇒
   * `ChatInput` 拿到 `undefined`）。后果：「预热期输入框不许说离线只读」那条用例其实是
   * 靠 `readinessBlocked: true` 才绿的 —— 把判据顺序调换（变异 M4：先判 `isOffline`）
   * 它照样绿，也就是说**那条缝根本没被钉住**（2026-09-20 变异验证打出来的）。
   * 规则照抄 `ChatInput/useChatSend.ts` 的 `isOffline` / `gatewayDisplayPhase` 两处；
   * 真身那条缝本身由 `test/use-chat-send.test.tsx` 用**真 hook** 另钉一遍。
   *
   * 网关 id 取 `pendingNewTask.gatewayId ?? defaultGatewayId`：这个文件里活跃任务永远是
   * `gw-1`，与真身的 `activeTask?.gatewayId ?? pendingNewTask?.gatewayId` 同解。
   */
  const taskGatewayId = (): string | null => mocks.pendingNewTask?.gatewayId ?? uiState.defaultGatewayId ?? null;
  const isOfflineFor = (): boolean => {
    const gwId = taskGatewayId();
    if (gwId) {
      const st = uiState.gatewayStatusMap[gwId];
      return st === 'disconnected' || st === undefined;
    }
    const values = Object.values(uiState.gatewayStatusMap);
    return values.length > 0 && !values.some((v) => v === 'connected');
  };
  const displayPhaseFor = () => {
    const gwId = taskGatewayId();
    return deriveGatewayDisplayPhase({
      status: gwId ? uiState.gatewayStatusMap[gwId] : undefined,
      everConnected: gwId ? uiState.gatewayEverConnected[gwId] === true : false,
      reconnect: gwId ? uiState.gatewayReconnectInfo[gwId] : undefined,
    });
  };
  return {
    useChatSend: () => ({
      isGenerating: false,
      aborting: false,
      isOffline: isOfflineFor(),
      gatewayDisplayPhase: displayPhaseFor(),
      activeTask: null,
      currentModel: '',
      currentThinking: 'off',
      modelAvailability: availabilityFor(mocks.pendingNewTask?.gatewayId ?? null),
      toolsCatalog: null,
      modelLabel: 'DeepSeek V4 Flash',
      currentModelEntry: undefined,
      currentMode: 'custom',
      modelCatalog: [],
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
  };
});

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
  // ⚠️ 按**真实 store 的类型**写宽（`Record<string, …>`，不是一个字面量对象）：
  //    窄写法会让"某个网关暂时没有目录"这种真实状态在桩里**根本表达不出来**。
  modelCatalogByGateway: {
    'gw-1': [{ id: 'deepseek-v4-flash', provider: 'clawrouter', name: 'DeepSeek V4 Flash' }],
  } as Record<string, Array<{ id: string; provider: string; name?: string }>>,
  // 手写 store 桩**必须跟着长**（缺一个字段 = 整屏渲染崩）。
  modelCatalogFailureByGateway: {} as Record<string, true>,
  // ⚠️ 少了这个字段，`deriveModelAvailability` 会把每个网关都看成"没连上"⇒ 永远
  //    `service-starting`，于是"取不到"这一档在本文件里**测不到**（曾如此）。
  gatewayStatusMap: { 'gw-1': 'connected' } as Record<string, 'connected' | 'connecting' | 'disconnected'>,
  // ⚠️ 手写 store 桩必须跟着长（缺字段 = 输入框那格的文案分档拿不到输入）。
  gatewayReconnectInfo: {} as Record<string, { attempt: number; max: number; gaveUp: boolean }>,
  // 「这次运行连上过没有」—— 预热期与真断开就靠它分（`lib/gateway-display-phase.ts`）。
  gatewayEverConnected: {} as Record<string, true>,
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
  // A1（`58705b4c`）起：流式块"什么都没到"时改渲染 `TurnActivityRow`（`useTurnActivity`
  // 唯一出口），它会读下面这四个面 —— 同一条"桩必须跟着长"的纪律。
  turnStartedAtBySession: {} as Record<string, number>,
  runRetryBySession: {} as Record<string, { attempt: number; maxAttempts: number }>,
  progressTextBySession: {} as Record<string, string | null>,
  compactingBySession: {} as Record<string, boolean>,
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
    // `activeTurnToMessage` 是**纯函数**，用真身 —— 桩成 `vi.fn()` 的话，
    // 定稿那一路会拿到 `undefined`（"定稿块"根本渲染不出来，测的就成了另一回事）。
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

function renderMainArea(readinessOverride: typeof readiness = readiness): {
  container: HTMLDivElement;
  rerender: () => void;
  unmount: () => void;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const render = () =>
    root.render(
      <MainArea
        onTogglePanel={vi.fn()}
        onboardingProfile={profile('user-1')}
        startupReadiness={readinessOverride}
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

  // 2026-10-06（用户拍板）：媒体就绪横幅已删除——原 8 个 `shows relay $video media`
  // 场景用例（light/dark × ready/unavailable/unknown/probe-failed）随之移除；
  // "横幅不存在"由下方守卫用例继续钉住。

  it('keeps media status hidden without ready local relay evidence', () => {
    const view = renderMainArea(readiness);
    expect(view.container.querySelector('[aria-label="mediaReadiness.relayLabel"]')).toBeNull();
    view.unmount();
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

  it('hides the compare entry for a team task', () => {
    mocks.tasks = [{ ...activeTask(), teamId: 'team-design', ensemble: false }];
    mocks.activeTaskId = 'task-1';

    const view = renderMainArea();

    expect(view.container.querySelector('[data-testid="compare-toggle"]')).toBeNull();
    view.unmount();
  });

  /**
   * 2026-09-20 实机报障：「我发完要求，那个对话头像会消失一下，然后再给我反馈」。
   *
   * 根因：**等待态**渲染的是 `ThinkingIndicator`（它自带一个头像），**内容一到**换成
   * `StreamingMessage`（另一个头像）——两个块各自淡入淡出，同一帧里**两个头像并存**
   * （MutationObserver 实测抓到 `头像=2` + 跳动点=3）。用户看到的就是"头像闪一下"。
   *
   * 修法：等待态也走**同一个助手块**（`AssistantBlock`）、**用同一个 key**，React 复用同一个
   * DOM 节点。这条断言守的就是"复用"本身 —— 只要节点还是同一个，头像就不可能闪。
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
    const waiting = view.container.querySelector('[data-testid="assistant-block"]');
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

    const after = view.container.querySelector('[data-testid="assistant-block"]');
    expect(after, '内容到了之后助手块不能消失').not.toBeNull();
    expect(after, '必须是同一个节点 —— 换了节点就等于头像被卸载重建了一次').toBe(waiting);
    view.unmount();
  });

  /**
   * 2026-09-20 另一道口子（队列 T-a12）：**定稿那一刻**。
   *
   * 流式态与定稿态原来分别是 `StreamingMessage` 与 `ChatMessage` **两个组件**
   * ⇒ key 相同也没用，React 照样把整块（含头像）卸载重建。
   * 修法=抽出一个共享的助手块，两种状态只是**身体不同**。
   */
  it('⭐ 流式 → 定稿：助手块与头像都必须是**同一个 DOM 节点**', () => {
    const SESSION = 'agent:rongying-content:clawwork:abc:task:task-1';
    mocks.tasks = [activeTask()];
    mocks.activeTaskId = 'task-1';
    mocks.messagesByTask = { 'task-1': [userMessage('msg-1', '你好')] };
    messageState.processingBySession = new Set([SESSION]);
    messageState.activeTurnBySession = {
      [SESSION]: {
        id: 'turn-1',
        streamingText: '正在写…',
        streamingThinking: '',
        toolCalls: [],
        finalized: false,
        content: '',
        timestamp: '2026-09-20T00:00:00.000Z',
      },
    };

    const view = renderMainArea();
    const block = view.container.querySelector('[data-testid="assistant-block"]');
    const avatar = view.container.querySelector('[data-testid="message-avatar"]');
    expect(block, '流式态该有助手块').not.toBeNull();
    expect(avatar, '块里该有头像').not.toBeNull();
    expect(view.container.textContent).toContain('正在写…');

    // 定稿：`finalizeStream` 那一次 set —— 正文从流式那份搬到 content
    messageState.activeTurnBySession = {
      [SESSION]: {
        id: 'turn-1',
        streamingText: '',
        streamingThinking: '',
        toolCalls: [],
        finalized: true,
        content: '答好了',
        timestamp: '2026-09-20T00:00:00.000Z',
      },
    };
    view.rerender();

    // 判据（队列 T-a12 原文）：定稿前后 `头像` 必须是同一个 DOM 节点。
    expect(view.container.querySelector('[data-testid="assistant-block"]'), '整块必须是同一个节点').toBe(block);
    expect(view.container.querySelector('[data-testid="message-avatar"]'), '头像必须是同一个节点').toBe(avatar);
    expect(view.container.textContent, '身体确实换成了定稿那一版').toContain('答好了');
    expect(view.container.textContent).not.toContain('正在写…');
    view.unmount();
  });

  it('⭐ 定稿只有隐藏思考、没有正文：显示可重试失败态，不再伪装成仍在生成', () => {
    const SESSION = 'agent:rongying-content:clawwork:abc:task:task-1';
    mocks.tasks = [activeTask()];
    mocks.activeTaskId = 'task-1';
    mocks.messagesByTask = { 'task-1': [userMessage('msg-1', '你好')] };
    messageState.processingBySession = new Set([SESSION]);
    messageState.activeTurnBySession = {
      [SESSION]: {
        id: 'turn-empty',
        streamingText: '',
        streamingThinking: '供应商返回了内部推理，但没有用户可见正文',
        toolCalls: [],
        finalized: true,
        content: '',
        timestamp: '2026-09-20T00:00:00.000Z',
      },
    };

    const view = renderMainArea();
    expect(view.container.querySelector('[data-testid="assistant-no-visible-answer"]')).not.toBeNull();
    expect(view.container.textContent).not.toContain('供应商返回了内部推理');
    view.unmount();
  });

  /**
   * 2026-09-20 现场日志定的第三道口子：**收编**。
   *
   * 实测（`debug-2026-09-20.1.ndjson`）：`renderer.chat.finalized` 之后 **+85ms** 就发出
   * `chat.history`、**+95ms** 收到（这段历史里**已经带着**刚生成的那条答复）⇒
   * `promoteActiveTurn` 当场把 active turn 删掉、把答复作为正式消息追加进时间线。
   * 于是"定稿块"只活了 ~95ms 就被换成一个**新 key + 新父节点**的块（消息项外面还包了一层
   * `div`）——用户看到的是第二次闪。
   *
   * 修法=助手那一格用**会话内稳定的 key**（`assistant-<会话>#<第几条>`），并且时间线每一项
   * 都包在同一个 `div` 里 ⇒ 收编前后 `key`、父节点、组件类型全不变。
   */
  it('⭐ 定稿 → 收编成正式消息：助手块与头像还是**同一个 DOM 节点**', () => {
    const SESSION = 'agent:rongying-content:clawwork:abc:task:task-1';
    mocks.tasks = [activeTask()];
    mocks.activeTaskId = 'task-1';
    mocks.messagesByTask = { 'task-1': [userMessage('msg-1', '你好')] };
    messageState.processingBySession = new Set([SESSION]);
    messageState.activeTurnBySession = {
      [SESSION]: {
        id: 'turn-1',
        streamingText: '',
        streamingThinking: '',
        toolCalls: [],
        finalized: true,
        content: '答好了',
        timestamp: '2026-09-20T00:00:00.000Z',
      },
    };

    const view = renderMainArea();
    const block = view.container.querySelector('[data-testid="assistant-block"]');
    const avatar = view.container.querySelector('[data-testid="message-avatar"]');
    expect(block, '定稿态该有助手块').not.toBeNull();

    // `promoteActiveTurn`：一次 set 里"删掉 active turn + 追加正式消息"
    messageState.activeTurnBySession = {};
    mocks.messagesByTask = {
      'task-1': [
        userMessage('msg-1', '你好'),
        {
          id: 'msg-2',
          taskId: 'task-1',
          role: 'assistant',
          content: '答好了',
          artifacts: [],
          toolCalls: [],
          sessionKey: SESSION,
          agentId: 'rongying-content',
          timestamp: '2026-09-20T00:00:01.000Z',
        },
      ],
    };
    view.rerender();

    expect(view.container.querySelector('[data-testid="assistant-block"]'), '块必须是同一个节点').toBe(block);
    expect(view.container.querySelector('[data-testid="message-avatar"]'), '头像必须是同一个节点').toBe(avatar);
    expect(view.container.textContent).toContain('答好了');
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
    const waiting = view.container.querySelector('[data-testid="assistant-block"]');
    expect(waiting, '等待态该有一个助手块').not.toBeNull();
    expect(message, '那条消息该在').not.toBeNull();
    expect(
      message!.compareDocumentPosition(waiting!) & Node.DOCUMENT_POSITION_FOLLOWING,
      '等待块要排在那条消息**之后**',
    ).toBeTruthy();
    view.unmount();
  });

  /**
   * ⭐ 2026-09-20（用户报障「使用出现加载模型那个一直卡住」）：
   * `MainArea` 原来写的是 `readinessBlocked = !startupReadiness.conversationReady`。
   * 目录**取不到**时 `ai.phase` 永远停在 loading ⇒ `conversationReady` 永远 false ⇒
   * **输入框一直被禁用**：用户连字都打不了，也看不到任何"出错了"的信号。
   * 收敛后：只有"还在准备"拦；一旦有结论（取不到也是结论）就得给出口。
   */
  it('⭐ 模型目录取不到 ⇒ 输入框不再被锁死；还在准备时仍然锁着', () => {
    const loading = renderMainArea({
      ...readiness,
      ai: { phase: 'loading-models' },
      conversationReady: false,
      isReady: false,
      hasError: false,
      composerBlocked: true,
    });
    expect(loading.container.querySelector<HTMLTextAreaElement>('textarea')?.disabled, '还在准备 ⇒ 拦').toBe(true);
    loading.unmount();

    // 「取不到」的真实形态是：**没有任何目录** + 退避用尽落下的失败标记。
    // （目录在手时不算失败 —— 那条在 model-availability 的单测里钉着。）
    uiState.modelCatalogByGateway = {};
    uiState.modelCatalogFailureByGateway = { 'gw-1': true };
    try {
      const failed = renderMainArea({
        ...readiness,
        ai: { phase: 'catalog-failed' },
        conversationReady: false,
        isReady: false,
        hasError: true,
        composerBlocked: false,
      });
      const textarea = failed.container.querySelector<HTMLTextAreaElement>('textarea');
      expect(textarea?.disabled, '取不到 ⇒ 不锁人').toBe(false);
      // 文案也得跟着分档：「无需重复操作」这句**绝不许**在取不到时出现，否则用户会一直等。
      expect(failed.container.textContent).toContain('chatInput.modelsUnavailable');
      expect(failed.container.textContent).not.toContain('chatInput.modelsLoadingDetail');
      failed.unmount();
    } finally {
      uiState.modelCatalogByGateway = {
        'gw-1': [{ id: 'deepseek-v4-flash', provider: 'clawrouter', name: 'DeepSeek V4 Flash' }],
      };
      uiState.modelCatalogFailureByGateway = {};
    }
  });

  it('⭐ 首次启动的预热期：输入框**不许**说"离线模式 — 只读"（那时它只是在启动）', () => {
    // 实机形状（2026-09-20 截图）：本机网关配过；客户端已经因为一次连接错误把状态写成
    // `disconnected`；但**这次运行从没连上过**，也还没有任何重连信息。
    // 老判据里 `isOffline` 把"还不知道"当成离线 ⇒ 输入框说"离线模式 — 只读" —— 那不是事实。
    const before = {
      status: uiState.gatewayStatusMap,
      reconnect: uiState.gatewayReconnectInfo,
      ever: uiState.gatewayEverConnected,
    };
    uiState.gatewayStatusMap = { 'gw-1': 'disconnected' };
    uiState.gatewayReconnectInfo = { 'gw-1': { attempt: 0, max: 10, gaveUp: false } };
    uiState.gatewayEverConnected = {};
    try {
      const view = renderMainArea({
        ...readiness,
        ai: { phase: 'starting' },
        conversationReady: false,
        isReady: false,
        composerBlocked: true,
      });
      const placeholder = () => view.container.querySelector<HTMLTextAreaElement>('textarea')?.placeholder;
      expect(placeholder()).toBe('chatInput.aiServiceStartingDetail');
      expect(placeholder(), '预热期说"离线只读"就是假话').not.toBe('chatInput.offlineReadOnly');

      // 对照读数（同一台机器、同一个输入框、只改"这次运行连上过没有"）：
      // 连上过又掉了 ⇒ 这时"离线模式 — 只读"**才是**事实。两次读数必须不同 ——
      // 否则上面那句"不是离线只读"可能只是因为这一格压根不读网关状态（变异 M4 就是这么溜过去的）。
      uiState.gatewayEverConnected = { 'gw-1': true };
      view.rerender();
      expect(placeholder()).toBe('chatInput.offlineReadOnly');
      view.unmount();
    } finally {
      uiState.gatewayStatusMap = before.status;
      uiState.gatewayReconnectInfo = before.reconnect;
      uiState.gatewayEverConnected = before.ever;
    }
  });
});
