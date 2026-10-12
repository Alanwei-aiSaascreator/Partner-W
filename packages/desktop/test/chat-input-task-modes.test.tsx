// @vitest-environment jsdom

/**
 * 任务模式 chip（输入框那一格）——**组件层的接线**。
 *
 * 这一层单独钉的理由：hook 里算得再对，chip 不接线用户也点不到。判据落在**用户动作**上：
 *   - 点「快速/智能/深度」⇒ 任务模式真的被写下去（`updateTaskMetadata` / 待发态 `updatePending`）；
 *   - 点高级列表里的具体模型 ⇒ `custom` + 那个模型；
 *   - **别名 id（`qwen3.7-flash-fast`）不出现在**高级列表里（它是模式内部用的 relay 条目，
 *     不是"某个可选模型"）。
 *
 * `useChatSend` 用**真身**（模式解析是这个功能的核心），只桩平台层与展示组件。
 */

import { act, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, ModelCatalogEntry, Task } from '@clawwork/shared';

const mocks = vi.hoisted(() => {
  const activeTask: Task = {
    id: 'task-1',
    sessionKey: 'agent:main:clawwork:task:task-1',
    sessionId: '',
    title: 'Task 1',
    status: 'active',
    createdAt: '2026-10-08T00:00:00.000Z',
    updatedAt: '2026-10-08T00:00:00.000Z',
    tags: [],
    artifactDir: '',
    gatewayId: 'gw-1',
    agentId: 'main',
    model: 'deepseek-v4-flash',
    mode: 'smart',
  };

  return {
    baseTask: activeTask,
    t: vi.fn((key: string) => key),
    /**
     * `useVoiceInput` 桩里回报的 `isSupported`（真身 = ChatInput 传下去的 `whisperAvailable`）。
     * 默认 false（= 本机/CI 的现状）；麦克风可见性用例按需翻成 true。
     */
    voiceSupported: false,
    composer: {
      send: vi.fn(async () => ({ ok: true, taskId: 'task-1' })),
      abort: vi.fn(async () => {}),
      applySlashCommand: vi.fn(async () => ({ ok: true })),
    },
    toastError: vi.fn(),
    toastInfo: vi.fn(),
    toastWarning: vi.fn(),
    taskState: {
      tasks: [activeTask] as Task[],
      activeTaskId: 'task-1' as string | null,
      pendingNewTask: null as Record<string, unknown> | null,
      hydrated: true,
      workspaceEpoch: 0,
      commitPendingTask: vi.fn(),
      updateTaskMetadata: vi.fn(),
      updatePending: vi.fn(),
      startNewTask: vi.fn(),
      clearPending: vi.fn(),
      setPending: vi.fn(),
      createTask: vi.fn(),
      setActiveTask: vi.fn(),
      setTaskPinned: vi.fn(),
      updateTaskTitle: vi.fn(),
      updateTaskStatus: vi.fn(),
      registerPersistedTasks: vi.fn(),
      resetWorkspace: vi.fn(),
      removeTask: vi.fn(),
      hydrate: vi.fn(),
      adoptTasks: vi.fn(),
    },
    messageState: {
      messagesByTask: {} as Record<string, Message[]>,
      runPhaseBySession: {} as Record<string, string>,
      processingBySession: new Set<string>(),
      activeTurnBySession: {},
      errorBySession: {},
      addMessage: vi.fn(),
      setProcessing: vi.fn(),
      setSessionError: vi.fn(),
      clearActiveTurn: vi.fn(),
      adoptActiveTurn: vi.fn(),
      clearMessages: vi.fn(),
    },
    uiState: {
      sendShortcut: 'enter',
      mainView: 'chat',
      settingsOpen: false,
      gatewayStatusMap: { 'gw-1': 'connected' } as Record<string, string>,
      modelCatalogByGateway: {} as Record<string, ModelCatalogEntry[]>,
      modelCatalogFailureByGateway: {} as Record<string, true>,
      agentCatalogByGateway: {} as Record<string, { agents: Array<{ id: string; name?: string }>; defaultId: string }>,
      toolsCatalogByGateway: {},
      effectiveToolsByGateway: {},
      gatewayReconnectInfo: {},
      gatewayEverConnected: {},
      gatewayMaxPayloadByGateway: {} as Record<string, number>,
      computerAccessBySession: {},
      setMainView: vi.fn(),
    },
    roomState: { rooms: {} as Record<string, unknown>, initConductor: vi.fn(async () => true) },
    teamState: { teams: {} as Record<string, unknown>, loadTeam: vi.fn(async () => null) },
    settingsState: {
      settings: null as { voiceInput?: { introSeen?: boolean } } | null,
      load: vi.fn(async () => null),
      updateSettings: vi.fn(async () => ({ ok: true })),
    },
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mocks.t, i18n: { language: 'zh-CN', resolvedLanguage: 'zh-CN' } }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

vi.mock('sonner', () => ({
  toast: { error: mocks.toastError, warning: mocks.toastWarning, info: mocks.toastInfo, success: vi.fn() },
}));

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
  motion: new Proxy(
    {},
    {
      get:
        () =>
        ({ children, className }: { children?: ReactNode; className?: string }) => (
          <div className={className}>{children}</div>
        ),
    },
  ),
  useReducedMotion: () => true,
}));

vi.mock('../src/renderer/platform', () => ({
  composer: mocks.composer,
  messageStore: { getState: () => mocks.messageState },
  taskStore: { getState: () => mocks.taskState },
  useTaskStore: Object.assign(
    <T,>(selector?: (state: typeof mocks.taskState) => T) => (selector ? selector(mocks.taskState) : mocks.taskState),
    { getState: () => mocks.taskState },
  ),
  useMessageStore: Object.assign(
    <T,>(selector?: (state: typeof mocks.messageState) => T) =>
      selector ? selector(mocks.messageState) : mocks.messageState,
    { getState: () => mocks.messageState },
  ),
  useUiStore: Object.assign(
    <T,>(selector?: (state: typeof mocks.uiState) => T) => (selector ? selector(mocks.uiState) : mocks.uiState),
    { getState: () => mocks.uiState },
  ),
  useRoomStore: Object.assign(
    <T,>(selector?: (state: typeof mocks.roomState) => T) => (selector ? selector(mocks.roomState) : mocks.roomState),
    { getState: () => mocks.roomState },
  ),
  useTeamStore: Object.assign(
    <T,>(selector?: (state: typeof mocks.teamState) => T) => (selector ? selector(mocks.teamState) : mocks.teamState),
    { getState: () => mocks.teamState },
  ),
}));

vi.mock('../src/renderer/features/team-meeting/instance', () => ({
  teamMeetingController: { store: { getState: () => ({ records: [] }) } },
}));

// 展示组件：本文件不测它们，桩掉（真身需要大批上下文）。
vi.mock('../src/renderer/components/ui/button', () => ({
  Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
}));

/**
 * ⚠️ 下拉必须**保住 onClick**：菜单项的语义就是"点了它会做事"。
 * 把 onClick 丢掉的桩（只渲染 children）会让这一整份测试变成假绿 —— 点不动、却全过。
 */
vi.mock('../src/renderer/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onClick,
    ...props
  }: { children: ReactNode; onClick?: () => void } & Record<string, unknown>) => (
    <button type="button" onClick={onClick} {...props}>
      {children}
    </button>
  ),
  DropdownMenuSub: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSubTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSubContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
}));

vi.mock('../src/renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('../src/renderer/components/semantic/ConfirmDialog', () => ({ default: () => null }));
vi.mock('../src/renderer/components/semantic/ToolbarButton', () => ({
  default: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
}));
vi.mock('../src/renderer/components/AgentIcon', () => ({ default: () => null }));
vi.mock('../src/renderer/components/MentionPicker', () => ({ default: () => null }));
vi.mock('../src/renderer/components/SlashArgPicker', () => ({ default: () => null }));
vi.mock('../src/renderer/components/SlashCommandDashboard', () => ({ default: () => null }));
vi.mock('../src/renderer/components/SlashCommandMenu', () => ({ default: () => null }));
vi.mock('../src/renderer/components/ToolsCatalog', () => ({ default: () => null }));
vi.mock('../src/renderer/components/VoiceIntroDialog', () => ({ default: () => null }));
vi.mock('../src/renderer/components/ComposerActivity', () => ({ default: () => null }));

vi.mock('../src/renderer/hooks/useVoiceInput', () => ({
  useVoiceInput: () => ({
    isSupported: mocks.voiceSupported,
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

vi.mock('../src/renderer/stores/settingsStore', () => {
  const useSettingsStore = <T,>(selector: (state: typeof mocks.settingsState) => T) => selector(mocks.settingsState);
  useSettingsStore.getState = () => mocks.settingsState;
  return { useSettingsStore, syncSettingsUpdate: vi.fn() };
});

import ChatInput from '../src/renderer/components/ChatInput';
import { useCommercialStore } from '../src/renderer/stores/commercialStore';
import { compareStore } from '../src/renderer/features/compare/compare-store-instance';

const BASE_MODEL_ID = 'glm-5.3-flash';
const ALIAS_MODEL_ID = 'qwen3.7-flash-fast';
const LEGACY_MODEL_ID = 'deepseek-v4-flash';
const OTHER_MODEL_ID = 'qwen3.5-27b';
const CEPHALON_DEEPSEEK_ID = 'deepseek-v4-flash-cephalon';

const catalog: ModelCatalogEntry[] = [
  { id: LEGACY_MODEL_ID, name: 'DeepSeek V4 Flash', provider: 'clawrouter' },
  { id: BASE_MODEL_ID, name: 'GLM 5.3 Flash', provider: 'clawrouter', input: ['text', 'image'] },
  { id: OTHER_MODEL_ID, name: 'Qwen 3.5 27B', provider: 'clawrouter' },
  { id: ALIAS_MODEL_ID, name: 'Qwen 3.7 Flash Fast', provider: 'clawrouter' },
  { id: CEPHALON_DEEPSEEK_ID, name: 'DeepSeek V4 Flash · Cephalon', provider: 'clawrouter' },
];

function renderChatInput(): { container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => {
    root.render(<ChatInput />);
  });
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function clickByText(container: HTMLElement, text: string): void {
  const button = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes(text));
  if (!button) throw new Error(`button not found: ${text}`);
  act(() => {
    (button as HTMLButtonElement).click();
  });
}

function commercialReady(): void {
  useCommercialStore.setState({
    status: 'ready',
    overview: {
      account: { userId: 'u-1', phone: null, email: null, nickname: null, avatar: null },
      org: null,
      license: {
        activated: true,
        licenseId: 'license-1',
        orgId: 'org-1',
        licenseKey: 'RY-1',
        sku: 'USB',
        status: 'active',
        expiresAt: null,
        tokenQuotaMicros: 1000,
        tokenUsedMicros: 10,
      },
      device: { fingerprint: 'fp', shortFingerprint: 'fp' },
      fetchedAt: '2026-10-08T00:00:00.000Z',
    },
  });
}

describe('任务模式 chip（输入框）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    mocks.taskState.tasks = [{ ...mocks.baseTask }];
    mocks.taskState.activeTaskId = 'task-1';
    mocks.taskState.pendingNewTask = null;
    mocks.taskState.updateTaskMetadata.mockClear();
    mocks.taskState.updatePending.mockClear();
    mocks.uiState.modelCatalogByGateway = { 'gw-1': catalog };
    mocks.uiState.modelCatalogFailureByGateway = {};
    mocks.uiState.agentCatalogByGateway = {};
    mocks.uiState.gatewayStatusMap = { 'gw-1': 'connected' };
    mocks.roomState.rooms = {};
    mocks.teamState.teams = {};
    mocks.composer.send.mockClear();
    mocks.composer.applySlashCommand.mockClear();
    mocks.toastError.mockClear();
    compareStore().setState({ active: null, mode: false, error: null });
    commercialReady();
    Object.assign(window, {
      clawwork: {
        listImportedTaskFiles: vi.fn(async () => ({ ok: true, result: [] })),
        listTaskContextSources: vi.fn(async () => ({ ok: true, result: [] })),
        checkWhisper: vi.fn(async () => ({ available: false })),
        requestMicrophonePermission: vi.fn(async () => ({ status: 'granted' })),
        saveInboxAttachment: vi.fn(async () => ({ ok: true, result: { localPath: 'x' } })),
      },
    });
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('触发 chip 显示当前模式（默认智能）', () => {
    const { container, unmount } = renderChatInput();

    const trigger = container.querySelector('button[aria-busy]');
    expect(trigger?.textContent).toContain('chatInput.mode.smart');

    unmount();
  });

  it('⭐ 下拉三档都在：快速 / 智能（推荐）/ 深度', () => {
    const { container, unmount } = renderChatInput();

    const text = container.textContent ?? '';
    expect(text).toContain('chatInput.mode.fast');
    expect(text).toContain('chatInput.mode.smart');
    expect(text).toContain('chatInput.mode.deep');
    expect(text).toContain('chatInput.mode.recommended');
    expect(text).toContain('chatInput.mode.advanced');

    unmount();
  });

  it('⭐ 点「深度」⇒ 写 task.mode = deep', () => {
    const { container, unmount } = renderChatInput();

    clickByText(container, 'chatInput.mode.deep');

    expect(mocks.taskState.updateTaskMetadata).toHaveBeenCalledWith('task-1', { mode: 'deep' });
    unmount();
  });

  it('点「快速」⇒ 写 task.mode = fast（不碰 model）', () => {
    const { container, unmount } = renderChatInput();

    clickByText(container, 'chatInput.mode.fast');

    expect(mocks.taskState.updateTaskMetadata).toHaveBeenCalledWith('task-1', { mode: 'fast' });
    const payload = mocks.taskState.updateTaskMetadata.mock.calls[0]![1] as Record<string, unknown>;
    expect(payload.model).toBeUndefined();
    unmount();
  });

  it('高级列表里选具体模型 ⇒ mode = custom + 那个模型', () => {
    const { container, unmount } = renderChatInput();

    clickByText(container, 'Qwen 3.5 27B');

    expect(mocks.taskState.updateTaskMetadata).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({ mode: 'custom', model: OTHER_MODEL_ID }),
    );
    unmount();
  });

  it('⭐ 别名 id 不出现在高级模型列表里（模式内部条目，不是可选模型）', () => {
    const { container, unmount } = renderChatInput();

    const text = container.textContent ?? '';
    expect(text, '别名名字也不该露出来').not.toContain(ALIAS_MODEL_ID);
    expect(text).not.toContain('Qwen 3.7 Flash Fast');
    // 对照：基础模型与普通模型照常可选（不是把整张表藏了）
    expect(text).toContain('GLM 5.3 Flash');
    expect(text).toContain('Qwen 3.5 27B');

    unmount();
  });

  it('⭐ Cephalon 批：高级列表中新旧两条 DeepSeek 渠道与 GLM 都可见（别名仍隐藏）', () => {
    const { container, unmount } = renderChatInput();

    const buttonTexts = [...container.querySelectorAll('button')].map((b) => b.textContent ?? '');
    // 旧渠道保持可选（用户原有下拉选择不受影响）
    expect(buttonTexts.filter((t) => t === 'DeepSeek V4 Flash')).toHaveLength(1);
    // 新渠道（平台计费 ID）也在下拉里、显示为 Cephalon 版本
    expect(buttonTexts.filter((t) => t === 'DeepSeek V4 Flash · Cephalon')).toHaveLength(1);
    expect(buttonTexts.some((t) => t.includes('GLM 5.3 Flash'))).toBe(true);
    const text = container.textContent ?? '';
    expect(text, '模式别名仍隐藏').not.toContain(ALIAS_MODEL_ID);

    unmount();
  });

  it('待发态（还没建任务）点「深度」⇒ 写 pendingNewTask.mode', () => {
    mocks.taskState.activeTaskId = null;
    mocks.taskState.tasks = [];
    mocks.taskState.pendingNewTask = { gatewayId: 'gw-1', agentId: 'main' };
    const { container, unmount } = renderChatInput();

    clickByText(container, 'chatInput.mode.deep');

    expect(mocks.taskState.updatePending).toHaveBeenCalledWith({ mode: 'deep' });
    expect(mocks.taskState.updateTaskMetadata).not.toHaveBeenCalled();
    unmount();
  });

  it('模式任务：思考档由模式决定（按钮置灰、显示模式档位）', () => {
    mocks.taskState.tasks = [{ ...mocks.baseTask, mode: 'deep' }];
    const { container, unmount } = renderChatInput();

    const text = container.textContent ?? '';
    expect(text, 'deep ⇒ 最高（max，Cephalon 批）').toContain('chatInput.thinkingMax');
    expect(text).toContain('chatInput.thinkingLockedByMode');

    unmount();
  });

  it('⭐ 快速档 ⇒ 思考档显示为低（low，Cephalon 批）', () => {
    mocks.taskState.tasks = [{ ...mocks.baseTask, mode: 'fast' }];
    const { container, unmount } = renderChatInput();

    const text = container.textContent ?? '';
    expect(text).toContain('chatInput.thinkingLow');
    expect(text).toContain('chatInput.thinkingLockedByMode');

    unmount();
  });

  it('高级（custom）：用户自己的档位仍可切换（思考菜单照常）', () => {
    mocks.taskState.tasks = [{ ...mocks.baseTask, mode: 'custom', model: LEGACY_MODEL_ID, thinkingLevel: 'low' }];
    const { container, unmount } = renderChatInput();

    const text = container.textContent ?? '';
    expect(text).toContain('chatInput.thinkingLow');
    expect(text).not.toContain('chatInput.thinkingLockedByMode');

    unmount();
  });

  it('旧任务（mode 为空 + 有 model）⇒ chip 显示模型名、按 custom 处理（不冒充智能）', () => {
    mocks.taskState.tasks = [{ ...mocks.baseTask, model: LEGACY_MODEL_ID, mode: undefined }];
    const { container, unmount } = renderChatInput();

    const trigger = container.querySelector('button[aria-busy]');
    expect(trigger?.textContent).toContain('DeepSeek V4 Flash');
    expect(trigger?.textContent).not.toContain('chatInput.mode.smart');

    unmount();
  });

  /**
   * 麦克风按钮的可见性（BUG-044 · 产品拍板）：**不支持 ⇒ 整块不渲染**（不是"禁用但可见"）。
   *
   * 原来 Windows 上渲染一个灰掉的麦克风 + "此版本暂不支持 Windows 语音输入"的 Tooltip ——
   * 一个永远点不动、只解释自己为什么没用的入口。拍板改成"没有的能力不占位置"。
   * ⚠️ `useVoiceInput` 在本文件里是桩（它自己的行为由 use-voice-input.test.tsx 守）：
   *    这里钉的是**按钮出不出现**这一条接线；macOS 的 whisper 可用路径照旧出现。
   */
  describe('麦克风按钮：不支持 ⇒ 不渲染（BUG-044）', () => {
    const micButton = (container: HTMLElement): HTMLButtonElement | null =>
      container.querySelector('button[aria-label^="voiceInput."]');

    /** 把 `checkWhisper()` 那条 promise 链跑干净（useEffect 里的 setState 才落进界面）。 */
    async function flushWhisperCheck(): Promise<void> {
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
    }

    it('whisper 不可用（Windows / 没装）⇒ 按钮与 Tooltip 整块不出现', async () => {
      mocks.voiceSupported = false;
      window.clawwork.checkWhisper = vi.fn(async () => ({
        available: false,
        binaryPath: null,
        modelPath: null,
        unsupportedPlatform: true,
      }));
      const { container, unmount } = renderChatInput();

      await flushWhisperCheck();

      expect(micButton(container)).toBeNull();

      unmount();
    });

    it('whisper 可用（macOS）⇒ 按钮照常出现且可用，Tooltip 是正常态文案', async () => {
      // 真身里 `isVoiceSupported` 就是 `whisperAvailable`（ChatInput 原样传下去）——桩跟着一起翻。
      mocks.voiceSupported = true;
      window.clawwork.checkWhisper = vi.fn(async () => ({
        available: true,
        binaryPath: '/opt/homebrew/bin/whisper-cli',
        modelPath: '/models/ggml-large-v3-turbo.bin',
      }));
      const { container, unmount } = renderChatInput();

      await flushWhisperCheck();

      const button = micButton(container);
      expect(button).not.toBeNull();
      expect(button?.getAttribute('aria-label')).toBe('voiceInput.tooltip');
      expect(button?.disabled, 'macOS 行为不变：可用即能点').toBe(false);

      unmount();
      mocks.voiceSupported = false;
    });
  });
});
