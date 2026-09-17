// @vitest-environment jsdom

import { act, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DraftPromptRequest, DraftPromptResolution } from '../src/renderer/components/ChatInput/types';

const mocks = vi.hoisted(() => ({
  handleSend: vi.fn(),
  focus: vi.fn(),
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
    modelAvailability: 'empty',
    toolsCatalog: null,
    modelLabel: '',
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
