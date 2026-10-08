// @vitest-environment jsdom

import { act, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * C 组（BUG-027）+ F 组（BUG-030）**接线**（判据本身在 attachment-actions.test.ts）：
 *   - 拖入 / 选入文件后，建议操作行必须真的出现（能力入口要**看得见**——注意 vision 门禁：
 *     图片动作只在模型自述支持看图时露出，见下方 ⭐ 用例）；
 *   - 读类动作（提取文字）**点击即发**（不再多问一步）；
 *   - 输入框里已有草稿时不抢发；改类动作只预填，绝不自动发（写入口只从明确意图开）。
 */

const mocks = vi.hoisted(() => ({
  handleSend: vi.fn(),
  importFiles: vi.fn(),
  selectedImportedFiles: [] as Array<{
    taskId: string;
    fileName: string;
    localPath: string;
    mimeType: string;
    size: number;
    availability: 'available';
  }>,
  modelEntry: undefined as { id: string; input?: string[] } | undefined,
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

/**
 * `t` 默认透传 key（断言按 key 写，改文案不会假红）；
 * 只给**带 `【…】` 占位**的那条填真值 —— 预填模板的光标落点要靠它验。
 */
const DICT: Record<string, string> = {
  'chatInput.attachmentActions.promptModifyFile': '请修改这份文件：【说明要改什么】',
};

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => DICT[key] ?? key }),
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
  DropdownMenuItem: ({ children, ...props }: { children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
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
vi.mock('../src/renderer/components/MentionPicker', () => ({ default: () => null }));
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
    handlePaste: vi.fn(),
  }),
}));

vi.mock('../src/renderer/components/ChatInput/useTaskMaterials', () => ({
  useTaskMaterials: () => ({
    sources: [],
    selectedImportedFiles: mocks.selectedImportedFiles,
    selectedImportedPaths: new Set<string>(),
    importedFiles: mocks.selectedImportedFiles,
    loadSourceFiles: vi.fn(),
    clearSelectedImportedFiles: vi.fn(),
    markImportedFileMissing: vi.fn(),
    toggleImportedFile: vi.fn(),
    revokeSource: vi.fn(),
    importFiles: mocks.importFiles,
    importFilesFromPaths: vi.fn(),
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
    currentModel: 'deepseek-v4-flash',
    currentThinking: 'off',
    modelAvailability: 'ready',
    toolsCatalog: null,
    modelLabel: '',
    currentModelEntry: mocks.modelEntry,
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

const taskState = { activeTaskId: null as string | null, tasks: [] };
const uiState = {
  sendShortcut: 'enter',
  mainView: 'task',
  settingsOpen: false,
  agentCatalogByGateway: {},
};
const roomState = { rooms: {} };
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

const IMAGE_MATERIAL = {
  taskId: 'task-1',
  fileName: 'shot.png',
  localPath: 'tasks/task-1/inbox/shot.png',
  mimeType: 'image/png',
  size: 1024,
  availability: 'available' as const,
};

const SHEET_MATERIAL = { ...IMAGE_MATERIAL, fileName: '报表.xlsx', mimeType: 'application/vnd.ms-excel' };

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

function composer(container: HTMLDivElement): HTMLTextAreaElement {
  const element = container.querySelector('textarea');
  if (!(element instanceof HTMLTextAreaElement)) throw new Error('textarea not found');
  return element;
}

function clickLabel(label: string): void {
  const button = [...document.body.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.includes(label),
  );
  if (!(button instanceof HTMLButtonElement)) throw new Error(`button not found: ${label}`);
  act(() => button.click());
}

describe('ChatInput attachment suggestions wiring', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    mocks.handleSend.mockClear();
    mocks.importFiles.mockClear();
    mocks.selectedImportedFiles = [];
    // 默认给**自述支持看图**的模型：图片动作要露出就得显式过 vision 门禁（非 supported 一律不露，见 ⭐ 用例）
    mocks.modelEntry = { id: 'vision-model', input: ['text', 'image'] };
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

  it('选入图片 → 「识别图片」三个动作出现；「提取文字」点击即发（不再多问一步）', () => {
    mocks.selectedImportedFiles = [IMAGE_MATERIAL];
    const view = renderChatInput();

    expect(view.container.textContent).toContain('chatInput.attachmentActions.extractImageText');
    expect(view.container.textContent).toContain('chatInput.attachmentActions.summarizeImage');
    expect(view.container.textContent).toContain('chatInput.attachmentActions.analyzeImage');
    // 模型自述能看图 ⇒ 不说那句"不支持"（那句话只留给 unsupported 且行里还有别的动作时）
    expect(view.container.textContent).not.toContain('chatInput.attachmentActions.imageUnsupported');

    clickLabel('chatInput.attachmentActions.extractImageText');

    expect(composer(view.container).value).toBe('chatInput.attachmentActions.promptExtractImageText');
    expect(mocks.handleSend).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it('输入框里已有草稿 ⇒ 不抢发，只把动作接在草稿后面', () => {
    mocks.selectedImportedFiles = [IMAGE_MATERIAL];
    const view = renderChatInput();
    composer(view.container).value = '帮我看看这个';

    clickLabel('chatInput.attachmentActions.extractImageText');

    expect(mocks.handleSend).not.toHaveBeenCalled();
    expect(composer(view.container).value).toBe('帮我看看这个\nchatInput.attachmentActions.promptExtractImageText');
    view.unmount();
  });

  it('改类动作（修改文件）只预填、绝不自动发（写入口只从明确意图开）', () => {
    mocks.selectedImportedFiles = [SHEET_MATERIAL];
    const view = renderChatInput();

    expect(view.container.textContent).toContain('chatInput.attachmentActions.modifyFile');
    clickLabel('chatInput.attachmentActions.modifyFile');

    expect(mocks.handleSend).not.toHaveBeenCalled();
    expect(composer(view.container).value).toBe('请修改这份文件：【说明要改什么】');
    // 预填模板带可填占位（【…】）—— 光标落在占位上，直接打字就能补
    const textareaEl = composer(view.container);
    expect(textareaEl.value.slice(textareaEl.selectionStart, textareaEl.selectionEnd)).toBe('【说明要改什么】');
    view.unmount();
  });

  /**
   * ⭐ 2026-10-07（vision 入口降级 · 用户拍板）：模型没有**明确自述**支持看图时
   * （`unsupported` = 自述不看图；`unknown` = 目录没报名——当前中转的常态），
   * 「识别图片」入口整条不露出：建议动作与 + 菜单项都消失。
   * 等 relay 加 vision 模型（目录自述 image）后自动回来，无需改代码。
   */
  it('⭐ 模型非 supported（自述不看图 / 能力未知）→ 「识别图片」入口不露出（建议动作与 + 菜单项都消失）', () => {
    for (const entry of [{ id: 'deepseek-v4-flash', input: ['text'] }, { id: 'deepseek-v4-flash' }]) {
      mocks.selectedImportedFiles = [IMAGE_MATERIAL];
      mocks.modelEntry = entry;
      const view = renderChatInput();
      const text = view.container.textContent ?? '';
      expect(text).not.toContain('chatInput.attachmentActions.extractImageText');
      expect(text).not.toContain('chatInput.attachmentActions.summarizeImage');
      expect(text).not.toContain('chatInput.attachmentActions.analyzeImage');
      expect(text).not.toContain('chatInput.recognizeImage');
      expect(view.container.querySelector('[data-testid="attachment-suggestions"]')).toBeNull();
      view.unmount();
    }
  });

  it('没有文件时不出建议行；模型自述支持看图时「识别图片」入口在 + 菜单里按图片过滤导入', () => {
    const view = renderChatInput();
    expect(view.container.querySelector('[data-testid="attachment-suggestions"]')).toBeNull();

    // 默认模型已自述 image 能力（vision 门禁的 supported 一侧）⇒ 入口在场且走 images 过滤导入
    clickLabel('chatInput.recognizeImage');
    expect(mocks.importFiles).toHaveBeenCalledWith('images');
    view.unmount();
  });
});
