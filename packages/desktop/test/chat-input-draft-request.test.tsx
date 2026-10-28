// @vitest-environment jsdom

import { act, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DraftPromptRequest, DraftPromptResolution } from '../src/renderer/components/ChatInput/types';
import zh from '../src/renderer/i18n/locales/zh.json';

const mocks = vi.hoisted(() => ({
  handleSend: vi.fn(),
  focus: vi.fn(),
  importFilesFromPaths: vi.fn(),
  getPathForFile: vi.fn(),
  sendOffline: false,
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
    importFilesFromPaths: mocks.importFilesFromPaths,
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
    isOffline: mocks.sendOffline,
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

function request(id: string, prompt: string): DraftPromptRequest {
  return { id, prompt, source: 'assistant-template' };
}

function renderChatInput(
  props: {
    draftRequest?: DraftPromptRequest | null;
    onDraftResolved?: (request: DraftPromptRequest, resolution: DraftPromptResolution) => void;
  } = {},
): {
  container: HTMLDivElement;
  rerender: (nextProps: typeof props) => void;
  unmount: () => void;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => root.render(<ChatInput {...props} />));
  return {
    container,
    rerender: (nextProps) => act(() => root.render(<ChatInput {...nextProps} />)),
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function textarea(container: HTMLDivElement): HTMLTextAreaElement {
  const element = container.querySelector('textarea');
  if (!(element instanceof HTMLTextAreaElement)) throw new Error('textarea not found');
  return element;
}

function clickDialogAction(label: string): void {
  const button = [...document.body.querySelectorAll('button')].find((candidate) => candidate.textContent === label);
  if (!(button instanceof HTMLButtonElement)) throw new Error(`button not found: ${label}`);
  act(() => button.click());
}

describe('ChatInput draft requests', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    mocks.handleSend.mockClear();
    mocks.focus.mockClear();
    mocks.importFilesFromPaths.mockClear();
    mocks.getPathForFile.mockReset();
    mocks.getPathForFile.mockImplementation((file: File) => `C:\\drop\\${file.name}`);
    mocks.sendOffline = false;
    vi.spyOn(HTMLTextAreaElement.prototype, 'focus').mockImplementation(mocks.focus);
    Object.assign(window, {
      clawwork: {
        checkWhisper: vi.fn(async () => ({ available: false })),
        requestMicrophonePermission: vi.fn(async () => ({ status: 'granted' })),
        getPathForFile: mocks.getPathForFile,
      },
    });
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('applies a request to an empty composer and selects its first square-bracket placeholder', () => {
    const onDraftResolved = vi.fn();
    const draftRequest = request('request-1', 'Write about [subject], then compare [option].');
    const view = renderChatInput({ draftRequest, onDraftResolved });
    const composer = textarea(view.container);

    expect(composer.value).toBe('Write about [subject], then compare [option].');
    expect(composer.selectionStart).toBe(12);
    expect(composer.selectionEnd).toBe(21);
    expect(mocks.focus).toHaveBeenCalledTimes(1);
    expect(onDraftResolved).toHaveBeenCalledWith(draftRequest, 'applied');
    expect(mocks.handleSend).not.toHaveBeenCalled();

    view.unmount();
  });

  it('⭐ autoSend：草稿落进空输入框后直接发送（专家「开个任务」）', () => {
    const onDraftResolved = vi.fn();
    const draftRequest: DraftPromptRequest = {
      id: 'request-auto',
      prompt: '请使用你已安装的技能「架构决策记录」来完成：给登录模块写一份 ADR',
      source: 'expert-launch',
      autoSend: true,
    };
    const view = renderChatInput({ draftRequest, onDraftResolved });

    expect(textarea(view.container).value).toContain('架构决策记录');
    expect(onDraftResolved).toHaveBeenCalledWith(draftRequest, 'applied');
    expect(mocks.handleSend).toHaveBeenCalledTimes(1);

    view.unmount();
  });

  it('对照：普通草稿（无 autoSend）只填不发', () => {
    const view = renderChatInput({ draftRequest: request('request-plain', '普通预填') });
    expect(textarea(view.container).value).toBe('普通预填');
    expect(mocks.handleSend).not.toHaveBeenCalled();
    view.unmount();
  });

  it('opens a conflict dialog without changing existing composer text', () => {
    const onDraftResolved = vi.fn();
    const view = renderChatInput({ draftRequest: null, onDraftResolved });
    const composer = textarea(view.container);
    composer.value = 'My exact draft';

    view.rerender({ draftRequest: request('request-2', 'Prepared prompt'), onDraftResolved });

    expect(composer.value).toBe('My exact draft');
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    expect(onDraftResolved).not.toHaveBeenCalled();
    expect(mocks.handleSend).not.toHaveBeenCalled();

    view.unmount();
  });

  it('appends a conflicting request with exactly two newlines and selects its first full-width placeholder', () => {
    const onDraftResolved = vi.fn();
    const draftRequest = request('request-3', '围绕【主题】写一份提纲，再补充【受众】。');
    const view = renderChatInput({ draftRequest: null, onDraftResolved });
    textarea(view.container).value = 'My draft';
    view.rerender({ draftRequest, onDraftResolved });

    clickDialogAction('taskWorkbench.appendDraft');

    const composer = textarea(view.container);
    expect(composer.value).toBe('My draft\n\n围绕【主题】写一份提纲，再补充【受众】。');
    expect(composer.selectionStart).toBe(12);
    expect(composer.selectionEnd).toBe(16);
    expect(mocks.focus).toHaveBeenCalledTimes(1);
    expect(onDraftResolved).toHaveBeenCalledWith(draftRequest, 'appended');
    expect(mocks.handleSend).not.toHaveBeenCalled();

    view.unmount();
  });

  it('selects a placeholder from the appended template instead of one in the existing draft', () => {
    const onDraftResolved = vi.fn();
    const draftRequest = request('request-append-offset', 'Write about [new topic].');
    const view = renderChatInput({ draftRequest: null, onDraftResolved });
    textarea(view.container).value = 'Keep [old] value';
    view.rerender({ draftRequest, onDraftResolved });

    clickDialogAction('taskWorkbench.appendDraft');

    const composer = textarea(view.container);
    expect(composer.value).toBe('Keep [old] value\n\nWrite about [new topic].');
    expect(composer.selectionStart).toBe(30);
    expect(composer.selectionEnd).toBe(41);
    expect(mocks.focus).toHaveBeenCalledTimes(1);
    expect(onDraftResolved).toHaveBeenCalledWith(draftRequest, 'appended');

    view.unmount();
  });

  it('replaces a conflicting request and selects the first placeholder in the replacement', () => {
    const onDraftResolved = vi.fn();
    const draftRequest = request('request-4', 'Prepared [topic] prompt');
    const view = renderChatInput({ draftRequest: null, onDraftResolved });
    textarea(view.container).value = 'My draft';
    view.rerender({ draftRequest, onDraftResolved });

    clickDialogAction('taskWorkbench.replaceDraft');

    const composer = textarea(view.container);
    expect(composer.value).toBe('Prepared [topic] prompt');
    expect(composer.selectionStart).toBe(9);
    expect(composer.selectionEnd).toBe(16);
    expect(mocks.focus).toHaveBeenCalledTimes(1);
    expect(onDraftResolved).toHaveBeenCalledWith(draftRequest, 'replaced');
    expect(mocks.handleSend).not.toHaveBeenCalled();

    view.unmount();
  });

  it('cancels without changing text and does not handle the same request ID twice', () => {
    const onDraftResolved = vi.fn();
    const draftRequest = request('request-5', 'Prepared prompt');
    const view = renderChatInput({ draftRequest: null, onDraftResolved });
    textarea(view.container).value = '  My exact draft  ';
    view.rerender({ draftRequest, onDraftResolved });

    clickDialogAction('common.cancel');

    expect(textarea(view.container).value).toBe('  My exact draft  ');
    expect(onDraftResolved).toHaveBeenCalledWith(draftRequest, 'cancelled');
    view.rerender({ draftRequest: { ...draftRequest }, onDraftResolved });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(onDraftResolved).toHaveBeenCalledTimes(1);
    expect(mocks.handleSend).not.toHaveBeenCalled();

    view.unmount();
  });

  it('closes a conflict revoked by the parent and makes its old actions inert', () => {
    const onDraftResolved = vi.fn();
    const draftRequest = request('request-revoked', 'Revoked prompt');
    const view = renderChatInput({ draftRequest: null, onDraftResolved });
    const composer = textarea(view.container);
    composer.value = 'Keep this draft';
    view.rerender({ draftRequest, onDraftResolved });

    const oldAppend = [...document.body.querySelectorAll('button')].find(
      (candidate) => candidate.textContent === 'taskWorkbench.appendDraft',
    );
    expect(oldAppend).toBeInstanceOf(HTMLButtonElement);
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();

    view.rerender({ draftRequest: null, onDraftResolved });

    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    act(() => (oldAppend as HTMLButtonElement).click());
    expect(composer.value).toBe('Keep this draft');
    expect(onDraftResolved).not.toHaveBeenCalled();
    expect(mocks.handleSend).not.toHaveBeenCalled();
    view.unmount();
  });

  it('discards an old conflict before handling a replacement request ID', () => {
    const onDraftResolved = vi.fn();
    const firstRequest = request('request-old', 'Old prompt');
    const replacementRequest = request('request-new', 'New prompt');
    const view = renderChatInput({ draftRequest: null, onDraftResolved });
    const composer = textarea(view.container);
    composer.value = 'Keep this draft';
    view.rerender({ draftRequest: firstRequest, onDraftResolved });
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();

    view.rerender({ draftRequest: replacementRequest, onDraftResolved });
    clickDialogAction('taskWorkbench.appendDraft');

    expect(composer.value).toBe('Keep this draft\n\nNew prompt');
    expect(composer.value).not.toContain('Old prompt');
    expect(onDraftResolved).toHaveBeenCalledOnce();
    expect(onDraftResolved).toHaveBeenCalledWith(replacementRequest, 'appended');
    expect(mocks.handleSend).not.toHaveBeenCalled();
    view.unmount();
  });

  it('treats an empty requested prompt as focus-only applied work', () => {
    const onDraftResolved = vi.fn();
    const draftRequest = request('request-6', '');
    const view = renderChatInput({ draftRequest: null, onDraftResolved });
    textarea(view.container).value = 'Keep this';

    view.rerender({ draftRequest, onDraftResolved });

    expect(textarea(view.container).value).toBe('Keep this');
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(mocks.focus).toHaveBeenCalledTimes(1);
    expect(onDraftResolved).toHaveBeenCalledWith(draftRequest, 'applied');
    expect(mocks.handleSend).not.toHaveBeenCalled();

    view.unmount();
  });

  it('places the cursor at the end when an applied request has no placeholder', () => {
    const onDraftResolved = vi.fn();
    const draftRequest = request('request-no-placeholder', 'Prepared prompt');
    const view = renderChatInput({ draftRequest, onDraftResolved });
    const composer = textarea(view.container);

    expect(composer.selectionStart).toBe(composer.value.length);
    expect(composer.selectionEnd).toBe(composer.value.length);
    expect(mocks.focus).toHaveBeenCalledTimes(1);
    expect(onDraftResolved).toHaveBeenCalledWith(draftRequest, 'applied');

    view.unmount();
  });
});

/**
 * 「内容由 AI 生成」那行小字（2026-09-29）。
 *
 * 判据是**它在输入框正上方真的渲染出来了**，而且用的是**比正文更小的字**：
 *  - 只断言"这个 key 在词表里"是不够的 —— 键齐备但没人渲染，用户一个字都看不到
 *    （本仓栽过：整屏门禁没人渲染而测试全绿）；
 *  - 只断言"有一段文字"也不够 —— 它得是**小字**，否则就是往输入框下面塞了一句正文。
 */
describe('输入框上面的 AI 生成提示', () => {
  it('采用用户熟悉的风险提示文案', () => {
    expect(zh.chatInput.aiDisclaimer).toBe('内容由 AI 生成，请仔细甄别');
  });

  it('⭐ 渲染出来了', () => {
    const view = renderChatInput();
    expect(view.container.textContent).toContain('chatInput.aiDisclaimer');
    view.unmount();
  });

  it('⭐ 用的是 type-support（比正文小一号），不是正文', () => {
    const view = renderChatInput();
    const line = [...view.container.querySelectorAll('p')].find((el) =>
      el.textContent?.includes('chatInput.aiDisclaimer'),
    );

    expect(line, '那行提示应当是一个 <p>').toBeTruthy();
    expect(line?.className).toContain('type-support');
    expect(line?.className, '正文档会把提示变成一句话').not.toContain('type-body');
    view.unmount();
  });

  it('⭐ 位于输入框之前，作为固定的近场提示', () => {
    const view = renderChatInput();
    const line = view.container.querySelector('[data-testid="ai-content-disclaimer"]');
    const composer = textarea(view.container);

    expect(line, 'AI 提示必须能被稳定定位').toBeTruthy();
    expect(line?.compareDocumentPosition(composer) ?? 0, 'AI 提示必须出现在输入框之前，不能落到输入框下面').toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(line?.getAttribute('role')).toBe('note');
    expect(line?.className).toContain('mb-2');
    expect(line?.className).not.toContain('mt-2');
    view.unmount();
  });

  it('负对照：找不到的字必须读不到（否则上面的 toContain 可能恒真）', () => {
    const view = renderChatInput();
    expect(view.container.textContent).not.toContain('这段字压根不存在');
    view.unmount();
  });
});

/**
 * T05 拖入（2026-10-03）：桌面文件拖到输入卡片上。
 *
 * 这里只验**接线**：拖入 → `getPathForFile` 取路径 → `importFilesFromPaths`
 * （任务材料导入那条路）；文件类型/大小/目录/重名等拒绝在
 * `context-handlers.test.ts` 与文件导入自己的测试里。另有两条不可退的：
 *   · **绝不等同发送**（只入材料，发送仍要用户自己按）；
 *   · 非文件拖动（纯文本等）**不拦截**，否则应用内原生拖动会被打死。
 */
function dropZone(container: HTMLElement): HTMLElement {
  const zone = container.querySelector('[data-testid="composer-drop-zone"]');
  if (!(zone instanceof HTMLElement)) throw new Error('composer drop zone not found');
  return zone;
}

function dispatchFileDrag(
  target: Element,
  type: 'dragover' | 'drop',
  files: File[] = [],
  types: string[] = ['Files'],
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', {
    value: { files, types, dropEffect: 'none', setData: vi.fn(), getData: vi.fn() },
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

describe('ChatInput file drop（T05 拖入）', () => {
  // ⚠️ 这一组**挂在模块级**（不属于上面任何一个 describe）⇒ 夹具自己带：
  //    clawwork 的 getPathForFile 桩 + 拖入 mock 的复位都在这。
  beforeEach(() => {
    document.body.innerHTML = '';
    mocks.importFilesFromPaths.mockClear();
    mocks.getPathForFile.mockReset();
    mocks.getPathForFile.mockImplementation((file: File) => `C:\\drop\\${file.name}`);
    mocks.sendOffline = false;
    Object.assign(window, {
      clawwork: {
        checkWhisper: vi.fn(async () => ({ available: false })),
        requestMicrophonePermission: vi.fn(async () => ({ status: 'granted' })),
        getPathForFile: mocks.getPathForFile,
      },
    });
  });

  it('拖入文件 → 走 importFilesFromPaths（同一条材料导入管线），且**不发送**', () => {
    const view = renderChatInput();
    const file = new File(['x'], '草稿 报告.pdf', { type: 'application/pdf' });

    const event = dispatchFileDrag(dropZone(view.container), 'drop', [file]);

    expect(event.defaultPrevented, '拖入必须拦掉浏览器默认导航').toBe(true);
    expect(mocks.importFilesFromPaths).toHaveBeenCalledTimes(1);
    expect(mocks.importFilesFromPaths).toHaveBeenCalledWith(['C:\\drop\\草稿 报告.pdf']);
    expect(mocks.handleSend, '拖入 ≠ 发送').not.toHaveBeenCalled();

    view.unmount();
  });

  it('多文件一次拖入 → 一次导入、路径保序、中文名不丢', () => {
    const view = renderChatInput();
    const files = [
      new File(['a'], '报告 终稿.docx'),
      new File(['b'], '配图 01.png', { type: 'image/png' }),
      new File(['c'], 'deck.pptx'),
    ];

    dispatchFileDrag(dropZone(view.container), 'drop', files);

    expect(mocks.importFilesFromPaths).toHaveBeenCalledWith([
      'C:\\drop\\报告 终稿.docx',
      'C:\\drop\\配图 01.png',
      'C:\\drop\\deck.pptx',
    ]);
    view.unmount();
  });

  it('拖到卡片上方（dragover）→ 拦掉默认导航并亮描边', () => {
    const view = renderChatInput();
    const zone = dropZone(view.container);

    const event = dispatchFileDrag(zone, 'dragover');

    expect(event.defaultPrevented).toBe(true);
    expect(zone.getAttribute('data-file-dragging')).toBe('true');
    view.unmount();
  });

  it('非文件拖动（纯文本）→ 不拦截、不导入', () => {
    const view = renderChatInput();

    const event = dispatchFileDrag(dropZone(view.container), 'drop', [], ['text/plain']);

    expect(event.defaultPrevented).toBe(false);
    expect(mocks.importFilesFromPaths).not.toHaveBeenCalled();
    view.unmount();
  });

  it('取不到本地路径（浏览器拖来的 blob）→ 静默跳过，不当失败炸出来', () => {
    const view = renderChatInput();
    mocks.getPathForFile.mockReturnValue('');

    dispatchFileDrag(dropZone(view.container), 'drop', [new File(['x'], 'img.png', { type: 'image/png' })]);

    expect(mocks.importFilesFromPaths).not.toHaveBeenCalled();
    view.unmount();
  });

  it('离线/未就绪（disabled）→ 仍拦住导航，但不导入', () => {
    mocks.sendOffline = true;
    const view = renderChatInput();

    const event = dispatchFileDrag(dropZone(view.container), 'drop', [new File(['x'], 'a.pdf')]);

    expect(event.defaultPrevented).toBe(true);
    expect(mocks.importFilesFromPaths).not.toHaveBeenCalled();
    view.unmount();
  });
});
