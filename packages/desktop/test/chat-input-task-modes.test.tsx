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
    // ⚠️ 桩必须跟着长（2026-10-15 全量收口）：ChatInput 的 `stopVoiceInput`
    // （发送路径 414 行）现在还会调 `cancelInput`（接成 cancelVoiceInput）。
    // 少这一个 = 点发送时 `cancelVoiceInput is not a function` 未处理拒绝（exit 1 但测试全绿）。
    cancelInput: vi.fn(),
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

  it('⭐ 2026-10-28（用户）：下拉不再有三档模式 —— 直接平铺自配模型（按端点/家族分组）', () => {
    const { container, unmount } = renderChatInput();

    const text = container.textContent ?? '';
    // 三档模式 + 「高级」包裹层都已从 composer 下拉移除（模式系统本身仍在：新任务默认 smart）。
    expect(text, '快速档入口已移除').not.toContain('chatInput.mode.fast');
    expect(text, '深度档入口已移除').not.toContain('chatInput.mode.deep');
    expect(text, '「高级：指定模型」包裹层已移除').not.toContain('chatInput.mode.advanced');
    // 模型照常可选（不是把整张表藏了）。
    expect(text).toContain('GLM 5.3 Flash');
    expect(text).toContain('Qwen 3.5 27B');

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

  it('⭐ BUG-076（2026-10-14 口径更新取代 Cephalon 批"新旧都可见"）：同模型只留接管它的新渠道条目，旧渠道不再进列表（别名仍隐藏）', () => {
    const { container, unmount } = renderChatInput();

    const buttonTexts = [...container.querySelectorAll('button')].map((b) => b.textContent ?? '');
    // 2026-10-14 用户实测拍板：新旧双条并显＝"重复模型" ⇒ 被 `-cephalon` 接管的旧渠道
    // 条目不再出现在用户可选列表里（目录/发送校验/旧任务读侧不受影响）。
    expect(
      buttonTexts.filter((t) => t === 'DeepSeek V4 Flash'),
      '旧渠道条目已隐藏',
    ).toHaveLength(0);
    expect(
      buttonTexts.filter((t) => t === 'DeepSeek V4 Flash · Cephalon'),
      '接管它的新渠道条目照常可选',
    ).toHaveLength(1);
    expect(buttonTexts.some((t) => t.includes('GLM 5.3 Flash'))).toBe(true);
    const text = container.textContent ?? '';
    expect(text, '模式别名仍隐藏').not.toContain(ALIAS_MODEL_ID);

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
   * 2026-10-15（MM-B）：可用性来源从"本机 whisper 二进制"改成**relay 能力** ——
   * `ChatInput` 现在按 `window.clawwork.voiceCapabilities().result.asr` 决定按钮出不出现
   * （Windows 也走同一套云端链）。这里钉的还是"按钮出不出现"这条接线；
   * `useVoiceInput` 的行为仍由 use-voice-input.test.tsx 守。
   */
  describe('麦克风按钮：不支持 ⇒ 不渲染（BUG-044）', () => {
    const micButton = (container: HTMLElement): HTMLButtonElement | null =>
      container.querySelector('button[aria-label^="voiceInput."]');

    /** 把 `voiceCapabilities()` 那条 promise 链跑干净（useEffect 里的 setState 才落进界面）。 */
    async function flushVoiceCapabilities(): Promise<void> {
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
    }

    const voiceCaps = (asr: boolean, tts: boolean) =>
      vi.fn(async () => ({
        ok: true,
        result: { asr, tts, maxRecordingSeconds: 60, maxSpeechCharacters: 600 },
      }));

    it('relay 无 ASR 能力（未部署 / 关闭）⇒ 按钮与 Tooltip 整块不出现', async () => {
      mocks.voiceSupported = false;
      window.clawwork.voiceCapabilities = voiceCaps(false, false);
      const { container, unmount } = renderChatInput();

      await flushVoiceCapabilities();

      expect(micButton(container)).toBeNull();

      unmount();
    });

    it('能力探测失败（relay 抖动 / 未登录）⇒ 按钮仍在但置灰，Tooltip 说明原因', async () => {
      // 与上一条的**区别**：上一条是"relay 明确说没有 ASR"（部署关闸）⇒ 按 BUG-044 整块隐藏；
      // 这一条是"根本没问出来"（网络/登录态问题）⇒ 不能假装功能不存在，要给可理解的出口。
      mocks.voiceSupported = false;
      window.clawwork.voiceCapabilities = vi.fn(async () => ({ ok: false, error: 'voice-unavailable' }));
      const { container, unmount } = renderChatInput();

      await flushVoiceCapabilities();

      const button = micButton(container);
      expect(button, '探测失败 ≠ 能力不存在 —— 按钮要留着并解释').not.toBeNull();
      expect(button?.disabled).toBe(true);
      expect(button?.getAttribute('aria-label')).toBe('voiceInput.unsupportedTooltip');

      unmount();
    });

    it('relay 有 ASR 能力 ⇒ 按钮出现且可用，Tooltip 是正常态文案', async () => {
      mocks.voiceSupported = true;
      window.clawwork.voiceCapabilities = voiceCaps(true, true);
      const { container, unmount } = renderChatInput();

      await flushVoiceCapabilities();

      const button = micButton(container);
      expect(button).not.toBeNull();
      expect(button?.getAttribute('aria-label')).toBe('voiceInput.tooltip');
      expect(button?.disabled, '能力可用即能点（Windows 同此路径）').toBe(false);

      unmount();
      mocks.voiceSupported = false;
    });

    it('⭐ 探测失败 ⇒ 播报按钮也保留（置灰），不再凭空消失（2026-10-18 用户实机）', async () => {
      mocks.voiceSupported = false;
      window.clawwork.voiceCapabilities = vi.fn(async () => ({ ok: false, error: 'voice-unavailable' }));
      const { container, unmount } = renderChatInput();

      await flushVoiceCapabilities();

      // 麦克风 + 播报两个按钮都应存在、都置灰、都给出同一原因。
      const disabledVoiceButtons = [
        ...container.querySelectorAll('button[aria-label="voiceInput.unsupportedTooltip"]'),
      ];
      expect(disabledVoiceButtons).toHaveLength(2);
      for (const button of disabledVoiceButtons) expect((button as HTMLButtonElement).disabled).toBe(true);

      unmount();
    });

    it('只有 TTS 时（asr:false / tts:true）⇒ 麦克风隐藏，播报按钮在', async () => {
      mocks.voiceSupported = true;
      window.clawwork.voiceCapabilities = voiceCaps(false, true);
      const { container, unmount } = renderChatInput();

      await flushVoiceCapabilities();

      // ⚠️ 不能用 `micButton()` 断言：它按 aria-label 前缀匹配，会把播报按钮也算进来。
      expect(container.querySelector('button[aria-label="voiceInput.tooltip"]')).toBeNull();
      expect(container.querySelector('button[aria-label="voiceInput.unsupportedTooltip"]')).toBeNull();
      const speaker = container.querySelector('button[aria-label="voiceInput.readAnswer"]');
      expect(speaker, 'tts 可用 ⇒ 播报按钮必须在').not.toBeNull();

      unmount();
      mocks.voiceSupported = false;
    });

    it('⭐ 探测失败后按退避自动重试（不必切页面），探到成功即恢复可用', async () => {
      vi.useFakeTimers();
      try {
        mocks.voiceSupported = true;
        let calls = 0;
        window.clawwork.voiceCapabilities = vi.fn(async () => {
          calls += 1;
          return calls === 1
            ? { ok: false as const, error: 'voice-unavailable' }
            : {
                ok: true as const,
                result: { asr: true, tts: true, maxRecordingSeconds: 60, maxSpeechCharacters: 600 },
              };
        });
        const { container, unmount } = renderChatInput();

        await flushVoiceCapabilities();
        expect(container.querySelector('button[aria-label="voiceInput.unsupportedTooltip"]')).not.toBeNull();

        await act(async () => {
          vi.advanceTimersByTime(2100);
          await Promise.resolve();
          await Promise.resolve();
        });

        expect(calls).toBeGreaterThanOrEqual(2);
        expect(container.querySelector('button[aria-label="voiceInput.tooltip"]')).not.toBeNull();

        unmount();
        mocks.voiceSupported = false;
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
