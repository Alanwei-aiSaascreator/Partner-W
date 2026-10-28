// @vitest-environment jsdom

import { act, useRef, type Dispatch, type ReactElement, type SetStateAction } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, Task, Team } from '@clawwork/shared';
import type { TaskContextFile } from '../src/renderer/components/ChatInput/useTaskMaterials';

/* ---------- hoisted mocks ---------- */
const mocks = vi.hoisted(() => {
  const ensembleTask: Task = {
    id: 'task-ensemble',
    sessionKey: 'agent:main:clawwork:task:task-ensemble',
    sessionId: '',
    title: 'Team Task',
    status: 'active',
    createdAt: '2026-04-10T00:00:00.000Z',
    updatedAt: '2026-04-10T00:00:00.000Z',
    tags: [],
    artifactDir: '',
    gatewayId: 'gw-1',
    agentId: 'manager-agent',
    ensemble: true,
  };

  const teamData: Team = {
    id: 'team-1',
    name: 'Test Team',
    emoji: '',
    description: 'A test team',
    gatewayId: 'gw-1',
    source: 'local',
    version: '1',
    agents: [
      { agentId: 'manager-agent', role: 'manager', isManager: true, skills: [] },
      { agentId: 'worker-a', role: 'coder', isManager: false, skills: [] },
      { agentId: 'worker-b', role: 'reviewer', isManager: false, skills: [] },
    ],
    createdAt: '2026-04-10T00:00:00.000Z',
    updatedAt: '2026-04-10T00:00:00.000Z',
  };

  return {
    ensembleTask,
    teamData,
    initConductor: vi.fn(async () => true),
    composerSend: vi.fn(async () => ({ ok: true, taskId: 'task-ensemble' })),
    taskState: {
      tasks: [ensembleTask],
      activeTaskId: 'task-ensemble',
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
    },
    uiState: {
      gatewayStatusMap: { 'gw-1': 'connected' } as Record<string, string>,
      modelCatalogByGateway: {} as Record<string, unknown>,
      // 手写 store 桩**必须跟着长**（缺一个字段 = 整屏渲染崩）：`useChatSend` 每帧都要读它。
      modelCatalogFailureByGateway: {} as Record<string, true>,
      toolsCatalogByGateway: {} as Record<string, unknown>,
      agentCatalogByGateway: {} as Record<string, unknown>,
      setMainView: vi.fn(),
    },
    roomState: {
      rooms: {} as Record<string, unknown>,
      initConductor: vi.fn(async () => true),
    },
    teamState: {
      teams: {} as Record<string, Team>,
    },
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  // 见 use-chat-send.test.tsx 的同名说明：i18n 实例加载时会 use(initReactI18next)。
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

vi.mock('../src/renderer/lib/toast', () => ({
  toast: {
    error: vi.fn(),
    // 2026-10-08 集成：useChatSend 的 vision 计划会调 `toast.info`（真身=sonner 全量对象，存在）。
    info: vi.fn(),
  },
}));

vi.mock('@clawwork/core', () => ({
  deriveSessionActivity: () => 'idle',
  extractDescription: (content: string) => content.slice(0, 50),
  getTaskSessionKeys: (task: { sessionKey: string }) => [task.sessionKey],
}));

vi.mock('../src/renderer/features/team-meeting/instance', () => ({
  teamMeetingController: { store: { getState: () => ({ records: [] }) } },
}));

/* Build mock store functions that support both hook calls and .getState() */
function makeStoreMock<T extends object>(stateRef: T) {
  const fn = <U,>(selector?: (state: T) => U) => (selector ? selector(stateRef) : stateRef);
  fn.getState = () => stateRef;
  fn.setState = () => {};
  fn.subscribe = () => () => {};
  return fn;
}

vi.mock('../src/renderer/platform', () => ({
  composer: {
    send: mocks.composerSend,
    abort: vi.fn(async () => {}),
  },
  useTaskStore: makeStoreMock(mocks.taskState),
  useMessageStore: makeStoreMock(mocks.messageState),
  useUiStore: makeStoreMock(mocks.uiState),
  useRoomStore: makeStoreMock(mocks.roomState),
  useTeamStore: makeStoreMock(mocks.teamState),
}));

import { toast } from '../src/renderer/lib/toast';
import { useChatSend } from '../src/renderer/components/ChatInput/useChatSend';
import { useCommercialStore } from '../src/renderer/stores/commercialStore';

/* ---------- helpers ---------- */
function render(ui: ReactElement): { container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

let capturedHandleSend: (() => Promise<void>) | null = null;

const importedMaterial = {
  taskId: 'task-ensemble',
  fileName: 'brief.pdf',
  localPath: 'tasks/task-ensemble/inbox/brief.pdf',
  mimeType: 'application/pdf',
  size: 64,
  availability: 'available' as const,
};

const sourceMaterial: TaskContextFile = {
  taskId: 'task-ensemble',
  sourceId: 'source-1',
  sourceName: 'Research',
  fileName: 'diagram.png',
  relativePath: 'diagram.png',
  mimeType: 'image/png',
  size: 5,
  mtime: 1,
  tier: 'image',
};

function Harness({
  withMaterials = false,
  setPendingAttachments = vi.fn(),
  clearImported = vi.fn(),
  clearSource = vi.fn(),
}: {
  withMaterials?: boolean;
  setPendingAttachments?: Dispatch<SetStateAction<Array<{ file: File; previewUrl: string }>>>;
  clearImported?: () => void;
  clearSource?: Dispatch<SetStateAction<TaskContextFile[]>>;
} = {}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingAttachments = withMaterials
    ? [{ file: new File(['paste'], 'pasted.png', { type: 'image/png' }), previewUrl: 'blob:pasted' }]
    : [];
  const chat = useChatSend({
    textareaRef,
    pendingAttachments,
    setPendingAttachments,
    selectedTasks: [],
    setSelectedTasks: vi.fn(),
    selectedArtifacts: [],
    setSelectedArtifacts: vi.fn(),
    selectedLocalFiles: withMaterials ? [sourceMaterial] : [],
    setSelectedLocalFiles: clearSource,
    selectedImportedFiles: withMaterials ? [importedMaterial] : [],
    clearSelectedImportedFiles: clearImported,
    markImportedFileMissing: vi.fn(),
    selectedAgents: [],
    setSelectedAgents: vi.fn(),
    stopVoiceInput: vi.fn(),
  });
  capturedHandleSend = chat.handleSend;
  return <textarea ref={textareaRef} defaultValue="hello team" />;
}

/* ---------- tests ---------- */
describe('conductor initialization - catalog fallback', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    capturedHandleSend = null;
    vi.clearAllMocks();

    // Stub IPC call used to fetch agent IDENTITY.md
    (globalThis as Record<string, unknown>).window = globalThis;
    (globalThis as Record<string, unknown> & { clawwork?: Record<string, unknown> }).clawwork = {
      getAgentFile: vi.fn(async () => ({ ok: false })),
      saveInboxAttachment: vi.fn(async () => ({
        ok: true,
        result: { localPath: 'tasks/task-ensemble/inbox/pasted.png' },
      })),
      readInboxFileForSend: vi.fn(async () => ({ ok: true, result: { content: 'cGRm', encoding: 'base64' } })),
      readTaskContextFileForSend: vi.fn(async () => ({
        ok: true,
        result: {
          content: 'aW1hZ2U=',
          mimeType: 'image/png',
          size: 5,
          byteLength: 5,
          truncated: false,
          tier: 'image',
        },
      })),
      // MM-A（2026-10-15）：所有模式带图发送先回读最终静态配置（`getConfig`）。
      // conductor 用例考的是初始化与附件派发，不考视觉路由 —— 给一份空的 clawrouter
      // 目录（目录条目按自身声明通过）；缺了这个桩，门禁会因 `getConfig` 不存在而阻断。
      getConfig: vi.fn(async () => ({
        ok: true,
        result: { config: { models: { providers: { clawrouter: { models: [] } } } } },
      })),
    };
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

  /**
   * MM-A（2026-10-15）后带图发送要过视觉门禁（对**最终执行模型**裁定）。本文件的用例
   * 考的是 conductor 初始化与附件派发 —— 目录里放一个**能看图**的最终模型让门禁通过；
   * 阻断语义本身由 use-chat-send / vision-routing 的用例钉（含本文件末尾的一条负例）。
   */
  function withVisionCapableFinalModel(): void {
    mocks.uiState.modelCatalogByGateway = {
      'gw-1': [{ id: 'glm-5.3-flash', name: 'GLM 5.3 Flash', provider: 'clawrouter', input: ['text', 'image'] }],
    };
    const current = mocks.taskState.tasks[0]!;
    mocks.taskState.tasks = [{ ...current, model: 'glm-5.3-flash' }];
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps ordinary ensemble tasks fail-closed when the gateway catalog is not yet loaded', async () => {
    mocks.uiState.agentCatalogByGateway = {};
    mocks.teamState.teams = { 'team-1': mocks.teamData };
    mocks.roomState.rooms = {};
    mocks.roomState.initConductor.mockResolvedValue(true);

    const { unmount } = render(<Harness />);
    expect(capturedHandleSend).not.toBeNull();

    await act(async () => {
      await capturedHandleSend!();
    });

    expect(toast.error).toHaveBeenCalledWith('errors.conductorInitFailed');
    expect(mocks.roomState.initConductor).not.toHaveBeenCalled();

    unmount();
  });

  it('shows error toast when an ordinary ensemble catalog is loaded but empty', async () => {
    mocks.uiState.agentCatalogByGateway = { 'gw-1': { defaultId: 'main', agents: [] } };
    mocks.teamState.teams = {};
    mocks.roomState.rooms = {};

    const { unmount } = render(<Harness />);
    expect(capturedHandleSend).not.toBeNull();

    await act(async () => {
      await capturedHandleSend!();
    });

    expect(toast.error).toHaveBeenCalledWith('errors.conductorInitFailed');
    expect(mocks.roomState.initConductor).not.toHaveBeenCalled();

    unmount();
  });

  it('uses gateway catalog agents for an ordinary non-team ensemble task', async () => {
    mocks.uiState.agentCatalogByGateway = {
      'gw-1': {
        defaultId: 'main',
        agents: [
          { id: 'manager-agent', name: 'Manager' },
          { id: 'worker-a', name: 'Worker A', identity: { emoji: '🔧' } },
          { id: 'worker-b', name: 'Worker B' },
          { id: 'unrelated-agent', name: 'Other' },
        ],
      },
    };
    mocks.teamState.teams = { 'team-1': mocks.teamData };
    mocks.roomState.rooms = {};
    mocks.roomState.initConductor.mockResolvedValue(true);

    const { unmount } = render(<Harness />);

    await act(async () => {
      await capturedHandleSend!();
    });

    expect(toast.error).not.toHaveBeenCalledWith('errors.conductorInitFailed');
    expect(mocks.roomState.initConductor).toHaveBeenCalledTimes(1);

    const catalogArg = (mocks.roomState.initConductor.mock.calls[0] as unknown[])[3] as string;
    expect(catalogArg).toContain('Manager');
    expect(catalogArg).toContain('Worker A');
    expect(catalogArg).toContain('Worker B');
    expect(catalogArg).toContain('Other');

    unmount();
  });

  it('initializes first, then dispatches imported, source, and pasted attachments before clearing the draft', async () => {
    mocks.uiState.agentCatalogByGateway = {
      'gw-1': {
        defaultId: 'main',
        agents: [{ id: 'worker-a', name: 'Worker A' }],
      },
    };
    withVisionCapableFinalModel();
    mocks.teamState.teams = { 'team-1': mocks.teamData };
    mocks.roomState.rooms = {};
    const setPendingAttachments = vi.fn();
    const clearImported = vi.fn();
    const clearSource = vi.fn();
    const { container, unmount } = render(
      <Harness
        withMaterials
        setPendingAttachments={setPendingAttachments}
        clearImported={clearImported}
        clearSource={clearSource}
      />,
    );

    await act(async () => {
      await capturedHandleSend!();
    });

    expect(mocks.roomState.initConductor).toHaveBeenCalledWith(
      'task-ensemble',
      'gw-1',
      'agent:main:clawwork:task:task-ensemble',
      expect.any(String),
    );
    expect(window.clawwork.readInboxFileForSend).toHaveBeenCalledWith('tasks/task-ensemble/inbox/brief.pdf');
    expect(window.clawwork.readTaskContextFileForSend).toHaveBeenCalledWith('task-ensemble', 'source-1', 'diagram.png');
    expect(mocks.composerSend).toHaveBeenCalledWith(
      'task-ensemble',
      expect.objectContaining({
        content: 'hello team',
        attachments: expect.arrayContaining([
          { mimeType: 'image/png', fileName: 'pasted.png', content: 'cGFzdGU=' },
          { mimeType: 'application/pdf', fileName: 'brief.pdf', content: 'cGRm' },
          { mimeType: 'image/png', fileName: 'diagram.png', content: 'aW1hZ2U=' },
        ]),
        messageAttachments: expect.arrayContaining([
          expect.objectContaining({
            fileName: 'pasted.png',
            localPath: 'tasks/task-ensemble/inbox/pasted.png',
          }),
          expect.objectContaining({
            fileName: 'brief.pdf',
            localPath: 'tasks/task-ensemble/inbox/brief.pdf',
          }),
        ]),
      }),
    );
    expect(mocks.messageState.addMessage).not.toHaveBeenCalled();
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('');
    expect(setPendingAttachments).toHaveBeenCalledWith([]);
    expect(clearImported).toHaveBeenCalledTimes(1);
    expect(clearSource).toHaveBeenCalledWith([]);
    unmount();
  });

  it('preserves the draft and does not persist a user message when conductor initialization fails', async () => {
    mocks.uiState.agentCatalogByGateway = {
      'gw-1': {
        defaultId: 'main',
        agents: [{ id: 'worker-a', name: 'Worker A' }],
      },
    };
    mocks.teamState.teams = { 'team-1': mocks.teamData };
    mocks.roomState.rooms = {};
    mocks.roomState.initConductor.mockResolvedValueOnce(false);
    const setPendingAttachments = vi.fn();
    const clearImported = vi.fn();
    const clearSource = vi.fn();
    const { container, unmount } = render(
      <Harness
        withMaterials
        setPendingAttachments={setPendingAttachments}
        clearImported={clearImported}
        clearSource={clearSource}
      />,
    );

    await act(async () => {
      await capturedHandleSend!();
    });

    expect(mocks.composerSend).not.toHaveBeenCalled();
    expect(mocks.messageState.addMessage).not.toHaveBeenCalled();
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('hello team');
    expect(setPendingAttachments).not.toHaveBeenCalled();
    expect(clearImported).not.toHaveBeenCalled();
    expect(clearSource).not.toHaveBeenCalled();
    unmount();
  });

  it('preserves the draft and avoids a false local message when first dispatch fails after initialization', async () => {
    mocks.uiState.agentCatalogByGateway = {
      'gw-1': {
        defaultId: 'main',
        agents: [{ id: 'worker-a', name: 'Worker A' }],
      },
    };
    withVisionCapableFinalModel();
    mocks.teamState.teams = { 'team-1': mocks.teamData };
    mocks.roomState.rooms = {};
    mocks.composerSend.mockResolvedValueOnce({ ok: false, taskId: 'task-ensemble' });
    const setPendingAttachments = vi.fn();
    const clearImported = vi.fn();
    const clearSource = vi.fn();
    const { container, unmount } = render(
      <Harness
        withMaterials
        setPendingAttachments={setPendingAttachments}
        clearImported={clearImported}
        clearSource={clearSource}
      />,
    );

    await act(async () => {
      await capturedHandleSend!();
    });

    expect(mocks.roomState.initConductor).toHaveBeenCalledTimes(1);
    expect(mocks.composerSend).toHaveBeenCalledTimes(1);
    expect(mocks.messageState.addMessage).not.toHaveBeenCalled();
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('hello team');
    expect(setPendingAttachments).not.toHaveBeenCalled();
    expect(clearImported).not.toHaveBeenCalled();
    expect(clearSource).not.toHaveBeenCalled();
    unmount();
  });

  it('defers every ready ensemble retry and clears once after the first successful dispatch', async () => {
    mocks.uiState.agentCatalogByGateway = {
      'gw-1': {
        defaultId: 'main',
        agents: [{ id: 'worker-a', name: 'Worker A' }],
      },
    };
    withVisionCapableFinalModel();
    mocks.teamState.teams = { 'team-1': mocks.teamData };
    mocks.roomState.rooms = {
      'task-ensemble': { taskId: 'task-ensemble', conductorReady: true, status: 'active', performers: [] },
    };
    mocks.composerSend
      .mockResolvedValueOnce({ ok: false, taskId: 'task-ensemble' })
      .mockResolvedValueOnce({ ok: false, taskId: 'task-ensemble' })
      .mockResolvedValueOnce({ ok: true, taskId: 'task-ensemble' });
    const setPendingAttachments = vi.fn();
    const clearImported = vi.fn();
    const clearSource = vi.fn();
    const { container, unmount } = render(
      <Harness
        withMaterials
        setPendingAttachments={setPendingAttachments}
        clearImported={clearImported}
        clearSource={clearSource}
      />,
    );

    await act(async () => {
      await capturedHandleSend!();
      await capturedHandleSend!();
    });

    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('hello team');
    expect(setPendingAttachments).not.toHaveBeenCalled();
    expect(clearImported).not.toHaveBeenCalled();
    expect(clearSource).not.toHaveBeenCalled();
    expect(mocks.messageState.addMessage).not.toHaveBeenCalled();
    expect(mocks.composerSend).toHaveBeenCalledTimes(2);
    for (const call of mocks.composerSend.mock.calls as unknown as Array<
      [string, { deferUserMessageUntilSent?: boolean }]
    >) {
      expect(call[1]).toEqual(expect.objectContaining({ deferUserMessageUntilSent: true }));
    }

    await act(async () => {
      await capturedHandleSend!();
    });

    expect(mocks.roomState.initConductor).not.toHaveBeenCalled();
    expect(mocks.composerSend).toHaveBeenCalledTimes(3);
    expect(mocks.messageState.addMessage).not.toHaveBeenCalled();
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('');
    expect(setPendingAttachments).toHaveBeenCalledTimes(1);
    expect(setPendingAttachments).toHaveBeenCalledWith([]);
    expect(clearImported).toHaveBeenCalledTimes(1);
    expect(clearSource).toHaveBeenCalledTimes(1);
    expect(clearSource).toHaveBeenCalledWith([]);
    unmount();
  });

  it('MM-A 负例：带图 + 目录没有能看图的最终模型 ⇒ 视觉门禁同样拦 conductor 派发（草稿与附件保留）', async () => {
    // 门禁是**所有发送模式共用**的（MM-A §3）：conductor/ensemble 路径不许成为丢图旁路。
    mocks.uiState.agentCatalogByGateway = {
      'gw-1': {
        defaultId: 'main',
        agents: [{ id: 'worker-a', name: 'Worker A' }],
      },
    };
    mocks.uiState.modelCatalogByGateway = {
      'gw-1': [{ id: 'glm-5.3-flash', name: 'GLM 5.3 Flash', provider: 'clawrouter', input: ['text'] }],
    };
    const current = mocks.taskState.tasks[0]!;
    mocks.taskState.tasks = [{ ...current, model: 'glm-5.3-flash' }];
    mocks.teamState.teams = { 'team-1': mocks.teamData };
    mocks.roomState.rooms = {};
    const setPendingAttachments = vi.fn();
    const clearImported = vi.fn();
    const clearSource = vi.fn();
    const { container, unmount } = render(
      <Harness
        withMaterials
        setPendingAttachments={setPendingAttachments}
        clearImported={clearImported}
        clearSource={clearSource}
      />,
    );

    await act(async () => {
      await capturedHandleSend!();
    });

    // 目录里没有能看图的候选 ⇒ 不切模型、不派发；草稿和附件原样保留。
    expect(mocks.composerSend).not.toHaveBeenCalled();
    expect(setPendingAttachments).not.toHaveBeenCalledWith([]);
    expect(clearImported).not.toHaveBeenCalled();
    expect(clearSource).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('chatInput.visionUnavailable');
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('hello team');
    unmount();
  });
});
