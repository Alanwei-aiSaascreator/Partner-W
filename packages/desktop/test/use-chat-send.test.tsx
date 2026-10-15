// @vitest-environment jsdom

import { act, useRef, type Dispatch, type ReactElement, type SetStateAction } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Artifact, MeetingStatus, Message, ModelCatalogEntry, Task } from '@clawwork/shared';

const mocks = vi.hoisted(() => {
  const activeTask: Task = {
    id: 'task-1',
    sessionKey: 'agent:main:clawwork:task:task-1',
    sessionId: '',
    title: 'Task 1',
    status: 'active',
    createdAt: '2026-04-07T00:00:00.000Z',
    updatedAt: '2026-04-07T00:00:00.000Z',
    tags: [],
    artifactDir: '',
    gatewayId: 'gw-1',
    agentId: 'main',
    model: 'deepseek-v4-flash',
  };

  return {
    baseTask: activeTask,
    abort: vi.fn(async () => {}),
    applySlashCommand: vi.fn(async () => ({ ok: true })),
    send: vi.fn<
      (
        taskId: string,
        options?: Record<string, unknown>,
      ) => Promise<{ ok: boolean; taskId?: string; partialFailure?: string }>
    >(async (taskId, options) => {
      // ⭐ BUG-067 复验整改：成功 mock 必须模拟**真实 composer 的模型采用**
      // （chat-composer：presetModel 的会话 patch 成功后立即把 task.model 更新为该模型）
      // —— UI 侧的"已采用"判据读的就是这份状态；不能用 ok=true 冒充采用。
      const presetModel = options?.presetModel;
      if (typeof presetModel === 'string') {
        mocks.taskState.tasks = mocks.taskState.tasks.map((item) =>
          item.id === taskId ? { ...item, model: presetModel } : item,
        );
      }
      return { ok: true, taskId: 'task-1' };
    }),
    toastWarning: vi.fn(),
    toastError: vi.fn(),
    // 图片路由「切了才提示」走 toast.info（轻量、无按钮）—— 同一套 sonner mock 里补一只。
    toastInfo: vi.fn(),
    // t 做成 spy（行为不变：照旧返回 key）：图片路由的提示**带模型名**，
    // 而插值值是传给 t 的第二个参数 —— 只有 spy 看得见它。
    t: vi.fn((key: string) => key),
    meetingState: {
      records: [] as Array<{
        id: string;
        status: MeetingStatus;
        abortStatus?: 'unconfirmed' | 'requested' | 'confirmed' | 'not-running';
        turns: Array<{ taskId: string }>;
      }>,
    },
    taskState: {
      tasks: [activeTask],
      activeTaskId: 'task-1' as string | null,
      pendingNewTask: null,
      commitPendingTask: vi.fn(),
      updateTaskMetadata: vi.fn(),
    },
    messageState: {
      messagesByTask: {} as Record<string, Message[]>,
      addMessage: vi.fn(),
      setProcessing: vi.fn(),
      processingBySession: new Set<string>(),
      activeTurnBySession: {},
      // 对比那条路要用到的几个字段（按会话键索引的旁路 + 采纳落库）：
      errorBySession: {} as Record<string, string>,
      setSessionError: vi.fn(),
      clearActiveTurn: vi.fn(),
      adoptActiveTurn: vi.fn(),
    },
    uiState: {
      gatewayStatusMap: { 'gw-1': 'connected' } as Record<string, 'connected' | 'connecting' | 'disconnected'>,
      modelCatalogByGateway: {} as Record<string, ModelCatalogEntry[]>,
      agentCatalogByGateway: {} as Record<string, { agents: Array<{ id: string; name?: string }>; defaultId: string }>,
      // 手写 store 桩**必须跟着长**（缺一个字段 = 整屏渲染崩）。
      modelCatalogFailureByGateway: {} as Record<string, true>,
      toolsCatalogByGateway: {},
      effectiveToolsByGateway: {} as Record<string, Record<string, unknown>>,
      // 「这次运行连上过没有」+ 重连进度：输入框那格说"正在启动"还是"离线只读"靠它们分
      //（`lib/gateway-display-phase.ts`）。缺这两个字段时真身走 `?.` ⇒ 一律"从没连上过"。
      gatewayReconnectInfo: {} as Record<string, { attempt: number; max: number; gaveUp: boolean }>,
      gatewayEverConnected: {} as Record<string, true>,
      // 网关协商的单帧上限（`hello-ok.policy.maxPayload`）：发送字节预算按它折算（2026-10-07 · P1-1）
      gatewayMaxPayloadByGateway: {} as Record<string, number>,
    },
    roomState: {
      rooms: {},
      // 合议（ensemble）路由的初始化：只用于"conductor 花名册带不带助手描述"那条回归钉。
      // 参数照真实签名写出来（`vi.fn(async () => true)` 的 calls 类型是空元组，断言取 [3] 过不了 tsc）。
      initConductor: vi.fn(async (_taskId: string, _gatewayId: string, _sessionKey: string, _catalog: string) => true),
    },
    teamState: {
      teams: {} as Record<string, import('@clawwork/shared').Team>,
      loadTeam: vi.fn(async () => null as import('@clawwork/shared').Team | null),
    },
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mocks.t }),
  // i18n 实例在模块加载时就会 `use(initReactI18next)`（见 src/renderer/i18n），
  // 而 useChatSend → 对比 store 会把它拉进这个测试；少了这个导出，整个测试文件加载即失败。
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

vi.mock('sonner', () => ({
  toast: {
    error: mocks.toastError,
    warning: mocks.toastWarning,
    info: mocks.toastInfo,
  },
}));

vi.mock('../src/renderer/platform', () => ({
  composer: {
    abort: mocks.abort,
    applySlashCommand: mocks.applySlashCommand,
    send: mocks.send,
  },
  // 对比 store 的单例是惰性建的，但它要从 platform 拿这两个 store 的 getState
  //（对比模式那条路要用）—— 少了它们，走对比分支的用例会在建实例时炸。
  messageStore: { getState: () => mocks.messageState },
  taskStore: { getState: () => mocks.taskState },
  // 与真实 platform 同形：`useTaskStore.getState = taskStoreApi.getState`
  //（BUG-067 整改后 hook 会读 `useTaskStore.getState().tasks` 判"已采用"——
  //  mock 少了这个 getState，采用判定会静默落空）。
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
  // `getState` 是合议路由（conductor 初始化）用的：`useRoomStore.getState().initConductor(...)`
  useRoomStore: Object.assign(
    <T,>(selector?: (state: typeof mocks.roomState) => T) => (selector ? selector(mocks.roomState) : mocks.roomState),
    { getState: () => mocks.roomState },
  ),
  useTeamStore: Object.assign(
    <T,>(selector?: (state: typeof mocks.teamState) => T) => (selector ? selector(mocks.teamState) : mocks.teamState),
    { getState: () => mocks.teamState },
  ),
}));

import { UnknownAgentError } from '@clawwork/core';
vi.mock('../src/renderer/features/team-meeting/instance', () => ({
  teamMeetingController: { store: { getState: () => mocks.meetingState } },
}));
import { useChatSend } from '../src/renderer/components/ChatInput/useChatSend';
import type { PendingAttachment } from '../src/renderer/components/ChatInput/types';
import type { ImportedMaterialFile, TaskContextFile } from '../src/renderer/components/ChatInput/useTaskMaterials';
import { useCommercialStore } from '../src/renderer/stores/commercialStore';
import { compareStore } from '../src/renderer/features/compare/compare-store-instance';

function render(ui: ReactElement): {
  container: HTMLDivElement;
  rerender: (next: ReactElement) => void;
  unmount: () => void;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  act(() => {
    root.render(ui);
  });

  return {
    container,
    rerender: (next) => act(() => root.render(next)),
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function Harness({ initialValue = '' }: { initialValue?: string }) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const chat = useChatSend({
    textareaRef,
    pendingAttachments: [],
    setPendingAttachments: vi.fn(),
    selectedTasks: [],
    setSelectedTasks: vi.fn(),
    selectedArtifacts: [],
    setSelectedArtifacts: vi.fn(),
    selectedLocalFiles: [],
    setSelectedLocalFiles: vi.fn(),
    selectedImportedFiles: [],
    clearSelectedImportedFiles: vi.fn(),
    markImportedFileMissing: vi.fn(),
    selectedAgents: [],
    setSelectedAgents: vi.fn(),
    stopVoiceInput: vi.fn(),
  });

  return (
    <>
      <textarea ref={textareaRef} defaultValue={initialValue} />
      <button type="button" onClick={() => void chat.handleAbort()}>
        abort
      </button>
      <button type="button" onClick={() => void chat.handleSend()}>
        send
      </button>
      <div data-testid="aborting">{chat.aborting ? 'aborting' : 'idle'}</div>
      <div data-testid="model-availability">{chat.modelAvailability}</div>
      <div data-testid="tool-ids">
        {chat.toolsCatalog?.groups.flatMap((group) => group.tools.map((tool) => tool.id)).join(',') ?? ''}
      </div>
    </>
  );
}

const importedMaterial: ImportedMaterialFile = {
  taskId: 'task-1',
  fileName: 'brief.pdf',
  localPath: 'tasks/task-1/inbox/brief.pdf',
  mimeType: 'application/pdf',
  size: 64,
  availability: 'available',
};

const folderMaterial: TaskContextFile = {
  taskId: 'task-1',
  sourceId: 'source-1',
  sourceName: 'Research',
  fileName: 'notes.txt',
  relativePath: 'notes.txt',
  mimeType: 'text/plain',
  size: 1,
  mtime: 1,
  tier: 'text',
};

function MaterialHarness({
  clearImported,
  clearFolder,
  markMissing = vi.fn(),
  importedMaterials = [importedMaterial],
  folderMaterials = [folderMaterial],
  taskMentions = [] as Task[],
  draft = 'summarize',
}: {
  clearImported: () => void;
  clearFolder: Dispatch<SetStateAction<TaskContextFile[]>>;
  markMissing?: (localPath: string) => void;
  importedMaterials?: ImportedMaterialFile[];
  folderMaterials?: TaskContextFile[];
  taskMentions?: Task[];
  draft?: string;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const chat = useChatSend({
    textareaRef,
    pendingAttachments: [],
    setPendingAttachments: vi.fn(),
    selectedTasks: taskMentions,
    setSelectedTasks: vi.fn(),
    selectedArtifacts: [],
    setSelectedArtifacts: vi.fn(),
    selectedLocalFiles: folderMaterials,
    setSelectedLocalFiles: clearFolder,
    selectedImportedFiles: importedMaterials,
    clearSelectedImportedFiles: clearImported,
    markImportedFileMissing: markMissing,
    selectedAgents: [],
    setSelectedAgents: vi.fn(),
    stopVoiceInput: vi.fn(),
  });
  return (
    <>
      <textarea ref={textareaRef} defaultValue={draft} />
      <button type="button" onClick={() => void chat.handleSend()}>
        send
      </button>
    </>
  );
}

describe('useChatSend abort flow', () => {
  beforeEach(() => {
    mocks.messageState.messagesByTask = {};
    // B 块单飞门读这两个字段；用例改了必须复位，否则泄漏给后面所有用例。
    mocks.messageState.processingBySession = new Set<string>();
    mocks.messageState.activeTurnBySession = {};
    vi.useFakeTimers();
    document.body.innerHTML = '';
    mocks.abort.mockClear();
    mocks.applySlashCommand.mockClear();
    mocks.send.mockClear();
    mocks.toastWarning.mockClear();
    mocks.toastError.mockClear();
    mocks.meetingState.records = [];
    // ⚠️ 必须重置实现，不只是清调用：`commitPendingTask` 有测试会装"抛错"的实现，
    //    不重置就**泄漏给后面所有用例**（2026-09-24 我自己踩了一次：4 条无关用例跟着红）。
    mocks.taskState.commitPendingTask.mockReset();
    mocks.taskState.activeTaskId = 'task-1';
    mocks.taskState.tasks = [{ ...mocks.baseTask }];
    Object.assign(window, {
      clawwork: {
        getConfig: vi.fn(async () => ({
          ok: true,
          result: { config: { models: { providers: { clawrouter: { models: [] } } } } },
        })),
        readInboxFileForSend: vi.fn(async () => ({
          ok: true,
          result: { content: 'cGRm', encoding: 'base64', byteLength: 3 },
        })),
        readTaskContextFileForSend: vi.fn(async () => ({
          ok: true,
          result: { content: 'notes', mimeType: 'text/plain', size: 5, byteLength: 5, truncated: false, tier: 'text' },
        })),
        // 区 3 回归钉用：首轮产物索引**不许**再被自动读取（被切断了），桩在这里是"诱饵"——
        // 一旦有人把索引注入加回来，`listArtifacts` 会被调用、断言立刻红。
        listArtifacts: vi.fn(async () => ({
          ok: true,
          result: [{ id: 'a-1', name: '上一段对话的汇报.pptx', taskId: 'task-other' }],
        })),
        loadMessages: vi.fn(async () => ({
          ok: true,
          rows: [{ role: 'user', content: '被 @ 的任务里的一句话' }],
        })),
        // `agents.files.get` 的**真机载荷形状**（`{ agentId, workspace, file: { name, content, missing } }`）。
        getAgentFile: vi.fn(async () => ({
          ok: true,
          result: {
            agentId: 'a1',
            workspace: 'ws',
            file: { name: 'IDENTITY.md', content: '---\ndescription: 精通数据分析\n---\n正文', missing: false },
          },
        })),
      },
    });
    mocks.uiState.gatewayStatusMap = { 'gw-1': 'connected' };
    mocks.uiState.modelCatalogByGateway = {};
    mocks.uiState.agentCatalogByGateway = {};
    mocks.uiState.toolsCatalogByGateway = {};
    mocks.uiState.effectiveToolsByGateway = {};
    mocks.uiState.gatewayMaxPayloadByGateway = {};
    mocks.roomState.rooms = {};
    mocks.roomState.initConductor.mockClear();
    mocks.teamState.teams = {};
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
        fetchedAt: '2026-09-15T00:00:00.000Z',
      },
    });
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  it.each(
    (['draft', 'running', 'stopping'] as const).flatMap((status) =>
      ['task-1', 'task-2', 'task-3'].map((taskId) => ({ status, taskId })),
    ),
  )('blocks ordinary sends to $taskId while its meeting is $status', async ({ status, taskId }) => {
    mocks.taskState.activeTaskId = taskId;
    mocks.taskState.tasks = [{ ...mocks.baseTask, id: taskId }];
    mocks.meetingState.records = [
      { id: 'meeting-1', status, turns: ['task-1', 'task-2', 'task-3'].map((id) => ({ taskId: id })) },
    ];
    const { container, unmount } = render(<Harness initialValue="follow up" />);
    await act(async () => {
      container.querySelectorAll('button')[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith('meeting.taskBusy', expect.any(Object));
    expect(container.querySelector('textarea')!.value).toBe('follow up');
    unmount();
  });

  it('rechecks meeting ownership after awaiting material reads', async () => {
    let release!: (result: Awaited<ReturnType<typeof window.clawwork.readInboxFileForSend>>) => void;
    vi.mocked(window.clawwork.readInboxFileForSend).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const clearImported = vi.fn();
    const clearFolder = vi.fn();
    const { container, unmount } = render(<MaterialHarness clearImported={clearImported} clearFolder={clearFolder} />);
    await act(async () => {
      container.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(window.clawwork.readInboxFileForSend).toHaveBeenCalledOnce();
    mocks.meetingState.records = [{ id: 'meeting-1', status: 'running', turns: [{ taskId: 'task-1' }] }];
    await act(async () => {
      release({ ok: true, result: { content: 'cGRm', encoding: 'base64', byteLength: 3 } });
    });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith('meeting.taskBusy', expect.any(Object));
    expect(container.querySelector('textarea')!.value).toBe('summarize');
    expect(clearImported).not.toHaveBeenCalled();
    expect(clearFolder).not.toHaveBeenCalled();
    unmount();
  });

  it.each(
    (['interrupted', 'stopped'] as const).flatMap((status) =>
      (['unconfirmed', 'requested'] as const).flatMap((abortStatus) =>
        ['task-1', 'task-2', 'task-3'].map((taskId) => ({ status, abortStatus, taskId })),
      ),
    ),
  )(
    'keeps recovered $status meeting task $taskId locked while abort is $abortStatus',
    async ({ status, abortStatus, taskId }) => {
      mocks.taskState.activeTaskId = taskId;
      mocks.taskState.tasks = [{ ...mocks.baseTask, id: taskId }];
      mocks.meetingState.records = [
        {
          id: 'meeting-1',
          status,
          abortStatus,
          turns: ['task-1', 'task-2', 'task-3'].map((id) => ({ taskId: id })),
        },
      ];
      const { container, unmount } = render(<Harness initialValue="follow up" />);
      await act(async () => {
        container.querySelectorAll('button')[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(mocks.send).not.toHaveBeenCalled();
      expect(mocks.toastError).toHaveBeenCalledWith('meeting.taskBusy', expect.any(Object));
      unmount();
    },
  );

  it.each(['confirmed', 'not-running'] as const)(
    'unlocks a stopped meeting task once abort is %s',
    async (abortStatus) => {
      mocks.meetingState.records = [{ id: 'meeting-1', status: 'stopped', abortStatus, turns: [{ taskId: 'task-1' }] }];
      const { container, unmount } = render(<Harness initialValue="follow up" />);
      await act(async () => {
        container.querySelectorAll('button')[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(mocks.send).toHaveBeenCalledOnce();
      expect(mocks.toastError).not.toHaveBeenCalled();
      unmount();
    },
  );

  it.each(['completed', 'failed', 'stopped', 'interrupted'] as const)(
    'allows an ordinary follow-up after the meeting is %s',
    async (status) => {
      mocks.meetingState.records = [{ id: 'meeting-1', status, turns: [{ taskId: 'task-1' }] }];
      const { container, unmount } = render(<Harness initialValue="follow up" />);
      await act(async () => {
        container.querySelectorAll('button')[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(mocks.send).toHaveBeenCalledOnce();
      expect(mocks.toastError).not.toHaveBeenCalled();
      unmount();
    },
  );

  it('⭐ 上一轮仍在处理 ⇒ 普通发送被具名拦住（保留草稿、不发请求）', async () => {
    // ⚠️ DOCX-205 合同（2026-10-10）B 块：会话在执行中时普通新请求单飞 ——
    //    键盘 Enter 与发送按钮都走 `handleSend`（按钮变"停止"不代表 Enter 被拦）。
    mocks.messageState.processingBySession = new Set(['agent:main:clawwork:task:task-1']);
    const { container, unmount } = render(<Harness initialValue="再发一条消息" />);
    await act(async () => {
      container.querySelectorAll('button')[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(mocks.toastError).toHaveBeenCalledWith('chatInput.turnInFlight', expect.any(Object));
    expect(mocks.send).not.toHaveBeenCalled();
    // 草稿保留：输入框里还是原文。
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea.value).toBe('再发一条消息');
    unmount();
  });

  it('allows sends to tasks outside an active meeting', async () => {
    mocks.meetingState.records = [{ id: 'meeting-1', status: 'running', turns: [{ taskId: 'task-other' }] }];
    const { container, unmount } = render(<Harness initialValue="follow up" />);
    await act(async () => {
      container.querySelectorAll('button')[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(mocks.send).toHaveBeenCalledOnce();
    unmount();
  });

  it('passes persisted artifact diagnostics to the next requested turn without changing user text', async () => {
    const sessionKey = mocks.baseTask.sessionKey;
    mocks.messageState.messagesByTask['task-1'] = [
      {
        id: 'delivery-failed',
        taskId: 'task-1',
        sessionKey,
        role: 'system',
        content: '[artifact-delivery-failed]\n[dsl-close-mismatch @34] expected </Text> but found </Slide>',
        timestamp: '2026-09-29T00:00:00.000Z',
        artifacts: [],
        toolCalls: [],
      },
    ];
    const { container, unmount } = render(<Harness initialValue="Please fix the PPT" />);
    expect(mocks.send).not.toHaveBeenCalled();
    await act(async () => {
      container.querySelectorAll('button')[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(mocks.send).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        content: 'Please fix the PPT',
        contextPrefix: expect.stringContaining('dsl-close-mismatch @34'),
      }),
    );
    unmount();
  });

  it('does not expose a static catalog when the session effective lookup failed', () => {
    mocks.uiState.toolsCatalogByGateway = {
      'gw-1': {
        groups: [
          {
            id: 'core',
            label: 'Core',
            source: 'core',
            tools: [{ id: 'ghost_tool', label: 'Ghost', description: '', source: 'core' }],
          },
        ],
      },
    };
    mocks.uiState.effectiveToolsByGateway = {
      'gw-1': {
        [mocks.taskState.tasks[0]!.sessionKey]: { status: 'error', error: 'unknown session key' },
      },
    };

    const { container, unmount } = render(<Harness />);

    expect(container.querySelector('[data-testid="tool-ids"]')?.textContent).toBe('');
    unmount();
  });

  it('exposes only the session effective inventory', () => {
    mocks.uiState.effectiveToolsByGateway = {
      'gw-1': {
        [mocks.taskState.tasks[0]!.sessionKey]: {
          status: 'ready',
          inventory: {
            agentId: 'main',
            profile: 'coding',
            groups: [
              {
                id: 'core',
                label: 'Core',
                source: 'core',
                tools: [{ id: 'exec', label: 'Exec', description: '', rawDescription: '', source: 'core' }],
              },
            ],
          },
        },
      },
    };

    const { container, unmount } = render(<Harness />);

    expect(container.querySelector('[data-testid="tool-ids"]')?.textContent).toBe('exec');
    unmount();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('clears the abort reset timer on unmount', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { container, unmount } = render(<Harness />);

    const button = container.querySelector('button');
    expect(button).not.toBeNull();

    await act(async () => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="aborting"]')?.textContent).toBe('aborting');
    expect(vi.getTimerCount()).toBe(1);

    unmount();
    expect(vi.getTimerCount()).toBe(0);

    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(consoleError).not.toHaveBeenCalled();
  });

  /**
   * W02 停止口径（2026-10-03）：“先请求停止、后等 ACK”以及失败如实。
   * 三条都是 P0 验收面：停止期间的**界面状态**与**请求次数**都不得说谎。
   */
  it('⭐ 停止：先请求停止、等 ACK 期间保持 stopping，确认后才回 idle', async () => {
    let release!: () => void;
    mocks.abort.mockImplementation(() => new Promise<void>((resolve) => (release = resolve)));
    const { container, unmount } = render(<Harness />);
    const button = container.querySelector('button')!;

    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    // 请求已按**当前任务 id**发出；ACK 未回 ⇒ 不许说“已停止”
    expect(mocks.abort).toHaveBeenCalledWith('task-1');
    expect(container.querySelector('[data-testid="aborting"]')?.textContent).toBe('aborting');

    await act(async () => {
      release();
      await Promise.resolve();
    });
    act(() => vi.advanceTimersByTime(500));
    expect(container.querySelector('[data-testid="aborting"]')?.textContent).toBe('idle');
    unmount();
  });

  it('⭐ 停止失败：如实报错（abortFailed），且状态不许卡死在 stopping', async () => {
    mocks.abort.mockRejectedValueOnce(new Error('boom'));
    const { container, unmount } = render(<Harness />);

    await act(async () => {
      container.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    // 失败提示刻意久留（duration 10000）——停止失败是要用户去处理的，不该一闪而过。
    expect(mocks.toastError).toHaveBeenCalledWith(
      'chatInput.abortFailed',
      expect.objectContaining({ duration: 10000 }),
    );
    act(() => vi.advanceTimersByTime(500));
    expect(container.querySelector('[data-testid="aborting"]')?.textContent).toBe('idle');
    unmount();
  });

  it('⭐ 停止中连点：同一轮只发一次停止请求（不重复打网关）', async () => {
    let release!: () => void;
    mocks.abort.mockImplementation(() => new Promise<void>((resolve) => (release = resolve)));
    const { container, unmount } = render(<Harness />);
    const button = container.querySelector('button')!;

    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(mocks.abort).toHaveBeenCalledTimes(1);

    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(mocks.abort).toHaveBeenCalledTimes(1);

    await act(async () => {
      release();
      await Promise.resolve();
    });
    unmount();
  });

  it('routes model slash input through the local command path', async () => {
    const { container } = render(<Harness initialValue="/model public/deepseek-v4-pro" />);
    const buttons = container.querySelectorAll('button');

    await act(async () => {
      buttons[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(mocks.applySlashCommand).toHaveBeenCalledWith('task-1', 'model', 'public/deepseek-v4-pro');
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('sends the active task model before the first message', async () => {
    const { container } = render(<Harness initialValue="hello" />);
    const buttons = container.querySelectorAll('button');

    await act(async () => {
      buttons[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(mocks.send).toHaveBeenCalledWith('task-1', expect.objectContaining({ presetModel: 'deepseek-v4-flash' }));
  });

  it('injects the four-phase contract into hidden context for a direct team task', async () => {
    const active = mocks.taskState.tasks[0]!;
    mocks.taskState.tasks = [{ ...active, teamId: 'team-design', ensemble: false }];
    mocks.teamState.teams = {
      'team-design': {
        id: 'team-design',
        name: 'Merchant Service Squad',
        emoji: '🍽️',
        description: '餐饮运营团队',
        gatewayId: 'gw-1',
        source: 'local',
        version: '1',
        agents: [
          { agentId: 'main', role: 'coordinator', isManager: true, skills: [] },
          { agentId: 'reviewer', role: 'worker', position: 'challenger', isManager: false, skills: [] },
        ],
        createdAt: '2026-09-29T00:00:00.000Z',
        updatedAt: '2026-09-29T00:00:00.000Z',
      },
    };
    mocks.uiState.agentCatalogByGateway = {
      'gw-1': {
        defaultId: 'main',
        agents: [
          { id: 'main', name: 'Front Desk' },
          { id: 'reviewer', name: 'Quality Reviewer' },
        ],
      },
    };
    const { container, unmount } = render(<Harness initialValue="设计一张发布海报" />);

    await act(async () => {
      (container.querySelectorAll('button')[1] as HTMLButtonElement).click();
      await Promise.resolve();
    });

    expect(mocks.send).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        content: '设计一张发布海报',
        contextPrefix: expect.stringMatching(/策略[\s\S]*创作[\s\S]*质检[\s\S]*修订[\s\S]*交付/),
      }),
    );
    const options = mocks.send.mock.calls[0]![1] as { contextPrefix: string };
    expect(options.contextPrefix).toContain('当前实际可用的工具');
    expect(options.contextPrefix).toContain('产物确实存在');
    expect(options.contextPrefix).toContain('sessions_spawn');
    expect(options.contextPrefix).toContain('Merchant Service Squad');
    expect(options.contextPrefix).toContain('Front Desk');
    expect(options.contextPrefix).toContain('Quality Reviewer');
    expect(options.contextPrefix).toContain('challenger');
    expect(options.contextPrefix).toContain('agentId="main" name="Front Desk" role="coordinator" position="expert"');
    expect(options.contextPrefix).toContain('single-agent-reliable');
    unmount();
  });

  it('冷启动未打开团队页也会按 teamId 补读花名册再发送', async () => {
    const active = mocks.taskState.tasks[0]!;
    mocks.taskState.tasks = [{ ...active, teamId: 'team-cold', ensemble: false }];
    mocks.teamState.teams = {};
    mocks.teamState.loadTeam.mockImplementationOnce(async () => {
      const team: import('@clawwork/shared').Team = {
        id: 'team-cold',
        name: '中文增长团队',
        emoji: '🚀',
        description: '冷启动团队',
        gatewayId: 'gw-1',
        source: 'local',
        version: '1',
        agents: [{ agentId: 'main', role: 'coordinator', isManager: true, skills: [] }],
        createdAt: '2026-09-29T00:00:00.000Z',
        updatedAt: '2026-09-29T00:00:00.000Z',
      };
      mocks.teamState.teams[team.id] = team;
      return team;
    });
    mocks.uiState.agentCatalogByGateway = {
      'gw-1': { defaultId: 'main', agents: [{ id: 'main', name: '增长主管' }] },
    };
    const { container, unmount } = render(<Harness initialValue="继续昨天的方案" />);

    await act(async () => {
      (container.querySelectorAll('button')[1] as HTMLButtonElement).click();
      await Promise.resolve();
    });

    expect(mocks.teamState.loadTeam).toHaveBeenCalledWith('team-cold');
    const options = mocks.send.mock.calls[0]![1] as { contextPrefix: string };
    expect(options.contextPrefix).toContain('中文增长团队');
    expect(options.contextPrefix).toContain('增长主管');
    expect(options.contextPrefix).toContain('position="expert"');
    unmount();
  });

  it('bypasses legacy ensemble delivery for an already-open team task', async () => {
    const active = mocks.taskState.tasks[0]!;
    mocks.taskState.tasks = [{ ...active, teamId: 'team-design', ensemble: true }];
    mocks.roomState.rooms = {
      'task-1': {
        taskId: 'task-1',
        conductorSessionKey: 'agent:conductor:clawwork:task:task-1',
        conductorReady: true,
        status: 'active',
        performers: [],
      },
    };
    const { container, unmount } = render(<Harness initialValue="continue the team task" />);

    await act(async () => {
      (container.querySelectorAll('button')[1] as HTMLButtonElement).click();
      await Promise.resolve();
    });

    expect(mocks.send).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        contextPrefix: expect.stringMatching(/1\.[\s\S]*2\.[\s\S]*3\.[\s\S]*4\./),
        deferUserMessageUntilSent: false,
      }),
    );
    unmount();
  });

  it('does not call the model or tools when the current account has zero quota', async () => {
    const current = useCommercialStore.getState().overview!;
    useCommercialStore.setState({
      status: 'ready',
      overview: {
        ...current,
        license: { ...current.license!, tokenQuotaMicros: 0, tokenUsedMicros: 0 },
      },
    });
    const { container } = render(<Harness initialValue="run a tool" />);
    const buttons = container.querySelectorAll('button');

    await act(async () => {
      buttons[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.applySlashCommand).not.toHaveBeenCalled();
  });

  it('keeps a missing connected catalog in the loading state instead of reporting empty', () => {
    const { container, unmount } = render(<Harness />);

    expect(container.querySelector('[data-testid="model-availability"]')?.textContent).toBe('models-loading');

    unmount();
  });

  it('⭐ 目录取不到（退避已用尽）⇒ 报显式失败态，不再冒充"正在加载"', () => {
    // 2026-09-20 用户报障「使用出现加载模型那个一直卡住」：取失败那条路不进重试，
    // 目录永远 `undefined` ⇒ 输入框那句"正在准备模型…"**永远不会变**。
    mocks.uiState.modelCatalogFailureByGateway = { 'gw-1': true };
    try {
      const { container, unmount } = render(<Harness />);

      expect(container.querySelector('[data-testid="model-availability"]')?.textContent).toBe('catalog-failed');

      unmount();
    } finally {
      mocks.uiState.modelCatalogFailureByGateway = {};
    }
  });

  it('sends imported inbox files and task-scoped folder files without renderer absolute paths', async () => {
    const clearImported = vi.fn();
    const clearFolder = vi.fn();
    const { container, unmount } = render(<MaterialHarness clearImported={clearImported} clearFolder={clearFolder} />);

    await act(async () => {
      (container.querySelector('button') as HTMLButtonElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(window.clawwork.readInboxFileForSend).toHaveBeenCalledWith('tasks/task-1/inbox/brief.pdf');
    expect(window.clawwork.readTaskContextFileForSend).toHaveBeenCalledWith('task-1', 'source-1', 'notes.txt');
    expect(mocks.send).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        content: expect.stringContaining('<file path="notes.txt">\nnotes\n</file>'),
        attachments: [{ mimeType: 'application/pdf', fileName: 'brief.pdf', content: 'cGRm' }],
        messageAttachments: [
          expect.objectContaining({
            fileName: 'brief.pdf',
            localPath: 'tasks/task-1/inbox/brief.pdf',
          }),
        ],
      }),
    );
    expect(clearImported).toHaveBeenCalledTimes(1);
    expect(clearFolder).toHaveBeenCalledWith([]);
    unmount();
  });

  it('keeps text and material selections when gateway dispatch fails', async () => {
    mocks.send.mockResolvedValueOnce({ ok: false, taskId: 'task-1' });
    const clearImported = vi.fn();
    const clearFolder = vi.fn();
    const { container, unmount } = render(<MaterialHarness clearImported={clearImported} clearFolder={clearFolder} />);

    await act(async () => {
      (container.querySelector('button') as HTMLButtonElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('summarize');
    expect(clearImported).not.toHaveBeenCalled();
    expect(clearFolder).not.toHaveBeenCalled();
    unmount();
  });

  it('forwards a task-scoped binary folder file as a gateway attachment', async () => {
    vi.mocked(window.clawwork.readTaskContextFileForSend).mockResolvedValueOnce({
      ok: true,
      result: {
        content: 'aW1hZ2U=',
        mimeType: 'image/png',
        size: 5,
        byteLength: 5,
        truncated: false,
        tier: 'image',
      },
    });
    const { container, unmount } = render(<MaterialHarness clearImported={vi.fn()} clearFolder={vi.fn()} />);

    await act(async () => {
      (container.querySelector('button') as HTMLButtonElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.send).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        attachments: expect.arrayContaining([{ mimeType: 'image/png', fileName: 'notes.txt', content: 'aW1hZ2U=' }]),
      }),
    );
    unmount();
  });

  /**
   * ⭐ BUG-028 的最后一道闸门（第三层的防线）：**别的对话的引用**即使因为某个 state 没清干
   * 净而漏进来，也绝不许进这次请求 —— 拦下、说清、一个字都不发（也不去读那份文件）。
   *
   * 这条不是"理论上的保险"：`selectedImportedFiles` 是渲染层交进来的引用集合，而引用集合
   * 一旦跨对话串味，用户看到的就是"新对话拿着上一段对话的文件在跑"（2026-10-06 深夜 D 组）。
   */
  it('⭐ 上一段对话的引用混进本次发送 ⇒ 拦住并说明，不读文件、不发请求', async () => {
    const foreignMaterial: ImportedMaterialFile = {
      ...importedMaterial,
      taskId: 'task-2',
      localPath: 'tasks/task-2/inbox/brief.pdf',
    };
    const { container, unmount } = render(
      <MaterialHarness clearImported={vi.fn()} clearFolder={vi.fn()} importedMaterials={[foreignMaterial]} />,
    );

    await act(async () => {
      (container.querySelector('button') as HTMLButtonElement).click();
      await Promise.resolve();
    });

    expect(mocks.toastError).toHaveBeenCalledWith('chatInput.materialUnavailable', expect.any(Object));
    expect(window.clawwork.readInboxFileForSend, '不去读别的对话的文件').not.toHaveBeenCalled();
    expect(mocks.send, '一个字都不发').not.toHaveBeenCalled();
    unmount();
  });

  it('marks an unavailable inbox material and preserves the draft without dispatching', async () => {
    vi.mocked(window.clawwork.readInboxFileForSend).mockResolvedValueOnce({ ok: false, error: 'missing' });
    const clearImported = vi.fn();
    const clearFolder = vi.fn();
    const markMissing = vi.fn();
    const { container, unmount } = render(
      <MaterialHarness clearImported={clearImported} clearFolder={clearFolder} markMissing={markMissing} />,
    );

    await act(async () => {
      (container.querySelector('button') as HTMLButtonElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(markMissing).toHaveBeenCalledWith('tasks/task-1/inbox/brief.pdf', 'task-1');
    expect(mocks.send).not.toHaveBeenCalled();
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('summarize');
    expect(clearImported).not.toHaveBeenCalled();
    expect(clearFolder).not.toHaveBeenCalled();
    unmount();
  });

  /**
   * ⭐ F 组（BUG-030）read/analyze by default：带着文件发消息、没说要改 ⇒
   * 附件纪律必须写进**只给模型看的 `contextPrefix`**（不是正文：正文会进气泡、会落库）。
   */
  it('⭐ 带文件、没说要改 ⇒ 只读纪律进 contextPrefix，正文一个字不动', async () => {
    const { container, unmount } = render(<MaterialHarness clearImported={vi.fn()} clearFolder={vi.fn()} />);

    await act(async () => {
      (container.querySelector('button') as HTMLButtonElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const options = mocks.send.mock.calls[0]![1] as { content: string; contextPrefix: string };
    // 正文只含"用户的话 + 文件夹材料的既有内联块"，**不含**附件纪律
    expect(options.content).toContain('summarize');
    expect(options.content).not.toContain('[附件默认只读]');
    expect(options.contextPrefix).toContain('[附件默认只读]');
    expect(options.contextPrefix).toContain('brief.pdf');
    expect(options.contextPrefix).toContain('notes.txt');
    expect(options.contextPrefix).toMatch(/不要修改/);
    unmount();
  });

  it('⭐ 用户明确说"修改" ⇒ 换成"写新版本、不覆盖原件"的纪律', async () => {
    const { container, unmount } = render(
      <MaterialHarness clearImported={vi.fn()} clearFolder={vi.fn()} draft="请修改这份表格" />,
    );

    await act(async () => {
      (container.querySelector('button') as HTMLButtonElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const options = mocks.send.mock.calls[0]![1] as { content: string; contextPrefix: string };
    expect(options.contextPrefix).toContain('[附件改动规则]');
    expect(options.contextPrefix).toMatch(/不要覆盖/);
    expect(options.contextPrefix).not.toContain('[附件默认只读]');
    unmount();
  });

  it('没有附件 ⇒ 不加任何附件纪律（不给纯聊天加开销）', async () => {
    const { container, unmount } = render(
      <MaterialHarness clearImported={vi.fn()} clearFolder={vi.fn()} importedMaterials={[]} folderMaterials={[]} />,
    );

    await act(async () => {
      (container.querySelector('button') as HTMLButtonElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const options = mocks.send.mock.calls[0]![1] as { contextPrefix?: string };
    expect(options.contextPrefix ?? '').not.toContain('[附件默认只读]');
    expect(options.contextPrefix ?? '').not.toContain('[附件改动规则]');
    unmount();
  });

  /**
   * ⭐ 2026-10-07（质量战役区 2 · 方案 A）计数分桶：
   *   - 计数只算**二进制附件**（暂存附件 + 已选导入材料）；
   *   - `selectedLocalFiles`（@ 授权文件夹，tier='text' 内联）**不计数**，只受 500KB 文本总约束。
   * 旧口径把二者同权计数（10 导入 + 1 文本 > 10 ⇒ 拒发），可载荷才几 KB（P1-2）。
   * 旧用例 10 导入 + 默认 1 个文本材料（=11"合并计数"）在新口径下**必须放行**。
   */
  it('⭐ 10 个导入 + 1 个文本材料不再凑数被拒（text 不计数，旧 10 合并口径的反向钉）', async () => {
    const importedMaterials = Array.from({ length: 10 }, (_, index) => ({
      ...importedMaterial,
      fileName: `file-${index}.pdf`,
      localPath: `tasks/task-1/inbox/file-${index}.pdf`,
    }));
    const { container, unmount } = render(
      <MaterialHarness clearImported={vi.fn()} clearFolder={vi.fn()} importedMaterials={importedMaterials} />,
    );
    await act(async () => {
      (container.querySelector('button') as HTMLButtonElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(window.clawwork.readInboxFileForSend).toHaveBeenCalledTimes(10);
    expect(window.clawwork.readTaskContextFileForSend).toHaveBeenCalledTimes(1);
    expect(mocks.send, '文本材料不占个数桶，10 个二进制附件 ≤ 30 ⇒ 照常发出').toHaveBeenCalledTimes(1);
    unmount();
  });

  it('⭐ 二进制附件超过 30 个 ⇒ 发送前拦住（个数桶），不读任何文件', async () => {
    const importedMaterials = Array.from({ length: 31 }, (_, index) => ({
      ...importedMaterial,
      fileName: `file-${index}.pdf`,
      localPath: `tasks/task-1/inbox/file-${index}.pdf`,
    }));
    const { container, unmount } = render(
      <MaterialHarness
        clearImported={vi.fn()}
        clearFolder={vi.fn()}
        importedMaterials={importedMaterials}
        folderMaterials={[]}
      />,
    );
    await act(async () => {
      (container.querySelector('button') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(mocks.toastError).toHaveBeenCalledWith('chatInput.materialLimitCount', expect.any(Object));
    expect(window.clawwork.readInboxFileForSend).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    unmount();
  });

  /**
   * ⭐ 2026-10-07 · P1-1：字节闸门按 **base64 折算预算**（单帧 × 3/4 − 余量，
   * 默认 25MiB→18MiB）拦；且以**主进程实测 byteLength** 为准 —— 列表元数据里的
   * `size: 1` 是陈旧值，一个都不能信。
   */
  it('⭐ 累计字节超预算（base64 折算）⇒ 读到第二个文件时拦下，不信列表元数据', async () => {
    const importedMaterials = [
      { ...importedMaterial, fileName: 'a.pdf', localPath: 'tasks/task-1/inbox/a.pdf', size: 1 },
      { ...importedMaterial, fileName: 'b.pdf', localPath: 'tasks/task-1/inbox/b.pdf', size: 1 },
    ];
    vi.mocked(window.clawwork.readInboxFileForSend).mockResolvedValue({
      ok: true,
      result: { content: 'cGRm', encoding: 'base64', byteLength: 10 * 1024 * 1024 },
    } as never);
    const { container, unmount } = render(
      <MaterialHarness
        clearImported={vi.fn()}
        clearFolder={vi.fn()}
        importedMaterials={importedMaterials}
        folderMaterials={[]}
      />,
    );
    await act(async () => {
      (container.querySelector('button') as HTMLButtonElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(window.clawwork.readInboxFileForSend).toHaveBeenCalledTimes(2);
    expect(mocks.toastError).toHaveBeenCalledWith('chatInput.materialLimitBytes', expect.any(Object));
    expect(mocks.send, '10MB+10MB > 18MiB 折算预算 ⇒ 拦下').not.toHaveBeenCalled();
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('summarize');
    unmount();
  });

  it('⭐ text tier 按**实际内联字节**记账（30MB 的 .log 只占 ~100KB，不再整份虚耗预算）', async () => {
    vi.mocked(window.clawwork.readInboxFileForSend).mockResolvedValue({
      ok: true,
      result: { content: 'cGRm', encoding: 'base64', byteLength: 10 * 1024 * 1024 },
    } as never);
    // 主进程 readContextFileForSend 的新契约（P2-1）：text tier 的 byteLength 是内联字节
    vi.mocked(window.clawwork.readTaskContextFileForSend).mockResolvedValue({
      ok: true,
      result: {
        content: 'notes',
        mimeType: 'text/plain',
        size: 30 * 1024 * 1024,
        byteLength: 102 * 1024,
        truncated: true,
        tier: 'text',
      },
    });
    const { container, unmount } = render(
      <MaterialHarness
        clearImported={vi.fn()}
        clearFolder={vi.fn()}
        importedMaterials={[{ ...importedMaterial, size: 1 }]}
      />,
    );
    await act(async () => {
      (container.querySelector('button') as HTMLButtonElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.send, '10MB(导入) + 100KB(文本内联) < 18MiB ⇒ 照常发出').toHaveBeenCalledTimes(1);
    unmount();
  });

  it('⭐ 字节预算跟随网关协商的单帧上限（gatewayMaxPayloadByGateway = 4MiB ⇒ 预算 2.25MiB）', async () => {
    mocks.uiState.gatewayMaxPayloadByGateway = { 'gw-1': 4 * 1024 * 1024 };
    vi.mocked(window.clawwork.readInboxFileForSend).mockResolvedValue({
      ok: true,
      result: { content: 'cGRm', encoding: 'base64', byteLength: 3 * 1024 * 1024 },
    } as never);
    const { container, unmount } = render(
      <MaterialHarness
        clearImported={vi.fn()}
        clearFolder={vi.fn()}
        importedMaterials={[{ ...importedMaterial, size: 1 }]}
        folderMaterials={[]}
      />,
    );
    await act(async () => {
      (container.querySelector('button') as HTMLButtonElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });
    // 3MB 在默认 18MiB 预算下本该放行；协商值 4MiB ⇒ 预算 ≈2.25MiB ⇒ 拦
    expect(mocks.toastError).toHaveBeenCalledWith('chatInput.materialLimitBytes', expect.any(Object));
    expect(mocks.send).not.toHaveBeenCalled();
    unmount();
  });

  it('locks the complete send pipeline so a double click dispatches once', async () => {
    let resolveRead!: (value: unknown) => void;
    vi.mocked(window.clawwork.readInboxFileForSend).mockReturnValueOnce(
      new Promise((resolve) => (resolveRead = resolve)) as never,
    );
    const { container, unmount } = render(<MaterialHarness clearImported={vi.fn()} clearFolder={vi.fn()} />);
    const button = container.querySelector('button') as HTMLButtonElement;
    act(() => {
      button.click();
      button.click();
    });
    await act(async () => {
      resolveRead({ ok: true, result: { content: 'cGRm', encoding: 'base64' } });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(window.clawwork.readInboxFileForSend).toHaveBeenCalledTimes(1);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('does not clear the next task draft when the originating send finishes later', async () => {
    let resolveRead!: (value: unknown) => void;
    vi.mocked(window.clawwork.readInboxFileForSend).mockReturnValueOnce(
      new Promise((resolve) => (resolveRead = resolve)) as never,
    );
    const clearImported = vi.fn();
    const clearFolder = vi.fn();
    const view = render(<MaterialHarness clearImported={clearImported} clearFolder={clearFolder} />);
    act(() => (view.container.querySelector('button') as HTMLButtonElement).click());

    const firstTask = mocks.taskState.tasks[0];
    mocks.taskState.tasks = [
      firstTask,
      { ...firstTask, id: 'task-2', sessionKey: 'agent:main:clawwork:task:task-2', title: 'Task 2' },
    ];
    mocks.taskState.activeTaskId = 'task-2';
    view.rerender(<MaterialHarness clearImported={clearImported} clearFolder={clearFolder} />);

    await act(async () => {
      resolveRead({ ok: true, result: { content: 'cGRm', encoding: 'base64' } });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.send).toHaveBeenCalledWith('task-1', expect.any(Object));
    expect(clearImported).not.toHaveBeenCalled();
    expect(clearFolder).not.toHaveBeenCalled();
    expect((view.container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('summarize');
    view.unmount();
  });

  it('allows task B to send while task A is still in flight', async () => {
    let resolveTaskA!: (value: { ok: boolean; taskId: string }) => void;
    mocks.send.mockImplementation((taskId: string) => {
      if (taskId === 'task-1') return new Promise((resolve) => (resolveTaskA = resolve));
      return Promise.resolve({ ok: true, taskId });
    });
    const view = render(<Harness initialValue="task A" />);
    act(() => (view.container.querySelectorAll('button')[1] as HTMLButtonElement).click());

    const firstTask = mocks.taskState.tasks[0];
    mocks.taskState.tasks = [
      firstTask,
      { ...firstTask, id: 'task-2', sessionKey: 'agent:main:clawwork:task:task-2', title: 'Task 2' },
    ];
    mocks.taskState.activeTaskId = 'task-2';
    view.rerender(<Harness initialValue="task B" />);
    const textarea = view.container.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = 'task B';
    await act(async () => {
      (view.container.querySelectorAll('button')[1] as HTMLButtonElement).click();
      await Promise.resolve();
    });

    expect(mocks.send.mock.calls.map((call) => call[0])).toEqual(['task-1', 'task-2']);
    await act(async () => {
      resolveTaskA({ ok: true, taskId: 'task-1' });
      await Promise.resolve();
    });
    view.unmount();
  });

  it('warns about partial ensemble delivery without treating the successful send as failed', async () => {
    mocks.send.mockResolvedValueOnce({ ok: true, taskId: 'task-1', partialFailure: 'worker offline' });
    const view = render(<Harness initialValue="team request" />);

    await act(async () => {
      (view.container.querySelectorAll('button')[1] as HTMLButtonElement).click();
      await Promise.resolve();
    });

    expect(mocks.toastWarning).toHaveBeenCalledWith(
      'chatInput.partialSendFailed',
      expect.objectContaining({ description: 'worker offline' }),
    );
    expect((view.container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('');
    view.unmount();
  });

  it('keeps the pending-task lock after commit so a rerender cannot duplicate the same send', async () => {
    const firstTask = mocks.taskState.tasks[0];
    let resolveRead!: (value: unknown) => void;
    vi.mocked(window.clawwork.readInboxFileForSend).mockReturnValueOnce(
      new Promise((resolve) => (resolveRead = resolve)) as never,
    );
    mocks.taskState.activeTaskId = null;
    mocks.taskState.pendingNewTask = { gatewayId: 'gw-1', model: 'deepseek-v4-flash' } as never;
    mocks.taskState.commitPendingTask.mockReturnValue(firstTask);
    const view = render(<MaterialHarness clearImported={vi.fn()} clearFolder={vi.fn()} />);
    act(() => (view.container.querySelector('button') as HTMLButtonElement).click());

    mocks.taskState.tasks = [firstTask];
    mocks.taskState.activeTaskId = 'task-1';
    mocks.taskState.pendingNewTask = null;
    view.rerender(<MaterialHarness clearImported={vi.fn()} clearFolder={vi.fn()} />);
    act(() => (view.container.querySelector('button') as HTMLButtonElement).click());

    await act(async () => {
      resolveRead({ ok: true, result: { content: 'cGRm', encoding: 'base64' } });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.taskState.commitPendingTask).toHaveBeenCalledTimes(1);
    expect(window.clawwork.readInboxFileForSend).toHaveBeenCalledTimes(1);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  /**
   * ⭐ 2026-09-24（独立复核 I-3）：这条分支原来**没有任何测试绑住** ——
   * 把 `describeSendRefusal` 换回固定那句「助手无响应」，整套照样全绿，而用户看到的是错话。
   *
   * 判据是**用户可见的结果**：说的是哪句话，以及"拒绝之后一个字都没发出去"。
   */
  it('⭐ 待发任务点名了一个不在本机的助手 ⇒ 说「不在本机」，且一个字都不发', async () => {
    mocks.toastError.mockClear();
    mocks.taskState.activeTaskId = null;
    mocks.taskState.pendingNewTask = { gatewayId: 'gw-1', agentId: 'team-agent-x' } as never;
    mocks.taskState.commitPendingTask.mockImplementationOnce(() => {
      throw new UnknownAgentError('team-agent-x');
    });
    const { container, unmount } = render(<Harness initialValue="你好" />);
    const sendButton = [...container.querySelectorAll('button')].find((b) => b.textContent === 'send');

    await act(async () => {
      (sendButton as HTMLButtonElement).click();
      await Promise.resolve();
    });

    // ⚠️ 断言只看**第一个参数**：toast 那层会再带一个 `{duration}` 之类的选项对象，
    //    用 `toHaveBeenCalledWith(key)` 会因为多一个参数而假红（我第一版就这么写错了）。
    expect(mocks.toastError, '只该提示一次').toHaveBeenCalledTimes(1);
    expect(mocks.toastError.mock.calls[0]?.[0], '不许压成「助手无响应」').toBe('errors.agentMissing');
    expect(mocks.send, '拒绝之后一个字都不该发出去').not.toHaveBeenCalled();
    unmount();
  });

  it('⚠️ 对照：待发任务被别的错拒掉时仍是「助手无响应」（既有行为，别顺手改）', async () => {
    mocks.toastError.mockClear();
    mocks.taskState.activeTaskId = null;
    mocks.taskState.pendingNewTask = { gatewayId: 'gw-1', agentId: 'main' } as never;
    mocks.taskState.commitPendingTask.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    const { container, unmount } = render(<Harness initialValue="你好" />);
    const sendButton = [...container.querySelectorAll('button')].find((b) => b.textContent === 'send');

    await act(async () => {
      (sendButton as HTMLButtonElement).click();
      await Promise.resolve();
    });

    expect(mocks.toastError).toHaveBeenCalledTimes(1);
    expect(mocks.toastError.mock.calls[0]?.[0]).toBe('errors.agentNotResponding');
    unmount();
  });

  /**
   * ⭐ 2026-10-07（质量战役区 3 · 用户授权代决）：**首轮产物索引已切断**。
   *
   * 原实现：新会话首轮（`pendingNewTask` 置位）自动 `listArtifacts()` 全库读取，
   * 把其它会话的文件名+标题拼成 `<artifacts-index>` 注入 `contextPrefix`。
   * 这里是"诱饵桩"回归钉（桩里返回非空产物 + pendingNewTask 置位）：
   *   ① `listArtifacts` **一次都不许被调**；② `contextPrefix` 不含 `<artifacts-index>`。
   * 模型要看见产物，只走用户显式 `@`（那条路另有测试）。
   */
  describe('首轮产物索引切断（区 3）', () => {
    beforeEach(() => {
      mocks.taskState.pendingNewTask = null;
      (window.clawwork.listArtifacts as ReturnType<typeof vi.fn>).mockClear();
    });

    it('⭐ pendingNewTask 置位 + 全库有产物 ⇒ 不读 listArtifacts、contextPrefix 无索引', async () => {
      mocks.taskState.pendingNewTask = { gatewayId: 'gw-1', agentId: 'main' } as never;
      const { container, unmount } = render(<MaterialHarness clearImported={vi.fn()} clearFolder={vi.fn()} />);

      await act(async () => {
        (container.querySelector('button') as HTMLButtonElement).click();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(window.clawwork.listArtifacts, '首轮产物索引不许再自动读取').not.toHaveBeenCalled();
      const options = mocks.send.mock.calls.at(-1)?.[1] as { contextPrefix: string };
      expect(options.contextPrefix, 'contextPrefix 里不许出现产物索引').not.toContain('<artifacts-index>');
      expect(options.contextPrefix, '前提：这一轮真的带上了隐藏上下文（否则断言是假绿）').toContain('[附件默认只读]');
      unmount();
      mocks.taskState.pendingNewTask = null;
    });
  });

  /**
   * ⭐ 2026-10-07（质量战役区 3 · 问题 4）：**只有 @ 提及、没有文字**也要能发。
   * `stripAtQuery` 会把 @ 查询串从输入框抹掉（不触发 `onInput`），于是"只剩提及选中"
   * 的输入框被判空、发送键形同虚设；这里钉的就是发送层判据已补「存在任一 @ 选择」。
   */
  describe('只有 @ 提及没有文字的发送（区 3）', () => {
    it('⭐ 输入框为空 + 有 @ 任务提及 ⇒ 照常发出（不再早退）', async () => {
      const mentioned: Task = { ...mocks.baseTask, id: 'task-2', title: 'Task 2' };
      const { container, unmount } = render(
        <MaterialHarness
          clearImported={vi.fn()}
          clearFolder={vi.fn()}
          importedMaterials={[]}
          folderMaterials={[]}
          taskMentions={[mentioned]}
          draft=""
        />,
      );

      await act(async () => {
        (container.querySelector('button') as HTMLButtonElement).click();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mocks.send, '只有 @ 也要发得出去').toHaveBeenCalledTimes(1);
      const options = mocks.send.mock.calls.at(-1)?.[1] as { content: string };
      expect(options.content).toContain('<task-context name="Task 2" id="task-2">');
      unmount();
    });

    it('⚠️ 对照：什么都没有（无文字无任何选择）⇒ 仍然早退，不发', async () => {
      const { container, unmount } = render(
        <MaterialHarness
          clearImported={vi.fn()}
          clearFolder={vi.fn()}
          importedMaterials={[]}
          folderMaterials={[]}
          draft=""
        />,
      );

      await act(async () => {
        (container.querySelector('button') as HTMLButtonElement).click();
        await Promise.resolve();
      });

      expect(mocks.send).not.toHaveBeenCalled();
      unmount();
    });
  });

  /**
   * ⭐ 2026-10-07（质量战役区 3 · 问题 8）：conductor 花名册的**助手描述**曾恒空 ——
   * `agents.files.get` 的真机载荷是 `{ agentId, workspace, file: { name, content, missing } }`，
   * 旧代码读 `result.content` 恒 undefined。这里钉"描述真的进了花名册字符串"。
   */
  describe('conductor 花名册带助手描述（区 3）', () => {
    it('⭐ 从 file.content 取描述（字段错位回归钉）', async () => {
      mocks.taskState.tasks = [{ ...mocks.baseTask, ensemble: true, teamId: undefined }];
      mocks.uiState.agentCatalogByGateway = {
        'gw-1': {
          agents: [
            { id: 'main', name: '主罗盘' },
            { id: 'a1', name: '分析' },
          ],
          defaultId: 'main',
        },
      };
      const { container, unmount } = render(
        <MaterialHarness clearImported={vi.fn()} clearFolder={vi.fn()} importedMaterials={[]} folderMaterials={[]} />,
      );

      await act(async () => {
        (container.querySelector('button') as HTMLButtonElement).click();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(window.clawwork.getAgentFile).toHaveBeenCalled();
      expect(mocks.roomState.initConductor, '合议路由要走 conductor 初始化').toHaveBeenCalledTimes(1);
      const catalogStr = mocks.roomState.initConductor.mock.calls[0]![3] as string;
      expect(catalogStr, '助手描述不许再恒空（读 result.content = 字段错位）').toContain('description: "精通数据分析"');
      unmount();
    });
  });
});

// 对比模式下的「发送」不是发一条消息，而是同一句话并发问 N 个模型。
// 这段分支以前**一条测试都没有**（把它整段注释掉，全量套件照样全绿）——
// 于是"对比按钮按下去什么都没发生"这种最要命的故障，恰恰是测试看不见的那种。
describe('对比模式下的发送', () => {
  /** 网关边界上的调用（真行为在**这里**看：N 条会话、各自钉模型、各发一次）。 */
  const gateway = {
    // 参数列表照真实 IPC 的形状写出来（只写 `vi.fn(async () => …)` 的话 calls 的元素类型是
    // 空元组，断言里取 `c[0]`/`c[1]` 通不过 tsc）。
    createSession: vi.fn(async (_gatewayId: string, _params: { key: string; agentId: string }) => ({ ok: true })),
    patchSession: vi.fn(async (_gatewayId: string, _sessionKey: string, _patch: Record<string, unknown>) => ({
      ok: true,
    })),
    sendMessage: vi.fn(async (_gatewayId: string, _sessionKey: string, _content: string) => ({ ok: true })),
    abortChat: vi.fn(async () => ({ ok: true })),
    deleteSession: vi.fn(async () => ({ ok: true })),
    chatHistory: vi.fn(async () => ({ ok: true, result: { messages: [] } })),
  };

  async function flush(rounds = 12): Promise<void> {
    for (let i = 0; i < rounds; i++)
      await act(async () => {
        await Promise.resolve();
      });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
    mocks.send.mockClear();
    mocks.toastWarning.mockClear();
    mocks.toastError.mockClear();
    for (const fn of Object.values(gateway)) fn.mockClear();
    mocks.taskState.activeTaskId = 'task-1';
    mocks.taskState.tasks = [{ ...mocks.baseTask }];
    Object.assign(window, {
      clawwork: {
        getConfig: vi.fn(async () => ({
          ok: true,
          result: { config: { models: { providers: { clawrouter: { models: [] } } } } },
        })),
        readInboxFileForSend: vi.fn(async () => ({
          ok: true,
          result: { content: 'cGRm', encoding: 'base64', byteLength: 3 },
        })),
        readTaskContextFileForSend: vi.fn(async () => ({
          ok: true,
          result: { content: 'notes', mimeType: 'text/plain', size: 5, byteLength: 5, truncated: false, tier: 'text' },
        })),
        ...gateway,
      },
    });
    mocks.uiState.gatewayStatusMap = { 'gw-1': 'connected' };
    mocks.uiState.modelCatalogByGateway = {};
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
        fetchedAt: '2026-09-15T00:00:00.000Z',
      },
    });
    compareStore().setState({
      active: null,
      mode: true,
      draftModels: ['qwen-plus', 'glm-4.7'],
      draftSeeded: true,
      adoptingKey: null,
      ephemeralKeys: new Set<string>(),
      abortedKeys: new Set<string>(),
      error: null,
    });
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** 两个 harness 的按钮数量不一样，按文案找那个「发送」（别按序号）。 */
  function clickSend(target: HTMLElement): void {
    const button = [...target.querySelectorAll('button')].find((el) => el.textContent === 'send');
    act(() => {
      button!.click();
    });
  }

  it('一句话并发问 N 个模型：N 条会话各自钉模型、各发一次，输入框清空', async () => {
    const { container } = render(<Harness initialValue="对比一下" />);
    clickSend(container);
    await flush();

    const state = compareStore().getState();
    expect(state.active?.columns).toHaveLength(2);
    const keys = state.active!.columns.map((c) => c.sessionKey);

    expect(gateway.createSession).toHaveBeenCalledTimes(2);
    expect(gateway.createSession.mock.calls.map((c) => c[0])).toEqual(['gw-1', 'gw-1']);
    // 模型是**会话级**的：不逐列钉死的话，N 路跑的是同一个默认模型（"对比"变成复读）
    expect(gateway.patchSession.mock.calls.map((c) => c[2])).toEqual([{ model: 'qwen-plus' }, { model: 'glm-4.7' }]);
    expect(gateway.sendMessage).toHaveBeenCalledTimes(2);
    expect(gateway.sendMessage.mock.calls.map((c) => c[1])).toEqual(keys);
    expect(gateway.sendMessage.mock.calls.map((c) => c[2])).toEqual(['对比一下', '对比一下']);

    // 不能落进单模型那条 composer.send（那只会发成"一个模型的一条"，用户以为在对比）
    expect(mocks.send).not.toHaveBeenCalled();
    // 发出去之后输入框要清掉（用户看得见"这一句已经发出去了"）
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('');
  });

  it('团队任务即使残留在 compare 模式也走单 Agent 直发并注入四阶段合同', async () => {
    mocks.taskState.tasks = [{ ...mocks.baseTask, teamId: 'team-design', ensemble: false }];
    const { container } = render(<Harness initialValue="设计一张发布海报" />);
    clickSend(container);
    await flush();

    expect(gateway.createSession).not.toHaveBeenCalled();
    expect(gateway.sendMessage).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        content: '设计一张发布海报',
        contextPrefix: expect.stringMatching(/策略[\s\S]*创作[\s\S]*质检[\s\S]*修订[\s\S]*交付/),
      }),
    );
  });

  it('带附件/引用时不发：只提示一句，**一个网关调用都不发**', async () => {
    const view = render(<MaterialHarness clearImported={vi.fn()} clearFolder={vi.fn()} />);
    clickSend(view.container);
    await flush();

    expect(mocks.toastError).toHaveBeenCalledTimes(1);
    expect(String(mocks.toastError.mock.calls[0][0])).toContain('compare.materialsUnsupported');
    // 静默丢弃是被禁止的：要么真发出去 N 份、要么拦住并说清楚 —— 但绝不能一边说
    // "不支持"一边把 N 路请求打出去（那是用户看不见的 N 份钱）。
    expect(gateway.createSession).not.toHaveBeenCalled();
    expect(gateway.sendMessage).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    // 草稿与材料都留着（用户要能把附件去掉再发，不该重打一遍字）
    expect((view.container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('summarize');
    expect(compareStore().getState().active).toBeNull();
  });

  it('闸门带任务身份：别的任务在跑对比，不妨碍**这个任务**发消息', async () => {
    // 任务 A（task-1）里先跑起一轮对比
    compareStore().getState().start({ taskId: 'task-1', gatewayId: 'gw-1', agentId: 'main', prompt: '第一轮' });
    await flush();
    const firstRoundKeys = compareStore()
      .getState()
      .active!.columns.map((c) => c.sessionKey);
    expect(firstRoundKeys).toHaveLength(2);
    for (const fn of Object.values(gateway)) fn.mockClear();

    // 用户切到任务 B（task-2）再发一句话
    const taskB = {
      ...mocks.taskState.tasks[0],
      id: 'task-2',
      sessionKey: 'agent:main:clawwork:task:task-2',
      title: 'Task 2',
    };
    mocks.taskState.tasks = [mocks.taskState.tasks[0], taskB];
    mocks.taskState.activeTaskId = 'task-2';

    const { container } = render(<Harness initialValue="B 里的一句话" />);
    clickSend(container);
    await flush();

    // 任务 B 真的发出去了（不是"上一轮对比还在跑"）
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(gateway.sendMessage).toHaveBeenCalledTimes(2);
    expect(gateway.sendMessage.mock.calls.every((c) => String(c[1]).includes('task-2'))).toBe(true);
    // 上一轮属于任务 A，被这一轮顶掉并收拾干净（它的会话不会变成没人管的孤儿）
    expect(compareStore().getState().active?.taskId).toBe('task-2');
    for (const key of firstRoundKeys) {
      expect(compareStore().getState().wasAbortedByUser(key)).toBe(true);
    }
  });
});

/**
 * 输入框那一格的**分档输入**——用真身 hook，不用桩。
 *
 * 为什么单独钉：`chat-send-stability.test.tsx` 里 `useChatSend` 是**整块桩**，它算得对不对
 * 没人管；而「预热期（这次运行从没连上过）说"正在启动"，连上过又掉了才说"离线只读"」
 * 这条判断的**输入**正是这里产出的 `{ isOffline, gatewayDisplayPhase }`。
 * 变异 M7（把 `gatewayEverConnected` 读成"有网关就算连上过"）在原测试网下**全绿** ——
 * 就是这条缝当时没人钉（2026-09-20 变异验证打出来的；桩测试绿 ≠ 缝对上了）。
 */
describe('网关分档接进输入框之前：真身 useChatSend 读出来的那两个值', () => {
  function GatewayCopyHarness() {
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const chat = useChatSend({
      textareaRef,
      pendingAttachments: [],
      setPendingAttachments: vi.fn(),
      selectedTasks: [],
      setSelectedTasks: vi.fn(),
      selectedArtifacts: [],
      setSelectedArtifacts: vi.fn(),
      selectedLocalFiles: [],
      setSelectedLocalFiles: vi.fn(),
      selectedImportedFiles: [],
      clearSelectedImportedFiles: vi.fn(),
      markImportedFileMissing: vi.fn(),
      selectedAgents: [],
      setSelectedAgents: vi.fn(),
      stopVoiceInput: vi.fn(),
    });
    return (
      <>
        <textarea ref={textareaRef} />
        <div data-testid="phase">{chat.gatewayDisplayPhase}</div>
        <div data-testid="offline">{chat.isOffline ? 'offline' : 'online'}</div>
      </>
    );
  }

  beforeEach(() => {
    document.body.innerHTML = '';
    mocks.taskState.tasks = [mocks.taskState.tasks.find((task) => task.id === 'task-1')!];
    mocks.taskState.activeTaskId = 'task-1';
    mocks.uiState.modelCatalogByGateway = {};
    mocks.uiState.gatewayStatusMap = { 'gw-1': 'connected' };
    mocks.uiState.gatewayReconnectInfo = {};
    mocks.uiState.gatewayEverConnected = {};
    Object.assign(window, {
      clawwork: {
        getConfig: vi.fn(async () => ({
          ok: true,
          result: { config: { models: { providers: { clawrouter: { models: [] } } } } },
        })),
      },
    });
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  it('⭐ 从没连上过（预热期）⇒ starting + offline；连上过又掉了 ⇒ retrying —— 两次读数必须不同', () => {
    mocks.uiState.gatewayStatusMap = { 'gw-1': 'disconnected' };
    mocks.uiState.gatewayReconnectInfo = { 'gw-1': { attempt: 0, max: 10, gaveUp: false } };
    mocks.uiState.gatewayEverConnected = {};

    const view = render(<GatewayCopyHarness />);
    const read = () => ({
      phase: view.container.querySelector('[data-testid="phase"]')?.textContent,
      offline: view.container.querySelector('[data-testid="offline"]')?.textContent,
    });

    // 实机那一刻的形状：当前状态已经是 `disconnected`（真有过一次连接错误），
    // 但历史是"从没连上过"—— 那正说明还在启动窗口里。
    expect(read()).toEqual({ phase: 'starting', offline: 'offline' });

    // 只改"这次运行连上过没有"，读数必须跟着换（否则这两个值根本没接上 store）
    mocks.uiState.gatewayEverConnected = { 'gw-1': true };
    view.rerender(<GatewayCopyHarness />);
    expect(read()).toEqual({ phase: 'retrying', offline: 'offline' });

    // 网关明确拒绝 ⇒ 那是**结论**，哪怕从没连上过也要说失败（界面据此给出口）
    mocks.uiState.gatewayEverConnected = {};
    mocks.uiState.gatewayReconnectInfo = { 'gw-1': { attempt: 0, max: 10, gaveUp: true } };
    view.rerender(<GatewayCopyHarness />);
    expect(read()).toEqual({ phase: 'unreachable', offline: 'offline' });

    view.unmount();
  });
});

/**
 * Auto Capability Routing v1（用户交付日 P0-4）：**带图发送 × 当前模型不自述看图 ⇒ 先切到
 * 目录里能看图的模型再发**；切不动/没候选 ⇒ 阻止发送并保留草稿。
 *
 * 这里钉的是**接线**（用真身 hook）：切在发之前、切了才提示、提示带模型名。
 * 候选选择本身的判据在 `vision-routing.test.ts` 单独钉（纯函数）。
 */
describe('Auto Capability Routing：带图发送先切到能看图的模型', () => {
  const VISION_MODEL_ID = 'qwen3.7-flash';
  const CURRENT_MODEL_ID = 'deepseek-v4-flash';

  const catalogWithVision: ModelCatalogEntry[] = [
    { id: CURRENT_MODEL_ID, name: 'DeepSeek V4 Flash', provider: 'clawrouter', input: ['text'] },
    { id: 'glm-4.7', name: 'GLM 4.7', provider: 'clawrouter', input: ['text'] },
    { id: VISION_MODEL_ID, name: 'Qwen 3.7 Flash', provider: 'clawrouter', input: ['text', 'image'] },
  ];
  const catalogWithoutVision: ModelCatalogEntry[] = [
    { id: CURRENT_MODEL_ID, name: 'DeepSeek V4 Flash', provider: 'clawrouter', input: ['text'] },
    { id: 'glm-4.7', name: 'GLM 4.7', provider: 'clawrouter', input: ['text'] },
  ];

  const imageMaterial: ImportedMaterialFile = {
    taskId: 'task-1',
    fileName: 'screenshot.png',
    localPath: 'tasks/task-1/inbox/screenshot.png',
    mimeType: 'image/png',
    size: 64,
    availability: 'available',
  };

  /** @ 提及的**图片产物**（二进制读取、走 extraAttachments）。 */
  const imageArtifact: Artifact = {
    id: 'art-img-1',
    taskId: 'task-1',
    messageId: 'm-1',
    type: 'image',
    name: '预览图.png',
    filePath: 'tasks/task-1/artifacts/预览图.png',
    localPath: 'tasks/task-1/artifacts/预览图.png',
    mimeType: 'image/png',
    size: 6,
    createdAt: '2026-10-15T00:00:00.000Z',
    availability: 'available',
  };

  /** 网关边界上的调用：真正的"切模型"要看这里（composer 是桩，它自己的钉在 core 里）。 */
  const gateway = {
    patchSession: vi.fn(async (_gatewayId: string, _sessionKey: string, _patch: Record<string, unknown>) => ({
      ok: true,
    })),
    saveInboxAttachment: vi.fn(async (_params: { taskId: string; fileName: string; base64: string }) => ({
      ok: true,
      result: { localPath: 'tasks/task-1/inbox/pasted.png' },
    })),
  };

  function VisionRoutingHarness({
    imported = [] as ImportedMaterialFile[],
    pending = [] as PendingAttachment[],
    artifacts = [] as Artifact[],
    draft = '看看这张图',
  }: {
    imported?: ImportedMaterialFile[];
    pending?: PendingAttachment[];
    artifacts?: Artifact[];
    draft?: string;
  }) {
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const chat = useChatSend({
      textareaRef,
      pendingAttachments: pending,
      setPendingAttachments: vi.fn(),
      selectedTasks: [],
      setSelectedTasks: vi.fn(),
      selectedArtifacts: artifacts,
      setSelectedArtifacts: vi.fn(),
      selectedLocalFiles: [],
      setSelectedLocalFiles: vi.fn(),
      selectedImportedFiles: imported,
      clearSelectedImportedFiles: vi.fn(),
      markImportedFileMissing: vi.fn(),
      selectedAgents: [],
      setSelectedAgents: vi.fn(),
      stopVoiceInput: vi.fn(),
    });
    return (
      <>
        <textarea ref={textareaRef} defaultValue={draft} />
        <button type="button" onClick={() => void chat.handleSend()}>
          send
        </button>
      </>
    );
  }

  /** 点发送，并把发送链上的异步（材料读取/FileReader/模型切换）跑干净。 */
  async function clickSend(container: HTMLElement): Promise<void> {
    await act(async () => {
      container.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    // 暂存附件那条路要过 FileReader（jsdom 按宏任务派发 load 事件）——真实定时器下让出几轮。
    for (let i = 0; i < 20 && mocks.send.mock.calls.length === 0; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  const sendOptions = (): Record<string, unknown> | undefined => mocks.send.mock.calls[0]?.[1];

  beforeEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
    mocks.send.mockClear();
    mocks.toastWarning.mockClear();
    mocks.toastError.mockClear();
    mocks.toastInfo.mockClear();
    mocks.t.mockClear();
    mocks.taskState.updateTaskMetadata.mockClear();
    mocks.meetingState.records = [];
    mocks.taskState.activeTaskId = 'task-1';
    mocks.taskState.tasks = [{ ...mocks.baseTask, mode: 'smart' }];
    for (const fn of Object.values(gateway)) fn.mockClear();
    Object.assign(window, {
      clawwork: {
        getConfig: vi.fn(async () => ({
          ok: true,
          result: { config: { models: { providers: { clawrouter: { models: [] } } } } },
        })),
        readInboxFileForSend: vi.fn(async () => ({
          ok: true,
          result: { content: 'cG5n', encoding: 'base64', byteLength: 3 },
        })),
        readTaskContextFileForSend: vi.fn(async () => ({
          ok: true,
          result: { content: 'notes', mimeType: 'text/plain', size: 5, byteLength: 5, truncated: false, tier: 'text' },
        })),
        // MM-A 加固（2026-10-15）：@ 引用的**图片产物**也要过视觉门禁（见本 describe
        // 末尾的两条用例）。默认返回二进制读结果；具体用例可覆写。
        readArtifactFile: vi.fn(async () => ({
          ok: true,
          result: { content: 'aW1hZ2U=', encoding: 'base64', byteLength: 6 },
        })),
        ...gateway,
      },
    });
    mocks.uiState.gatewayStatusMap = { 'gw-1': 'connected' };
    mocks.uiState.modelCatalogByGateway = {};
    mocks.uiState.modelCatalogFailureByGateway = {};
    mocks.uiState.agentCatalogByGateway = {};
    mocks.uiState.toolsCatalogByGateway = {};
    mocks.uiState.effectiveToolsByGateway = {};
    mocks.uiState.gatewayMaxPayloadByGateway = {};
    mocks.roomState.rooms = {};
    mocks.teamState.teams = {};
    // ⚠️ compareStore 是**模块级单例**：上一个 describe（对比模式）把 mode 置成 true 后不复原，
    //    不复位的话这里的"发送"会走对比分支（带材料直接被材料闸门拦下、send 永不发生）。
    compareStore().setState({ active: null, mode: false, error: null });
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
        fetchedAt: '2026-09-15T00:00:00.000Z',
      },
    });
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  it('models.list视觉声明不能覆盖最终静态text，无有效备选时不发图片', async () => {
    mocks.taskState.tasks = [{ ...mocks.baseTask, mode: 'smart', model: VISION_MODEL_ID }];
    mocks.uiState.modelCatalogByGateway = { 'gw-1': catalogWithVision };
    vi.mocked(window.clawwork.getConfig).mockResolvedValue({
      ok: true,
      result: {
        config: { models: { providers: { clawrouter: { models: [{ id: VISION_MODEL_ID, input: ['text'] }] } } } },
      },
    } as never);
    const { container, unmount } = render(<VisionRoutingHarness imported={[imageMaterial]} />);
    await clickSend(container);
    expect(mocks.send).not.toHaveBeenCalled();
    expect(gateway.patchSession).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith('chatInput.visionUnavailable', { duration: 10000 });
    unmount();
  });

  it('最终静态配置不可回读时保留草稿，不收费试发图片', async () => {
    mocks.uiState.modelCatalogByGateway = { 'gw-1': catalogWithVision };
    vi.mocked(window.clawwork.getConfig).mockRejectedValue(new Error('fixture transport failure'));
    const { container, unmount } = render(<VisionRoutingHarness imported={[imageMaterial]} />);
    await clickSend(container);
    expect(mocks.send).not.toHaveBeenCalled();
    expect(gateway.patchSession).not.toHaveBeenCalled();
    expect(container.querySelector('textarea')?.value).toBe('看看这张图');
    expect(mocks.toastError).toHaveBeenCalledWith('chatInput.visionUnavailable', { duration: 10000 });
    unmount();
  });

  it('custom显式选择不识图模型时不切换、不发送', async () => {
    mocks.taskState.tasks = [{ ...mocks.baseTask, mode: 'custom' }];
    mocks.uiState.modelCatalogByGateway = { 'gw-1': catalogWithVision };
    const { container, unmount } = render(<VisionRoutingHarness imported={[imageMaterial]} />);
    await clickSend(container);
    expect(gateway.patchSession).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith('chatInput.visionUnavailable', { duration: 10000 });
    unmount();
  });

  it.each(['fast', 'smart', 'deep'] as const)('MM-A最终模式模型视觉门禁 %s，多图字节不变', async (mode) => {
    mocks.taskState.tasks = [{ ...mocks.baseTask, mode, model: VISION_MODEL_ID }];
    mocks.uiState.modelCatalogByGateway = {
      'gw-1': [...catalogWithVision, { id: 'glm-5.3-flash', provider: 'clawrouter', input: ['text'] }],
    };
    const { container, unmount } = render(
      <VisionRoutingHarness
        imported={[
          imageMaterial,
          { ...imageMaterial, fileName: 'other.png', localPath: 'tasks/task-1/inbox/other.png' },
        ]}
      />,
    );
    await clickSend(container);
    expect(sendOptions()?.presetModel).toBe(VISION_MODEL_ID);
    expect(sendOptions()?.attachments).toEqual([
      { fileName: 'screenshot.png', mimeType: 'image/png', content: 'cG5n' },
      { fileName: 'other.png', mimeType: 'image/png', content: 'cG5n' },
    ]);
    unmount();
  });

  it('PPT最终制作模型不支持视觉时阻止发送，不丢图也不劫持制作模型', async () => {
    mocks.taskState.tasks = [{ ...mocks.baseTask, mode: 'smart', model: VISION_MODEL_ID }];
    mocks.uiState.modelCatalogByGateway = {
      'gw-1': [...catalogWithVision, { id: 'deepseek-v4-flash-cephalon', provider: 'clawrouter', input: ['text'] }],
    };
    const { container, unmount } = render(
      <VisionRoutingHarness imported={[imageMaterial]} draft="根据这张图制作PPT" />,
    );
    await clickSend(container);
    expect(gateway.patchSession).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith('chatInput.visionUnavailable', { duration: 10000 });
    unmount();
  });

  it('⭐ 带图 × 当前模型不看图 × 有候选 ⇒ 切到候选（先切后发）并给一条轻量提示', async () => {
    mocks.uiState.modelCatalogByGateway = { 'gw-1': catalogWithVision };
    const { container, unmount } = render(<VisionRoutingHarness imported={[imageMaterial]} />);

    await clickSend(container);

    expect(gateway.patchSession).toHaveBeenCalledWith('gw-1', mocks.baseTask.sessionKey, { model: VISION_MODEL_ID });
    expect(mocks.send).toHaveBeenCalledOnce();
    // 发送时钉的必须是**候选模型** —— 图片就是发给它的（composer 的 presetModel 等价于 patchSession）
    expect(sendOptions()?.presetModel).toBe(VISION_MODEL_ID);
    // 「先切后发」是结构保证：patchSession 的调用顺序早于 composer.send
    expect(gateway.patchSession.mock.invocationCallOrder[0]!).toBeLessThan(mocks.send.mock.invocationCallOrder[0]!);
    // 选择器要跟着显示新模型（任务级元数据与真实会话对齐）
    expect(mocks.taskState.updateTaskMetadata).toHaveBeenCalledWith('task-1', {
      model: VISION_MODEL_ID,
      modelProvider: 'clawrouter',
    });
    expect(mocks.toastInfo).toHaveBeenCalledWith('chatInput.visionFallbackSwitched');
    expect(mocks.t).toHaveBeenCalledWith('chatInput.visionFallbackSwitched', { model: 'Qwen 3.7 Flash' });

    unmount();
  });

  it('拖入/粘贴的暂存图片同样触发（主入口）', async () => {
    mocks.uiState.modelCatalogByGateway = { 'gw-1': catalogWithVision };
    const pending: PendingAttachment[] = [
      { file: new File(['png'], 'pasted.png', { type: 'image/png' }), previewUrl: 'blob:pasted' },
    ];
    const { container, unmount } = render(<VisionRoutingHarness pending={pending} />);

    await clickSend(container);

    expect(gateway.saveInboxAttachment).toHaveBeenCalledOnce();
    expect(gateway.patchSession).toHaveBeenCalledWith('gw-1', mocks.baseTask.sessionKey, { model: VISION_MODEL_ID });
    expect(sendOptions()?.presetModel).toBe(VISION_MODEL_ID);
    expect(mocks.t).toHaveBeenCalledWith('chatInput.visionFallbackSwitched', { model: 'Qwen 3.7 Flash' });

    unmount();
  });

  it('当前模型没报名看图（unknown）也要路由 —— 没声明 ≠ 不支持', async () => {
    mocks.uiState.modelCatalogByGateway = {
      'gw-1': [
        { id: CURRENT_MODEL_ID, name: 'DeepSeek V4 Flash', provider: 'clawrouter' },
        { id: VISION_MODEL_ID, name: 'Qwen 3.7 Flash', provider: 'clawrouter', input: ['text', 'image'] },
      ],
    };
    const { container, unmount } = render(<VisionRoutingHarness imported={[imageMaterial]} />);

    await clickSend(container);

    expect(sendOptions()?.presetModel).toBe(VISION_MODEL_ID);
    expect(mocks.toastInfo).toHaveBeenCalledOnce();

    unmount();
  });

  it('当前模型已自述支持看图 ⇒ 原样发送（不碰模型选择、不提示）', async () => {
    mocks.taskState.tasks = [{ ...mocks.baseTask, model: VISION_MODEL_ID }];
    mocks.uiState.modelCatalogByGateway = { 'gw-1': catalogWithVision };
    const { container, unmount } = render(<VisionRoutingHarness imported={[imageMaterial]} />);

    await clickSend(container);

    expect(gateway.patchSession).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenCalledOnce();
    expect(sendOptions()?.presetModel).toBe(VISION_MODEL_ID);
    expect(mocks.toastInfo).not.toHaveBeenCalled();

    unmount();
  });

  it('不带图（纯文本）⇒ 不路由（哪怕目录里有能看图的候选）', async () => {
    mocks.uiState.modelCatalogByGateway = { 'gw-1': catalogWithVision };
    const { container, unmount } = render(<VisionRoutingHarness draft="帮我写个周报" />);

    await clickSend(container);

    expect(gateway.patchSession).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenCalledOnce();
    expect(sendOptions()?.presetModel).toBe(CURRENT_MODEL_ID);
    expect(mocks.toastInfo).not.toHaveBeenCalled();

    unmount();
  });

  it('目录里没有视觉模型时阻止发送并保留草稿', async () => {
    mocks.uiState.modelCatalogByGateway = { 'gw-1': catalogWithoutVision };
    const { container, unmount } = render(<VisionRoutingHarness imported={[imageMaterial]} />);

    await clickSend(container);

    expect(gateway.patchSession).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(container.querySelector('textarea')?.value).toBe('看看这张图');
    // MM-A：没候选 = 这轮图片识别不了，用户有权先知道（而不是发完对着模型的困惑自查）
    expect(mocks.toastError).toHaveBeenCalledWith('chatInput.visionUnavailable', { duration: 10000 });

    unmount();
  });

  it('视觉模型切换抛错时给可操作提示，不暴露原始transport错误', async () => {
    mocks.uiState.modelCatalogByGateway = { 'gw-1': catalogWithVision };
    gateway.patchSession.mockRejectedValueOnce(new Error('RAW_TRANSPORT_FIXTURE'));
    const { container, unmount } = render(<VisionRoutingHarness imported={[imageMaterial]} />);
    await clickSend(container);
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith('chatInput.visionUnavailable', { duration: 10000 });
    expect(JSON.stringify(mocks.toastError.mock.calls)).not.toContain('RAW_TRANSPORT_FIXTURE');
    unmount();
  });

  it('视觉切换失败时阻止发送', async () => {
    mocks.uiState.modelCatalogByGateway = { 'gw-1': catalogWithVision };
    gateway.patchSession.mockResolvedValueOnce({ ok: false });
    const { container, unmount } = render(<VisionRoutingHarness imported={[imageMaterial]} />);

    await clickSend(container);

    expect(gateway.patchSession).toHaveBeenCalledOnce();
    expect(mocks.toastInfo).not.toHaveBeenCalled();
    expect(mocks.taskState.updateTaskMetadata).not.toHaveBeenCalled();
    // 切换失败时保留附件，不派发不能识图的请求。
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith('chatInput.visionUnavailable', { duration: 10000 });

    unmount();
  });

  it('⭐ @ 引用的图片产物同样过视觉门禁：文本模型 + 目录有视觉候选 ⇒ 先切换再带图发送', async () => {
    // 缺口来源（独立核验 2026-10-15）：@ 提及的产物走 `extraAttachments`，而
    // `hasImageAttachment` 此前只数 attachedFilesForIntent ⇒ 图片产物绕过门禁、
    // 由文本模型收下后被 runtime 静默丢图。修法：图片判定并入 extraAttachments。
    mocks.taskState.tasks = [{ ...mocks.baseTask, mode: 'smart', model: CURRENT_MODEL_ID }];
    mocks.uiState.modelCatalogByGateway = { 'gw-1': catalogWithVision };
    const { container, unmount } = render(<VisionRoutingHarness artifacts={[imageArtifact]} />);

    await clickSend(container);

    expect(gateway.patchSession).toHaveBeenCalledOnce();
    expect(gateway.patchSession.mock.calls[0]?.[2]).toMatchObject({ model: VISION_MODEL_ID });
    expect(mocks.send).toHaveBeenCalledOnce();
    expect(sendOptions()?.presetModel).toBe(VISION_MODEL_ID);
    // 图片字节确实进了这轮请求（不是"切了模型但图没带上"）
    expect(sendOptions()?.attachments).toEqual(
      expect.arrayContaining([expect.objectContaining({ mimeType: 'image/png', content: 'aW1hZ2U=' })]),
    );

    unmount();
  });

  it('⭐ @ 引用的图片产物 + 目录无视觉候选 ⇒ 阻断发送、保留草稿（不静默丢图）', async () => {
    mocks.taskState.tasks = [{ ...mocks.baseTask, mode: 'smart', model: CURRENT_MODEL_ID }];
    mocks.uiState.modelCatalogByGateway = { 'gw-1': catalogWithoutVision };
    const { container, unmount } = render(<VisionRoutingHarness artifacts={[imageArtifact]} />);

    await clickSend(container);

    expect(gateway.patchSession).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(container.querySelector('textarea')?.value).toBe('看看这张图');
    expect(mocks.toastError).toHaveBeenCalledWith('chatInput.visionUnavailable', { duration: 10000 });

    unmount();
  });

  /**
   * ⭐ v1.1 加固（会话/任务维度的隔离）：**新任务不继承上一会话的 vision 切换态**。
   *
   * "切换态"落在两处，两处都是**任务作用域**的：
   *   · `patchSession(task.gatewayId, task.sessionKey, …)` —— 每个任务自己的 sessionKey；
   *   · `updateTaskMetadata(task.id, { model })` —— 每个任务自己的 meta。
   * 新任务（待发态）没选过模型 ⇒ 起点是**默认模型**，不是上一段会话被切过去的那个。
   * 这条钉的就是这个：上一段会话切过（task-1.model 已是 vision 模型）之后，
   * 新任务这一轮要**重新判**（默认模型 → 不自述看图 → 路由），且只动**新任务自己的**会话与元数据。
   * 若哪天有人把"上次切过去的模型"记成全局/待发态默认值，这条立刻红。
   */
  it('⭐ 新任务不继承上一会话的 vision 切换态：重新判、只动新任务自己的会话', async () => {
    // 上一段会话的留痕：task-1 的 meta 已被切到 vision 模型。
    mocks.taskState.tasks = [{ ...mocks.baseTask, model: VISION_MODEL_ID }];
    mocks.taskState.activeTaskId = null;
    const newTask: Task = {
      ...mocks.baseTask,
      id: 'task-2',
      sessionKey: 'agent:main:clawwork:task:task-2',
      model: undefined,
      mode: 'smart',
    };
    mocks.taskState.pendingNewTask = { gatewayId: 'gw-1', agentId: 'main', mode: 'smart' } as never;
    mocks.taskState.commitPendingTask.mockReturnValue(newTask);
    mocks.uiState.modelCatalogByGateway = { 'gw-1': catalogWithVision };
    const pending: PendingAttachment[] = [
      { file: new File(['png'], 'pasted.png', { type: 'image/png' }), previewUrl: 'blob:pasted' },
    ];
    const { container, unmount } = render(<VisionRoutingHarness pending={pending} />);

    await clickSend(container);

    // 起点是默认模型（deepseek）⇒ 这一轮重新判成"要路由"，切的是 task-2 自己的会话
    expect(gateway.patchSession).toHaveBeenCalledWith('gw-1', newTask.sessionKey, { model: VISION_MODEL_ID });
    expect(gateway.patchSession).not.toHaveBeenCalledWith('gw-1', mocks.baseTask.sessionKey, expect.anything());
    // 元数据只写新任务；上一段会话留痕原样不动
    expect(mocks.taskState.updateTaskMetadata).toHaveBeenCalledWith('task-2', {
      model: VISION_MODEL_ID,
      modelProvider: 'clawrouter',
    });
    expect(mocks.taskState.updateTaskMetadata).not.toHaveBeenCalledWith('task-1', expect.anything());
    expect(sendOptions()?.presetModel).toBe(VISION_MODEL_ID);

    unmount();
  });
});

/**
 * 任务模式（快速 / 智能 / 深度 / 高级指定模型）——**发送链**的接线。
 *
 * 判据只有一条：这一轮真正交给 composer 的 `presetModel` / `presetThinking` 是什么。
 * 三档按 `MODE_POLICY` 走（2026-10-10 Cephalon 批：三档统一 `glm-5.3-flash` +
 * low/high/max）；高级（custom）与旧任务（mode 为空）**原样保留既有行为**
 * —— 不劫持用户当年显式选过的模型，是这一批的硬要求。
 *
 * 目录解析：只认目录里真实存在的 id；解析不出来（目录没拉到 / 模型下架）⇒
 * 保持现状、**不拦截**（照发原模型 —— 发出去由上游说话，比拦住用户更诚实）。
 * 旧 Qwen 快速别名（`qwen3.7-flash-fast`）保留在目录/隐藏下拉里，但**不再被任何一档使用**。
 */
describe('任务模式：发送链的 presetModel / presetThinking', () => {
  const BASE_MODEL_ID = 'glm-5.3-flash';
  const ALIAS_MODEL_ID = 'qwen3.7-flash-fast';
  const LEGACY_MODEL_ID = 'deepseek-v4-flash';

  const catalogBase: ModelCatalogEntry[] = [
    { id: LEGACY_MODEL_ID, name: 'DeepSeek V4 Flash', provider: 'clawrouter' },
    { id: BASE_MODEL_ID, name: 'GLM 5.3 Flash', provider: 'clawrouter', input: ['text', 'image'] },
  ];
  const catalogWithAlias: ModelCatalogEntry[] = [
    ...catalogBase,
    { id: ALIAS_MODEL_ID, name: 'Qwen 3.7 Flash Fast', provider: 'clawrouter' },
  ];
  /** 目录里没有模式基础模型（目录未就绪 / 模型下架）；旧别名仍在目录里也不使用。 */
  const catalogWithoutModeModels: ModelCatalogEntry[] = [catalogBase[0]!, catalogWithAlias[2]!];

  function ModeHarness({
    draft = '帮我写一段周报',
    imported = [] as ImportedMaterialFile[],
  }: {
    draft?: string;
    imported?: ImportedMaterialFile[];
  }) {
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const chat = useChatSend({
      textareaRef,
      pendingAttachments: [],
      setPendingAttachments: vi.fn(),
      selectedTasks: [],
      setSelectedTasks: vi.fn(),
      selectedArtifacts: [],
      setSelectedArtifacts: vi.fn(),
      selectedLocalFiles: [],
      setSelectedLocalFiles: vi.fn(),
      selectedImportedFiles: imported,
      clearSelectedImportedFiles: vi.fn(),
      markImportedFileMissing: vi.fn(),
      selectedAgents: [],
      setSelectedAgents: vi.fn(),
      stopVoiceInput: vi.fn(),
    });
    return (
      <>
        <textarea ref={textareaRef} defaultValue={draft} />
        <button type="button" onClick={() => void chat.handleSend()}>
          send
        </button>
      </>
    );
  }

  const sendOptions = (): Record<string, unknown> | undefined => mocks.send.mock.calls.at(-1)?.[1];

  beforeEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
    // 一次性提示的标记在 localStorage（按 taskId 隔离）—— 用例间必须清，否则互相吞提示。
    window.localStorage.clear();
    mocks.send.mockClear();
    mocks.toastError.mockClear();
    mocks.toastInfo.mockClear();
    mocks.toastWarning.mockClear();
    mocks.taskState.updateTaskMetadata.mockClear();
    mocks.meetingState.records = [];
    mocks.taskState.activeTaskId = 'task-1';
    mocks.taskState.tasks = [{ ...mocks.baseTask }];
    mocks.uiState.gatewayStatusMap = { 'gw-1': 'connected' };
    mocks.uiState.modelCatalogByGateway = { 'gw-1': catalogBase };
    mocks.uiState.modelCatalogFailureByGateway = {};
    Object.assign(window, {
      clawwork: {
        getConfig: vi.fn(async () => ({
          ok: true,
          result: { config: { models: { providers: { clawrouter: { models: [] } } } } },
        })),
        readInboxFileForSend: vi.fn(async () => ({
          ok: true,
          result: { content: 'cGRm', encoding: 'base64', byteLength: 3 },
        })),
        readTaskContextFileForSend: vi.fn(async () => ({
          ok: true,
          result: { content: 'notes', mimeType: 'text/plain', size: 5, byteLength: 5, truncated: false, tier: 'text' },
        })),
        patchSession: vi.fn(async () => ({ ok: true })),
      },
    });
    compareStore().setState({ active: null, mode: false, error: null });
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
        fetchedAt: '2026-09-15T00:00:00.000Z',
      },
    });
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  async function clickSend(container: HTMLElement): Promise<void> {
    await act(async () => {
      container.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('⭐ 快速 ⇒ glm-5.3-flash + low（旧别名在目录里也不误用）', async () => {
    mocks.taskState.tasks = [{ ...mocks.baseTask, mode: 'fast' }];
    mocks.uiState.modelCatalogByGateway = { 'gw-1': catalogWithAlias };
    const { container, unmount } = render(<ModeHarness />);

    await clickSend(container);

    expect(sendOptions()?.presetModel).toBe(BASE_MODEL_ID);
    expect(sendOptions()?.presetThinking).toBe('low');
    unmount();
  });

  it('⭐ 目录里没有 glm ⇒ 不拦截、照发原模型（明确不再回退旧 Qwen 别名）', async () => {
    mocks.taskState.tasks = [{ ...mocks.baseTask, mode: 'fast' }];
    mocks.uiState.modelCatalogByGateway = { 'gw-1': catalogWithoutModeModels };
    const { container, unmount } = render(<ModeHarness />);

    await clickSend(container);

    expect(mocks.send, '不拦：目录说话之前不替用户做决定').toHaveBeenCalledOnce();
    expect(sendOptions()?.presetModel).toBe(LEGACY_MODEL_ID);
    unmount();
  });

  it('智能（默认）⇒ glm-5.3-flash + high', async () => {
    mocks.taskState.tasks = [{ ...mocks.baseTask, mode: 'smart' }];
    const { container, unmount } = render(<ModeHarness />);

    await clickSend(container);

    expect(sendOptions()?.presetModel).toBe(BASE_MODEL_ID);
    expect(sendOptions()?.presetThinking).toBe('high');
    unmount();
  });

  it('深度 ⇒ glm-5.3-flash + max', async () => {
    mocks.taskState.tasks = [{ ...mocks.baseTask, mode: 'deep' }];
    const { container, unmount } = render(<ModeHarness />);

    await clickSend(container);

    expect(sendOptions()?.presetModel).toBe(BASE_MODEL_ID);
    expect(sendOptions()?.presetThinking).toBe('max');
    unmount();
  });

  it('智能模式下 task.model 已下架（不在目录）⇒ 不拦发送（模式模型由目录现解析）', async () => {
    mocks.taskState.tasks = [{ ...mocks.baseTask, mode: 'smart', model: 'retired-model' }];
    const { container, unmount } = render(<ModeHarness />);

    await clickSend(container);

    expect(mocks.send, '模式任务不因"任务记着的旧模型不在了"被拦').toHaveBeenCalledOnce();
    expect(sendOptions()?.presetModel).toBe(BASE_MODEL_ID);
    expect(mocks.toastError).not.toHaveBeenCalled();
    unmount();
  });

  it('⭐ 两档模型都不在目录 ⇒ 保持现状、不拦截（照发原模型）', async () => {
    mocks.taskState.tasks = [{ ...mocks.baseTask, mode: 'deep' }];
    mocks.uiState.modelCatalogByGateway = { 'gw-1': catalogWithoutModeModels };
    const { container, unmount } = render(<ModeHarness />);

    await clickSend(container);

    expect(mocks.send, '不拦：目录说话之前不替用户做决定').toHaveBeenCalledOnce();
    expect(sendOptions()?.presetModel).toBe(LEGACY_MODEL_ID);
    unmount();
  });

  it('⭐ Cephalon 批：存量模式任务首次发送 ⇒ 一次性模型/价格提示（再发不重复）', async () => {
    // baseTask.model = 'deepseek-v4-flash'（旧商业默认）—— 存量模式任务的真实形态：
    // 用户什么都没点，下一轮就会换到新默认模型跑。
    mocks.taskState.tasks = [{ ...mocks.baseTask, mode: 'smart' }];
    const { container, unmount } = render(<ModeHarness />);

    await clickSend(container);
    expect(mocks.toastInfo, '存量任务换模型要告知一次').toHaveBeenCalledWith('chatInput.modePolicyUpdated');

    container.querySelector('textarea')!.value = '再来一轮';
    await clickSend(container);
    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect(mocks.toastInfo, '一次性：同一任务不再重复').toHaveBeenCalledTimes(1);
    unmount();
  });

  it('⭐ Cephalon 批：按当前策略创建的任务（记录 = 新默认 glm）⇒ 不提示', async () => {
    mocks.taskState.tasks = [{ ...mocks.baseTask, mode: 'smart', model: BASE_MODEL_ID }];
    const { container, unmount } = render(<ModeHarness />);

    await clickSend(container);

    expect(mocks.toastInfo, '没有变化可报 —— 不打扰').not.toHaveBeenCalled();
    unmount();
  });

  it('⭐ Cephalon 批：目录里没有 glm（模式解析不出）⇒ 不提示（没有可说的变化）', async () => {
    mocks.taskState.tasks = [{ ...mocks.baseTask, mode: 'fast' }];
    mocks.uiState.modelCatalogByGateway = { 'gw-1': catalogWithoutModeModels };
    const { container, unmount } = render(<ModeHarness />);

    await clickSend(container);

    expect(mocks.toastInfo).not.toHaveBeenCalled();
    unmount();
  });

  it('⭐ BUG-066：获取 window.localStorage 抛 SecurityError ⇒ 普通发送照发、无错误提示（提示层静默降级）', async () => {
    mocks.taskState.tasks = [{ ...mocks.baseTask, mode: 'smart' }];
    const { container, unmount } = render(<ModeHarness />);
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('synthetic storage unavailable', 'SecurityError');
      },
    });
    try {
      await clickSend(container);
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original);
    }

    expect(mocks.send, '存储不可用绝不能阻断发送').toHaveBeenCalledTimes(1);
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(mocks.toastInfo, '标记读不到 ⇒ 提示也不弹（静默降级）').not.toHaveBeenCalled();
    unmount();
  });

  it('⭐ BUG-067：presetModel 钉选被拒（composer ok:false）⇒ 不报"已切换"、标记不消费；后续成功采用仍告知', async () => {
    mocks.taskState.tasks = [{ ...mocks.baseTask, mode: 'smart' }];
    mocks.send.mockResolvedValueOnce({ ok: false });
    const { container, unmount } = render(<ModeHarness />);

    await clickSend(container);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.toastInfo, '未确认采用 —— 不许报"已切换"').not.toHaveBeenCalled();
    expect(
      window.localStorage.getItem('rongying-cube:mode-policy-notice:v1:task-1'),
      '未采用不许消费一次性标记（否则下一次真正采用时告知被吞）',
    ).toBeNull();

    // 后续真正采用（默认 mock 会像真 composer 一样更新 task.model）⇒ 仍会如实告知一次，且这次才记标记。
    container.querySelector('textarea')!.value = '再来一轮';
    await clickSend(container);
    expect(mocks.toastInfo).toHaveBeenCalledWith('chatInput.modePolicyUpdated');
    expect(window.localStorage.getItem('rongying-cube:mode-policy-notice:v1:task-1')).not.toBeNull();
    unmount();
  });

  it('⭐ BUG-067 矩阵：pin 成功＋派发返回失败（任务已采用）⇒ 仍告知一次并记标记，同时保留发送失败处理', async () => {
    mocks.taskState.tasks = [{ ...mocks.baseTask, mode: 'smart' }];
    mocks.send.mockImplementationOnce(async (taskId, options) => {
      // 模拟真实 composer：模型 patch 成功 ⇒ 先更新 task.model；随后派发失败 ⇒ ok:false。
      const presetModel = options?.presetModel as string;
      mocks.taskState.tasks = mocks.taskState.tasks.map((item) =>
        item.id === taskId ? { ...item, model: presetModel } : item,
      );
      return { ok: false, taskId };
    });
    const { container, unmount } = render(<ModeHarness />);

    await clickSend(container);

    expect(mocks.toastInfo, '模型已实际采用 —— 不能因派发失败跳过告知').toHaveBeenCalledWith(
      'chatInput.modePolicyUpdated',
    );
    expect(window.localStorage.getItem('rongying-cube:mode-policy-notice:v1:task-1')).not.toBeNull();
    // 发送失败处理保留：ok:false 时草稿不清理（不是成功态）。
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).not.toBe('');
    unmount();
  });

  it('⭐ BUG-067 矩阵：pin 成功＋派发抛异常（任务已采用）⇒ 仍告知一次并记标记；原始异常仍走原错误出口', async () => {
    mocks.taskState.tasks = [{ ...mocks.baseTask, mode: 'smart' }];
    mocks.send.mockImplementationOnce(async (taskId, options) => {
      const presetModel = options?.presetModel as string;
      mocks.taskState.tasks = mocks.taskState.tasks.map((item) =>
        item.id === taskId ? { ...item, model: presetModel } : item,
      );
      throw new Error('dispatch boom');
    });
    const { container, unmount } = render(<ModeHarness />);

    await clickSend(container);

    expect(mocks.toastInfo, '模型已实际采用 —— 异常路径同样要告知').toHaveBeenCalledWith('chatInput.modePolicyUpdated');
    expect(window.localStorage.getItem('rongying-cube:mode-policy-notice:v1:task-1')).not.toBeNull();
    // 原始异常不被提示侧覆盖：仍走原错误出口（系统消息 + error toast）。
    expect(mocks.messageState.addMessage).toHaveBeenCalledWith('task-1', 'system', 'dispatch boom');
    expect(mocks.toastError).toHaveBeenCalledWith('dispatch boom', expect.anything());
    unmount();
  });

  it('⭐ BUG-067 矩阵：ok=true 但未采用／任务已删除 ⇒ 不宣称"已切换"', async () => {
    // ① ok=true 但任务模型未被更新（没走 pin 的旁路）⇒ 不提示。
    mocks.taskState.tasks = [{ ...mocks.baseTask, mode: 'smart' }];
    mocks.send.mockResolvedValueOnce({ ok: true, taskId: 'task-1' });
    const first = render(<ModeHarness />);
    await clickSend(first.container);
    expect(mocks.toastInfo, '没采用就不许报"已切换"').not.toHaveBeenCalled();
    expect(window.localStorage.getItem('rongying-cube:mode-policy-notice:v1:task-1')).toBeNull();
    first.unmount();

    // ② 发送期间任务被删除 ⇒ 找不到记录，不提示、不标记。
    mocks.taskState.tasks = [{ ...mocks.baseTask, mode: 'smart' }];
    mocks.send.mockImplementationOnce(async () => {
      mocks.taskState.tasks = [];
      return { ok: true, taskId: 'task-1' };
    });
    const second = render(<ModeHarness />);
    await clickSend(second.container);
    expect(mocks.toastInfo).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(window.localStorage.getItem('rongying-cube:mode-policy-notice:v1:task-1')).toBeNull();
    second.unmount();
  });

  /**
   * ⭐ Cephalon 批（Task 4 验收缺口补验）：**三档 × 新旧任务的客户端最终请求捕获**。
   *
   * 计划要求"仅检查 UI 或白名单常量不够，须捕获最终出站请求"——这里在发送链的客户端
   * 末段（composer.send 载荷 + 会话 patch + 任务元数据）做全量捕获，钉住：
   * ①模型 = `glm-5.3-flash`；②有效思考档 low/high/max；③**全链不含 enable_search**。
   * 网关参数合并后的**最终上游 HTTP body** 由同批
   * `relay-mode-final-body.integration.test.ts`（实际交付运行时 + 本地 127.0.0.1 接收器）
   * 捕获，含 Qwen `enable_search=true` 正对照；两层证据合起来才是完整出站链路。
   */
  it.each([
    ['fast', 'low'],
    ['smart', 'high'],
    ['deep', 'max'],
  ] as const)('⭐ Cephalon 批：%s 档最终请求钉 glm + %s；新旧任务全链不含 enable_search', async (mode, level) => {
    for (const taskModel of [LEGACY_MODEL_ID, BASE_MODEL_ID]) {
      mocks.send.mockClear();
      mocks.taskState.updateTaskMetadata.mockClear();
      mocks.taskState.tasks = [{ ...mocks.baseTask, mode, model: taskModel }];
      const { container, unmount } = render(<ModeHarness />);

      await clickSend(container);

      expect(sendOptions()?.presetModel).toBe(BASE_MODEL_ID);
      expect(sendOptions()?.presetThinking).toBe(level);
      const wire = JSON.stringify([
        mocks.send.mock.calls,
        mocks.taskState.updateTaskMetadata.mock.calls,
        vi.mocked(window.clawwork.patchSession).mock.calls,
      ]);
      expect(wire, '最终请求不得携带 enable_search').not.toContain('enable_search');
      unmount();
    }
  });

  it('⭐ Cephalon 批：PPT 粘性任务最终请求钉新 Cephalon 渠道，且不含 enable_search', async () => {
    mocks.taskState.tasks = [{ ...mocks.baseTask, mode: 'smart', deckRouted: true }];
    mocks.uiState.modelCatalogByGateway = {
      'gw-1': [
        ...catalogBase,
        { id: 'deepseek-v4-flash-cephalon', name: 'DeepSeek V4 Flash · Cephalon', provider: 'clawrouter' },
      ],
    };
    const { container, unmount } = render(<ModeHarness draft="把标题改一下" />);

    await clickSend(container);

    expect(sendOptions()?.presetModel).toBe('deepseek-v4-flash-cephalon');
    const wire = JSON.stringify([
      mocks.send.mock.calls,
      mocks.taskState.updateTaskMetadata.mock.calls,
      vi.mocked(window.clawwork.patchSession).mock.calls,
    ]);
    expect(wire).not.toContain('enable_search');
    unmount();
  });

  it('高级（custom）⇒ 用户选的模型与档位原样带出', async () => {
    mocks.taskState.tasks = [{ ...mocks.baseTask, mode: 'custom', model: 'glm-4.7', thinkingLevel: 'xhigh' }];
    mocks.uiState.modelCatalogByGateway = {
      'gw-1': [...catalogBase, { id: 'glm-4.7', name: 'GLM 4.7', provider: 'clawrouter' }],
    };
    const { container, unmount } = render(<ModeHarness />);

    await clickSend(container);

    expect(sendOptions()?.presetModel).toBe('glm-4.7');
    expect(sendOptions()?.presetThinking).toBe('xhigh');
    unmount();
  });

  // ⚠️ 2026-10-12 真机反馈：修复思考档接线后，glm-5.3-flash 的真档位集=[low,high,max]（**不含 off**），
  //    而任务默认/留痕档是 off —— 「换模型导致档位回落」这条提示开始**每次切模式都误触发**
  //    （「已切换到 glm-5.3-flash，思考档位已重置为默认」：模型名不该露，语义也不对）。
  //    修法：模式档不参与这段回落（发送时档位由 MODE_POLICY 现算，该字段只是留痕）。
  const flashEntryWithRealLevels = {
    ...catalogBase[1]!,
    thinkingLevels: [{ id: 'low' }, { id: 'high' }, { id: 'max' }],
  } as unknown as ModelCatalogEntry;

  it('⭐ 模式档：真档位集不含 off 也不弹「已切换到模型」提示、不重置留痕档位', async () => {
    mocks.taskState.tasks = [{ ...mocks.baseTask, mode: 'smart', thinkingLevel: 'off' }];
    mocks.uiState.modelCatalogByGateway = { 'gw-1': [flashEntryWithRealLevels] };
    const { unmount } = render(<ModeHarness />);

    expect(mocks.toastInfo).not.toHaveBeenCalled();
    expect(
      mocks.t.mock.calls.some(([key]) => key === 'chatInput.thinkingResetByModel'),
      '模式档不许出现「已切换到 <模型>」文案',
    ).toBe(false);
    expect(mocks.taskState.updateTaskMetadata).not.toHaveBeenCalledWith('task-1', {
      thinkingLevel: expect.anything(),
    });
    unmount();
  });

  it('⭐ custom：换到不含 off 的模型 ⇒ 档位回落 + 告知（模型名是用户自选的，照常显示）', async () => {
    mocks.taskState.tasks = [{ ...mocks.baseTask, mode: 'custom', model: BASE_MODEL_ID, thinkingLevel: 'off' }];
    mocks.uiState.modelCatalogByGateway = { 'gw-1': [flashEntryWithRealLevels] };
    const { unmount } = render(<ModeHarness />);

    expect(mocks.taskState.updateTaskMetadata).toHaveBeenCalledWith('task-1', { thinkingLevel: 'low' });
    expect(mocks.t).toHaveBeenCalledWith('chatInput.thinkingResetByModel', { model: 'GLM 5.3 Flash' });
    unmount();
  });

  it('⭐ 旧任务（mode 为空 + 有 model）⇒ custom 语义：不劫持既有模型', async () => {
    mocks.taskState.tasks = [{ ...mocks.baseTask, model: LEGACY_MODEL_ID, thinkingLevel: 'low' }];
    // 目录里 qwen 在，但旧任务仍然跑它自己记的模型
    const { container, unmount } = render(<ModeHarness />);

    await clickSend(container);

    expect(sendOptions()?.presetModel).toBe(LEGACY_MODEL_ID);
    expect(sendOptions()?.presetThinking).toBe('low');
    unmount();
  });

  it('⭐ 斜杠 `/model <id>`（用户显式指定模型）⇒ 模式落 custom（否则下一轮会被模式覆盖回去）', async () => {
    mocks.taskState.tasks = [{ ...mocks.baseTask, mode: 'smart' }];
    mocks.uiState.modelCatalogByGateway = {
      'gw-1': [...catalogBase, { id: 'glm-4.7', name: 'GLM 4.7', provider: 'clawrouter' }],
    };
    const { container, unmount } = render(<ModeHarness draft="/model glm-4.7" />);

    await clickSend(container);

    expect(mocks.applySlashCommand, '命令走本地通路（不发消息）').toHaveBeenCalledWith('task-1', 'model', 'glm-4.7');
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.taskState.updateTaskMetadata).toHaveBeenCalledWith('task-1', { mode: 'custom' });
    unmount();
  });

  it('MM-A模式任务按最终模型视觉能力切换', async () => {
    mocks.taskState.tasks = [{ ...mocks.baseTask, mode: 'smart' }];
    mocks.uiState.modelCatalogByGateway = {
      'gw-1': [
        { id: LEGACY_MODEL_ID, name: 'DeepSeek V4 Flash', provider: 'clawrouter', input: ['text'] },
        // 模式基础模型不支持图片，最终请求应切到声明支持视觉的候选。
        { id: BASE_MODEL_ID, name: 'GLM 5.3 Flash', provider: 'clawrouter', input: ['text'] },
        { id: 'glm-4.7', name: 'GLM 4.7', provider: 'clawrouter', input: ['text', 'image'] },
      ],
    };
    vi.mocked(window.clawwork.readInboxFileForSend).mockResolvedValue({
      ok: true,
      result: { content: 'cG5n', encoding: 'base64', byteLength: 3 },
    } as never);
    const imageMaterial: ImportedMaterialFile = {
      taskId: 'task-1',
      fileName: 'screenshot.png',
      localPath: 'tasks/task-1/inbox/screenshot.png',
      mimeType: 'image/png',
      size: 64,
      availability: 'available',
    };
    const { container, unmount } = render(<ModeHarness imported={[imageMaterial]} draft="看看这张图" />);

    await clickSend(container);

    expect(window.clawwork.patchSession).toHaveBeenCalled();
    // 视觉切换成功后按实际候选提示，不冒报原模式模型。
    expect(mocks.toastInfo).toHaveBeenCalledWith('chatInput.visionFallbackSwitched');
    expect(sendOptions()?.presetModel).toBe('glm-4.7');
    unmount();
  });
});

/**
 * Deck 意图路由（2026-10-08 拍板）：演示类任务统一钉 **DeepSeek 新 Cephalon 渠道**
 * （`deepseek-v4-flash-cephalon`，2026-10-10 迁移）—— 模式任务的**内部路由**。
 *
 * 真机实证：PPT 生成/改稿链在 qwen 上 20 分钟不收敛，DeepSeek 2.6 分钟出 9 页合格成品；
 * 瓶颈是输出稳定性，与速度档无关 ⇒ 三档都路由。模式芯片仍显示用户选的那一档。
 *
 * 判据本身在 `lib/deck-intent.ts`（纯函数，单独钉 35 例）；这里只钉**接线**：
 *   · 三档命中 ⇒ 换成目录里的**新渠道** id（旧 deepseek-v4-flash 保持可选但不再被路由）；
 *   · 第一条命中 ⇒ 任务记 `deckRouted`（粘性：改稿那类不含名词的后续消息继续走）；
 *   · `custom`（用户显式选的模型）永不被覆盖；
 *   · 目录里没有新渠道 ⇒ 原样放行（不拦截、不报错）；
 *   · 只认**用户手打的字**，附件名/文件正文不算。
 */
describe('Deck 意图路由：演示类任务钉新 Cephalon 渠道 DeepSeek（模式任务的内部路由）', () => {
  const BASE_MODEL_ID = 'glm-5.3-flash';
  const ALIAS_MODEL_ID = 'qwen3.7-flash-fast';
  const OTHER_MODEL_ID = 'qwen3.5-27b';
  /** 目录里的真实写法带命名空间 —— 钉"原样交给 composer"，不自己拼前缀。 */
  const DECK_MODEL_ID = 'clawrouter/deepseek-v4-flash-cephalon';
  const DECK_DRAFT = '帮我做一份 PPT，讲第三季度的数据';

  const catalogWithDeck: ModelCatalogEntry[] = [
    { id: BASE_MODEL_ID, name: 'GLM 5.3 Flash', provider: 'clawrouter' },
    { id: ALIAS_MODEL_ID, name: 'Qwen 3.7 Flash Fast', provider: 'clawrouter' },
    { id: OTHER_MODEL_ID, name: 'Qwen 3.5 27B', provider: 'clawrouter' },
    // 新旧两条 DeepSeek 渠道**并存**（旧渠道保持可选）—— 路由必须精确命中新渠道。
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', provider: 'clawrouter' },
    { id: DECK_MODEL_ID, name: 'DeepSeek V4 Flash · Cephalon', provider: 'clawrouter' },
  ];
  /** 目录里**只有旧渠道**、没有新 Cephalon 渠道（还没拉到 / 下架）——路由不得悄悄回退旧渠道。 */
  const catalogWithoutDeck: ModelCatalogEntry[] = [
    { id: BASE_MODEL_ID, name: 'GLM 5.3 Flash', provider: 'clawrouter' },
    { id: ALIAS_MODEL_ID, name: 'Qwen 3.7 Flash Fast', provider: 'clawrouter' },
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', provider: 'clawrouter' },
  ];

  const sendOptions = (): Record<string, unknown> | undefined => mocks.send.mock.calls.at(-1)?.[1];
  const deckRoutedWrites = (): unknown[] =>
    mocks.taskState.updateTaskMetadata.mock.calls.filter(
      (call) => (call[1] as { deckRouted?: boolean }).deckRouted === true,
    );

  async function clickSend(container: HTMLElement, buttonIndex: number): Promise<void> {
    await act(async () => {
      container.querySelectorAll('button')[buttonIndex]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  beforeEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
    // 一次性提示的标记在 localStorage（按 taskId 隔离）—— 用例间必须清，否则互相吞提示。
    window.localStorage.clear();
    mocks.send.mockClear();
    mocks.toastError.mockClear();
    mocks.toastInfo.mockClear();
    mocks.toastWarning.mockClear();
    mocks.taskState.updateTaskMetadata.mockClear();
    mocks.meetingState.records = [];
    mocks.taskState.activeTaskId = 'task-1';
    mocks.taskState.tasks = [{ ...mocks.baseTask, mode: 'smart' }];
    mocks.uiState.gatewayStatusMap = { 'gw-1': 'connected' };
    mocks.uiState.modelCatalogByGateway = { 'gw-1': catalogWithDeck };
    mocks.uiState.modelCatalogFailureByGateway = {};
    Object.assign(window, {
      clawwork: {
        getConfig: vi.fn(async () => ({
          ok: true,
          result: { config: { models: { providers: { clawrouter: { models: [] } } } } },
        })),
        readInboxFileForSend: vi.fn(async () => ({
          ok: true,
          result: { content: 'cGRm', encoding: 'base64', byteLength: 3 },
        })),
        readTaskContextFileForSend: vi.fn(async () => ({
          ok: true,
          result: { content: 'notes', mimeType: 'text/plain', size: 5, byteLength: 5, truncated: false, tier: 'text' },
        })),
        patchSession: vi.fn(async () => ({ ok: true })),
      },
    });
    compareStore().setState({ active: null, mode: false, error: null });
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
        fetchedAt: '2026-09-15T00:00:00.000Z',
      },
    });
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  it.each(['fast', 'smart', 'deep'] as const)(
    '%s 档 + 演示意图 ⇒ 钉目录里的 deepseek（不是 qwen），并标记任务',
    async (mode) => {
      mocks.taskState.tasks = [{ ...mocks.baseTask, mode }];
      const { container, unmount } = render(<Harness initialValue={DECK_DRAFT} />);

      await clickSend(container, 1);

      expect(mocks.send).toHaveBeenCalledOnce();
      expect(sendOptions()?.presetModel).toBe(DECK_MODEL_ID);
      expect(deckRoutedWrites()).toEqual([['task-1', { deckRouted: true }]]);
      unmount();
    },
  );

  it('普通聊天（不含演示意图）⇒ 模式模型照旧，一个字段都不写', async () => {
    const { container, unmount } = render(<Harness initialValue="帮我写一段周报" />);

    await clickSend(container, 1);

    expect(sendOptions()?.presetModel).toBe(BASE_MODEL_ID);
    expect(deckRoutedWrites()).toEqual([]);
    unmount();
  });

  it('⭐ 粘性：任务已标记 ⇒ 第二条"把标题改一下"（不含演示名词）仍走 deepseek，且不重复标记', async () => {
    mocks.taskState.tasks = [{ ...mocks.baseTask, mode: 'smart', deckRouted: true }];
    const { container, unmount } = render(<Harness initialValue="把标题改成第三季度的数据" />);

    await clickSend(container, 1);

    expect(sendOptions()?.presetModel).toBe(DECK_MODEL_ID);
    expect(deckRoutedWrites()).toEqual([]);
    unmount();
  });

  it('⭐ custom（用户显式选的模型）⇒ 演示意图也不覆盖、不标记', async () => {
    mocks.taskState.tasks = [{ ...mocks.baseTask, mode: 'custom', model: OTHER_MODEL_ID, thinkingLevel: 'low' }];
    const { container, unmount } = render(<Harness initialValue="帮我做个 deck 讲季度数据" />);

    await clickSend(container, 1);

    expect(sendOptions()?.presetModel).toBe(OTHER_MODEL_ID);
    expect(deckRoutedWrites()).toEqual([]);
    unmount();
  });

  it('⭐ 目录里只有旧渠道（没有新 Cephalon ID）⇒ 原样放行（不拦截、不悄悄回退旧渠道），但任务照记"这是 deck 任务"', async () => {
    mocks.uiState.modelCatalogByGateway = { 'gw-1': catalogWithoutDeck };
    const { container, unmount } = render(<Harness initialValue={DECK_DRAFT} />);

    await clickSend(container, 1);

    expect(mocks.send, '不拦：目录说话之前不替用户做决定').toHaveBeenCalledOnce();
    expect(sendOptions()?.presetModel, '路由不了就照旧跑模式模型').toBe(BASE_MODEL_ID);
    expect(deckRoutedWrites()).toEqual([['task-1', { deckRouted: true }]]);
    unmount();
  });

  it('⭐ 判据只吃用户手打的字：附件叫「培训课件.pdf」不算演示意图', async () => {
    const pdfMaterial: ImportedMaterialFile = {
      taskId: 'task-1',
      fileName: '培训课件.pdf',
      localPath: 'tasks/task-1/inbox/培训课件.pdf',
      mimeType: 'application/pdf',
      size: 64,
      availability: 'available',
    };
    const { container, unmount } = render(
      <MaterialHarness
        clearImported={vi.fn()}
        clearFolder={vi.fn()}
        importedMaterials={[pdfMaterial]}
        draft="总结一下这个文件"
      />,
    );

    await clickSend(container, 0);

    expect(mocks.send).toHaveBeenCalledOnce();
    expect(sendOptions()?.presetModel).toBe(BASE_MODEL_ID);
    expect(deckRoutedWrites()).toEqual([]);
    unmount();
  });
});
