// @vitest-environment jsdom

/**
 * **接线**测试：`ChatInput` 的 `mentionAgents` 必须走目录优先那条唯一规则
 * （T-a7 家族 —— `@` 提及选择器是显示层漏掉的第三个面）。
 *
 * 症状：旧房间（快照里存的是裸 id）里 `@` 一个 worker，选择器显示
 * `partner-w-tpl-78b62899`；新房间正常。
 *
 * ⚠️ 为什么非要渲染**真 ChatInput**：把映射写成一个纯函数很好测，
 * 但"组件有没有调它"是另一个问题 —— 纯函数绿 + 组件没接线 = 症状一模一样。
 * 这里渲染真组件、把 `MentionPicker` 换成**记录 props 的桩**，
 * 断言它收到的 `agents` 里名字来自目录。变异 M2（把 ChatInput 改回 `p.agentName`）会打红它。
 */
import { act, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handleSend: vi.fn(),
  focus: vi.fn(),
  /** MentionPicker 桩收到的 props（断言接线用的）。 */
  pickerProps: { agents: [] as Array<{ agentId: string; agentName: string; avatarUrl?: string }> },
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

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
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
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
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
vi.mock('../src/renderer/components/MentionPicker', () => ({
  default: (props: { agents: Array<{ agentId: string; agentName: string; avatarUrl?: string }> }) => {
    mocks.pickerProps.agents = props.agents;
    return null;
  },
}));
vi.mock('../src/renderer/components/SlashArgPicker', () => ({ default: () => null }));
vi.mock('../src/renderer/components/SlashCommandDashboard', () => ({ default: () => null }));
vi.mock('../src/renderer/components/SlashCommandMenu', () => ({ default: () => null }));
vi.mock('../src/renderer/components/ToolsCatalog', () => ({ default: () => null }));
vi.mock('../src/renderer/components/VoiceIntroDialog', () => ({ default: () => null }));
vi.mock('../src/renderer/components/ChatInput/TaskMaterials', () => ({ default: () => null }));

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

vi.mock('../src/renderer/components/ChatInput/useChatSend', () => ({
  useChatSend: () => ({
    isGenerating: false,
    aborting: false,
    isOffline: false,
    activeTask: null,
    currentModel: '',
    currentThinking: 'off',
    modelAvailability: 'empty',
    toolsCatalog: null,
    modelLabel: '',
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
}));

const taskState: { activeTaskId: string | null; tasks: Array<{ id: string; gatewayId?: string }> } = {
  activeTaskId: null,
  tasks: [],
};
const uiState: {
  sendShortcut: string;
  mainView: string;
  settingsOpen: boolean;
  agentCatalogByGateway: Record<
    string,
    { agents: Array<{ id: string; name?: string; identity?: { avatarUrl?: string } }>; defaultId: string }
  >;
} = {
  sendShortcut: 'enter',
  mainView: 'task',
  settingsOpen: false,
  agentCatalogByGateway: {},
};
const roomState: {
  rooms: Record<
    string,
    { performers: Array<{ agentId: string; agentName: string; emoji?: string; sessionKey: string }> }
  >;
} = { rooms: {} };
const messageState = { runPhaseBySession: {} };
const settingsState = { load: vi.fn(), updateSettings: vi.fn(), settings: null };

vi.mock('../src/renderer/stores/taskStore', () => ({
  useTaskStore: <T,>(selector: (state: typeof taskState) => T) => selector(taskState),
}));
vi.mock('../src/renderer/stores/uiStore', () => ({
  useUiStore: <T,>(selector: (state: typeof uiState) => T) => selector(uiState),
}));
vi.mock('../src/renderer/stores/roomStore', () => ({
  useRoomStore: <T,>(selector: (state: typeof roomState) => T) => selector(roomState),
}));
vi.mock('../src/renderer/stores/messageStore', () => ({
  useMessageStore: <T,>(selector: (state: typeof messageState) => T) => selector(messageState),
}));
vi.mock('../src/renderer/stores/settingsStore', () => {
  const useSettingsStore = <T,>(selector: (state: typeof settingsState) => T) => selector(settingsState);
  useSettingsStore.getState = () => settingsState;
  return { useSettingsStore };
});

import ChatInput from '../src/renderer/components/ChatInput';

const TASK_ID = 'task-1';
const GATEWAY_ID = 'gw1';
const AGENT_ID = 'partner-w-tpl-78b62899';
const CATALOG_NAME = '爆款内容教练';
const SESSION_KEY = `agent:${AGENT_ID}:subagent:0e0b5f3a-1111-2222-3333-444455556666`;

function seed(opts: {
  /** 快照里存的名字 —— 存量脏数据里这里就是裸 agentId（T-a7 的症状）。 */
  snapshotName: string;
  catalog?: Array<{ id: string; name?: string; identity?: { avatarUrl?: string } }>;
  performers?: Array<{ agentId: string; agentName: string; emoji?: string; sessionKey: string }>;
}) {
  taskState.activeTaskId = TASK_ID;
  taskState.tasks = [{ id: TASK_ID, gatewayId: GATEWAY_ID }];
  uiState.agentCatalogByGateway = {
    [GATEWAY_ID]: { agents: opts.catalog ?? [{ id: AGENT_ID, name: CATALOG_NAME }], defaultId: AGENT_ID },
  };
  roomState.rooms = {
    [TASK_ID]: {
      performers: opts.performers ?? [
        { agentId: AGENT_ID, agentName: opts.snapshotName, emoji: '🔥', sessionKey: SESSION_KEY },
      ],
    },
  };
  mocks.pickerProps.agents = [];
}

function renderChatInput(): { container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => root.render(<ChatInput />));
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe('ChatInput → @ 提及选择器：worker 名字走目录优先', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    roomState.rooms = {};
    uiState.agentCatalogByGateway = {};
    taskState.activeTaskId = null;
    taskState.tasks = [];
    mocks.pickerProps.agents = [];
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

  it('⭐ 快照里是裸 id（存量脏数据）⇒ 传给选择器的是目录里的名字', () => {
    seed({ snapshotName: AGENT_ID });
    const view = renderChatInput();
    try {
      expect(mocks.pickerProps.agents).toHaveLength(1);
      expect(mocks.pickerProps.agents[0].agentName).toBe(CATALOG_NAME);
    } finally {
      view.unmount();
    }
  });

  it('⭐ agentId 仍然原样带着（发消息时 @ 的载荷用的是 id，不是名字）', () => {
    seed({ snapshotName: AGENT_ID });
    const view = renderChatInput();
    try {
      expect(mocks.pickerProps.agents[0].agentId).toBe(AGENT_ID);
    } finally {
      view.unmount();
    }
  });

  it('⭐ 目录里的头像仍然从目录取（不是被名字改动顺带弄丢）', () => {
    seed({
      snapshotName: AGENT_ID,
      catalog: [{ id: AGENT_ID, name: CATALOG_NAME, identity: { avatarUrl: 'https://example.test/a.png' } }],
    });
    const view = renderChatInput();
    try {
      expect(mocks.pickerProps.agents[0].avatarUrl).toBe('https://example.test/a.png');
    } finally {
      view.unmount();
    }
  });

  it('⚠️ 目录里没有这个 agent ⇒ 退回快照里的名字（不是空串、不是 undefined）', () => {
    seed({ snapshotName: '老名字（目录里已经没有它了）', catalog: [] });
    const view = renderChatInput();
    try {
      expect(mocks.pickerProps.agents[0].agentName).toBe('老名字（目录里已经没有它了）');
    } finally {
      view.unmount();
    }
  });

  it('⚠️ 目录里这一行 name 是空串 ⇒ 退回快照（空串不算"有名字"）', () => {
    seed({ snapshotName: '老名字', catalog: [{ id: AGENT_ID, name: '' }] });
    const view = renderChatInput();
    try {
      expect(mocks.pickerProps.agents[0].agentName).toBe('老名字');
    } finally {
      view.unmount();
    }
  });

  it('⚠️ 同一个 agentId 登记了两条（不同会话）⇒ 只留一条（去重没被改坏）', () => {
    seed({
      snapshotName: AGENT_ID,
      performers: [
        { agentId: AGENT_ID, agentName: AGENT_ID, sessionKey: SESSION_KEY },
        { agentId: AGENT_ID, agentName: AGENT_ID, sessionKey: `${SESSION_KEY}-2` },
      ],
    });
    const view = renderChatInput();
    try {
      expect(mocks.pickerProps.agents).toHaveLength(1);
      expect(mocks.pickerProps.agents[0].agentName).toBe(CATALOG_NAME);
    } finally {
      view.unmount();
    }
  });

  it('⚠️ 房间里一个 worker 都没有 ⇒ 选择器收到空数组（不是 undefined）', () => {
    seed({ snapshotName: AGENT_ID, performers: [] });
    const view = renderChatInput();
    try {
      expect(mocks.pickerProps.agents).toEqual([]);
    } finally {
      view.unmount();
    }
  });
});
