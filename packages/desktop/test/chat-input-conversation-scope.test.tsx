// @vitest-environment jsdom

/**
 * 会话级隔离（BUG-028）与「从当前对话移除」引用（BUG-029）——**输入框这一层**的钉法。
 *
 * 为什么这一层必须单独钉（不能只钉 hook）：
 * `useTaskMaterials` / `useAttachments` / `useMentionPicker` 各自都"看着没问题"，
 * 但输入框组件**不随会话重挂载**（见 `MainArea` 里"不能挂 key={activeTaskId}"的注释）
 * ⇒ 只要有一个组件内 state 没跟着会话改变清掉，它就会跟着用户进到下一段对话里：
 * 上一段对话暂存的图片会被打进新对话的第一条消息，上一段对话打了一半的草稿会出现在
 * 新对话的输入框里。真机反馈（2026-10-06 深夜 D 组）就是"新建对话带入了上一对话的
 * 文件/引用/状态"。
 *
 * 判据落到**用户看得见的东西**与**发送侧实际拿到的输入**两处：
 *   - 材料行 / 附件预览在 B 里必须没有 file-A；
 *   - `useChatSend`（模型请求的组装者）在 B 里拿到的 `selectedImportedFiles` /
 *     `pendingAttachments` 必须是空的 —— 那正是"请求里带不带它"的唯一输入。
 */

import { act, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  /** 每一次渲染交给 `useChatSend` 的入参（最后一份 = 当前这一屏真正会用的）。 */
  sendOptions: [] as Array<Record<string, unknown>>,
  listImportedTaskFiles: vi.fn(),
  listTaskContextSources: vi.fn(),
  /**
   * ⚠️ `t` 必须**跨渲染同一个引用**：`useTaskMaterials` 的加载 effect 依赖 `t`，
   *    每次渲染发一个新的函数 = effect 每次都跑 = setState → 再渲染 → 死循环，
   *    vitest 会直接 OOM 崩掉（我第一版就是这么写的）。
   */
  t: (key: string) => key,
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
  useTranslation: () => ({ t: mocks.t, i18n: { language: 'zh-CN', resolvedLanguage: 'zh-CN' } }),
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

// ⚠️ 只桩掉**发送**这一层，`useAttachments` / `useTaskMaterials` / `useMentionPicker` /
//    `TaskMaterials` 全部用真身 —— 本文件要测的正是它们之间的接线。
vi.mock('../src/renderer/components/ChatInput/useChatSend', () => ({
  useChatSend: (opts: Record<string, unknown>) => {
    mocks.sendOptions.push(opts);
    return {
      isGenerating: false,
      aborting: false,
      isOffline: false,
      gatewayDisplayPhase: 'ready',
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
      setQuotaBlock: vi.fn(),
      quotaDegrade: false,
      setQuotaDegrade: vi.fn(),
      switchToFallbackModel: vi.fn(),
      handleSend: vi.fn(),
      handleModelQuickSend: vi.fn(),
      handleThinkingQuickSend: vi.fn(),
      handleAbort: vi.fn(),
      handleToolSelect: vi.fn(),
    };
  },
}));

const taskState = {
  activeTaskId: null as string | null,
  tasks: [] as Array<Record<string, unknown>>,
  pendingNewTask: null as Record<string, unknown> | null,
};
const uiState = {
  sendShortcut: 'enter',
  mainView: 'chat',
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

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FILE_A = {
  fileName: 'file-A.txt',
  localPath: 'tasks/task-A/inbox/file-A.txt',
  mimeType: 'text/plain',
  size: 10,
};

function task(id: string): Record<string, unknown> {
  return {
    id,
    sessionKey: `agent:main:clawwork:task:${id}`,
    sessionId: '',
    title: id,
    status: 'active',
    createdAt: '2026-10-06T00:00:00.000Z',
    updatedAt: '2026-10-06T00:00:00.000Z',
    tags: [],
    artifactDir: '',
    gatewayId: 'gw-1',
    agentId: 'main',
  };
}

function renderChatInput(): {
  container: HTMLDivElement;
  rerender: () => void;
  unmount: () => void;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const render = () => root.render(<ChatInput />);
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

async function flush(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function textarea(container: HTMLElement): HTMLTextAreaElement {
  const element = container.querySelector('textarea');
  if (!(element instanceof HTMLTextAreaElement)) throw new Error('textarea not found');
  return element;
}

/** 材料行里那份材料自己的开关按钮（"本次使用"= 已引用）。 */
function materialChip(container: HTMLElement, fileName: string): HTMLButtonElement {
  const chip = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes(fileName));
  if (!(chip instanceof HTMLButtonElement)) throw new Error(`material chip not found: ${fileName}`);
  return chip;
}

function removeReferenceButton(container: HTMLElement): HTMLButtonElement | null {
  const button = container.querySelector('button[aria-label="chatInput.removeReference"]');
  return button instanceof HTMLButtonElement ? button : null;
}

/** 粘贴一个文件（真机上截图就是这么进输入框的：`useAttachments().handlePaste`）。 */
function pasteFile(container: HTMLElement, file: File): void {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: { items: [{ kind: 'file', getAsFile: () => file }] },
  });
  act(() => {
    textarea(container).dispatchEvent(event);
  });
}

/** 当前这一屏交给发送层的入参。 */
function lastSendOptions(): {
  selectedImportedFiles: Array<{ fileName: string }>;
  pendingAttachments: Array<{ file: File }>;
} {
  const last = mocks.sendOptions.at(-1);
  if (!last) throw new Error('useChatSend was never rendered');
  return last as never;
}

describe('新对话的会话级隔离与引用移除', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    mocks.sendOptions.length = 0;
    mocks.listImportedTaskFiles.mockReset();
    mocks.listTaskContextSources.mockReset();
    taskState.tasks = [task('task-A'), task('task-B')];
    taskState.activeTaskId = 'task-A';
    taskState.pendingNewTask = null;
    mocks.listImportedTaskFiles.mockImplementation(async (taskId: string) => ({
      ok: true,
      result: taskId === 'task-A' ? [FILE_A] : [],
    }));
    mocks.listTaskContextSources.mockResolvedValue({ ok: true, result: [] });
    Object.assign(window, {
      clawwork: {
        listImportedTaskFiles: mocks.listImportedTaskFiles,
        listTaskContextSources: mocks.listTaskContextSources,
        checkWhisper: vi.fn(async () => ({ available: false })),
        requestMicrophonePermission: vi.fn(async () => ({ status: 'granted' })),
      },
    });
    Object.assign(URL, {
      createObjectURL: vi.fn(() => `blob:mock-${Math.random()}`),
      revokeObjectURL: vi.fn(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('⭐ BUG-028：A 里引用的材料、暂存附件与草稿，都不会跟到新对话', async () => {
    const view = renderChatInput();
    await flush();

    // A：引用 file-A
    const chip = materialChip(view.container, 'file-A.txt');
    act(() => chip.click());
    expect(chip.getAttribute('aria-pressed'), 'A 里 file-A 已被引用').toBe('true');
    expect(lastSendOptions().selectedImportedFiles.map((file) => file.fileName)).toEqual(['file-A.txt']);

    // A：暂存一张截图 + 打一段草稿
    pasteFile(view.container, new File(['x'], 'shot.png', { type: 'image/png' }));
    expect(lastSendOptions().pendingAttachments.map((item) => item.file.name)).toEqual(['shot.png']);
    textarea(view.container).value = 'A 里没写完的话';

    // 新建对话（`startNewTask`：activeTaskId → null，pendingNewTask 挂上）
    taskState.activeTaskId = null;
    taskState.pendingNewTask = { gatewayId: 'gw-1', agentId: 'main' };
    view.rerender();
    await flush();

    expect(view.container.textContent, '新对话里不该有 file-A').not.toContain('file-A.txt');
    expect(lastSendOptions().selectedImportedFiles, '引用集合必须为空').toEqual([]);
    expect(lastSendOptions().pendingAttachments, '暂存的附件必须清掉').toEqual([]);
    expect(textarea(view.container).value, '草稿必须清掉').toBe('');

    // 第一条消息发出去 → 新任务被提交出来（activeTaskId: null → task-B）
    taskState.activeTaskId = 'task-B';
    taskState.pendingNewTask = null;
    view.rerender();
    await flush();

    expect(view.container.textContent, '提交那一刻也不许把 A 的材料翻出来').not.toContain('file-A.txt');
    expect(lastSendOptions().selectedImportedFiles).toEqual([]);
    expect(lastSendOptions().pendingAttachments).toEqual([]);

    // 回到 A：材料还在，引用照常可用
    taskState.activeTaskId = 'task-A';
    view.rerender();
    await flush();
    const back = materialChip(view.container, 'file-A.txt');
    expect(back.getAttribute('aria-pressed'), '回到 A 时是未引用态（引用不跨对话复活）').toBe('false');
    act(() => back.click());
    expect(lastSendOptions().selectedImportedFiles.map((file) => file.fileName)).toEqual(['file-A.txt']);

    view.unmount();
  });

  it('切换到一个**已有**对话同样清干净（不只"新建"那条路）', async () => {
    const view = renderChatInput();
    await flush();
    act(() => materialChip(view.container, 'file-A.txt').click());
    textarea(view.container).value = 'A 的草稿';

    taskState.activeTaskId = 'task-B';
    view.rerender();
    await flush();

    expect(lastSendOptions().selectedImportedFiles).toEqual([]);
    expect(textarea(view.container).value).toBe('');
    expect(view.container.textContent).not.toContain('file-A.txt');
    view.unmount();
  });

  it('⭐ 待发任务被提交成真任务的那一刻**不是**切换：草稿与暂存附件要留着（发送失败不丢）', async () => {
    taskState.activeTaskId = null;
    taskState.pendingNewTask = { gatewayId: 'gw-1', agentId: 'main' };
    const view = renderChatInput();
    await flush();

    pasteFile(view.container, new File(['x'], 'shot.png', { type: 'image/png' }));
    textarea(view.container).value = '第一条消息';
    expect(lastSendOptions().pendingAttachments).toHaveLength(1);

    // 发送把 pending 提交成 task-B（这条消息属于 B）
    taskState.activeTaskId = 'task-B';
    taskState.pendingNewTask = null;
    view.rerender();
    await flush();

    expect(
      lastSendOptions().pendingAttachments.map((item) => item.file.name),
      '提交不该吞掉刚发出去的附件',
    ).toEqual(['shot.png']);
    expect(textarea(view.container).value, '提交不该吞掉草稿').toBe('第一条消息');
    view.unmount();
  });

  it('⭐ BUG-029：× 把材料从**当前对话的引用**里移除，材料本身与历史都留着', async () => {
    const view = renderChatInput();
    await flush();
    const chip = materialChip(view.container, 'file-A.txt');
    act(() => chip.click());
    expect(lastSendOptions().selectedImportedFiles).toHaveLength(1);

    const remove = removeReferenceButton(view.container);
    expect(remove, '被引用的材料要有明确的「从当前对话移除」入口').not.toBeNull();
    act(() => remove!.click());

    // ① 引用态消失 ② 引用集合移除 ③ 后续请求不携带
    expect(materialChip(view.container, 'file-A.txt').getAttribute('aria-pressed')).toBe('false');
    expect(lastSendOptions().selectedImportedFiles).toEqual([]);
    // ④ 材料本身仍在（没有"删文件"这回事：清空引用 ≠ 删除材料）
    expect(view.container.textContent).toContain('file-A.txt');
    expect(mocks.listImportedTaskFiles).toHaveBeenCalledWith('task-A');
    // ⑤ 可以再加回来
    act(() => materialChip(view.container, 'file-A.txt').click());
    expect(lastSendOptions().selectedImportedFiles.map((file) => file.fileName)).toEqual(['file-A.txt']);
    view.unmount();
  });

  it('没有引用的材料不挂 ×（"移除"只针对当前引用，不是删材料）', async () => {
    const view = renderChatInput();
    await flush();
    expect(materialChip(view.container, 'file-A.txt')).not.toBeNull();
    expect(removeReferenceButton(view.container)).toBeNull();
    view.unmount();
  });
});

/**
 * 材料限额的**前置可见性**（2026-10-07 · 质量战役区 2 · 方案 A+D）。
 *
 * 借本文件的整屏 ChatInput 夹具（`useAttachments` / `TaskMaterials` 全是真身）钉三件事：
 *   ① 二进制附件计数徽标「已选 N/30」（text 内联类不计数）；
 *   ② 超限 ⇒ 发送按钮**先置灰** + hover 说明（不再是"点了才 toast"）；
 *   ③ 超限给「只保留前 30 个」一键裁剪 —— 只动引用，不删材料；裁完恢复可发送。
 */
describe('材料限额的前置可见性（计数徽标 / 置灰 / 一键裁剪）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    mocks.sendOptions.length = 0;
    mocks.listImportedTaskFiles.mockReset();
    mocks.listTaskContextSources.mockReset();
    taskState.tasks = [task('task-A')];
    taskState.activeTaskId = 'task-A';
    taskState.pendingNewTask = null;
    mocks.listImportedTaskFiles.mockImplementation(async (taskId: string) => ({
      ok: true,
      result: taskId === 'task-A' ? [FILE_A] : [],
    }));
    mocks.listTaskContextSources.mockResolvedValue({ ok: true, result: [] });
    Object.assign(window, {
      clawwork: {
        listImportedTaskFiles: mocks.listImportedTaskFiles,
        listTaskContextSources: mocks.listTaskContextSources,
        checkWhisper: vi.fn(async () => ({ available: false })),
        requestMicrophonePermission: vi.fn(async () => ({ status: 'granted' })),
      },
    });
    Object.assign(URL, {
      createObjectURL: vi.fn(() => `blob:mock-${Math.random()}`),
      revokeObjectURL: vi.fn(),
    });
  });

  function pasteMany(container: HTMLElement, count: number): void {
    for (let index = 0; index < count; index += 1) {
      pasteFile(container, new File(['x'], `shot-${index}.png`, { type: 'image/png' }));
    }
  }

  function sendButton(container: HTMLElement): HTMLButtonElement {
    const button = container.querySelector('button[aria-label="chatInput.send"]');
    if (!(button instanceof HTMLButtonElement)) throw new Error('send button not found');
    return button;
  }

  function trimButton(container: HTMLElement): HTMLButtonElement | null {
    const button = [...container.querySelectorAll('button')].find(
      (candidate) => candidate.textContent === 'chatInput.materialTrimToLimit',
    );
    return button instanceof HTMLButtonElement ? button : null;
  }

  function typeDraft(container: HTMLElement, value: string): void {
    const area = textarea(container);
    area.value = value;
    act(() => {
      area.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  it('⭐ 粘贴 31 个附件 ⇒ 徽标警示 + 发送置灰；一键裁剪到前 30 个后恢复', async () => {
    const view = renderChatInput();
    await flush();

    pasteMany(view.container, 31);
    const badge = view.container.querySelector('[data-testid="material-count-badge"]');
    expect(badge, '二进制附件 >0 就要有计数徽标').not.toBeNull();
    expect(badge?.textContent).toContain('chatInput.materialCountBadge');
    expect(trimButton(view.container), '超限必须给一键裁剪入口').not.toBeNull();

    // 有草稿也不行：限额未解除前发送按钮置灰（替代"点了才 toast"）
    typeDraft(view.container, 'hello');
    expect(sendButton(view.container).disabled, '31 > 30 ⇒ 置灰').toBe(true);

    act(() => trimButton(view.container)!.click());

    expect([...view.container.querySelectorAll('img')].length, '裁剪后只剩前 30 个附件').toBe(30);
    expect(trimButton(view.container), '30/30 不再超限，裁剪入口收起').toBeNull();
    expect(sendButton(view.container).disabled, '裁剪后恢复可发送').toBe(false);
    view.unmount();
  });

  it('恰好 30 个不超限：有徽标、无裁剪、可发送（边界不是 31 才放行）', async () => {
    const view = renderChatInput();
    await flush();

    pasteMany(view.container, 30);
    expect(view.container.querySelector('[data-testid="material-count-badge"]')).not.toBeNull();
    expect(trimButton(view.container)).toBeNull();

    typeDraft(view.container, 'hello');
    expect(sendButton(view.container).disabled).toBe(false);
    view.unmount();
  });

  it('引用材料与暂存附件**同一个桶**：30 个粘贴 + 1 个导入引用 = 31 ⇒ 置灰', async () => {
    const view = renderChatInput();
    await flush();

    pasteMany(view.container, 30);
    // 导入材料走 base64 附件（`readInboxFileForSend`）—— 与暂存附件同属二进制桶，合并计数
    act(() => materialChip(view.container, 'file-A.txt').click());
    expect(lastSendOptions().selectedImportedFiles).toHaveLength(1);

    typeDraft(view.container, 'hello');
    expect(trimButton(view.container), '30+1 = 31 ⇒ 超限').not.toBeNull();
    expect(sendButton(view.container).disabled).toBe(true);
    view.unmount();
  });
});
