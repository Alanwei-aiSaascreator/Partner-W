// @vitest-environment jsdom

import { act, useRef, type Dispatch, type ReactElement, type SetStateAction } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelCatalogEntry, Task } from '@clawwork/shared';

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
    >(async () => ({
      ok: true,
      taskId: 'task-1',
    })),
    toastWarning: vi.fn(),
    toastError: vi.fn(),
    taskState: {
      tasks: [activeTask],
      activeTaskId: 'task-1' as string | null,
      pendingNewTask: null,
      commitPendingTask: vi.fn(),
      updateTaskMetadata: vi.fn(),
    },
    messageState: {
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
    },
    roomState: {
      rooms: {},
    },
    teamState: {
      teams: {} as Record<string, import('@clawwork/shared').Team>,
      loadTeam: vi.fn(async () => null as import('@clawwork/shared').Team | null),
    },
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  // i18n 实例在模块加载时就会 `use(initReactI18next)`（见 src/renderer/i18n），
  // 而 useChatSend → 对比 store 会把它拉进这个测试；少了这个导出，整个测试文件加载即失败。
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

vi.mock('sonner', () => ({
  toast: {
    error: mocks.toastError,
    warning: mocks.toastWarning,
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
  useTaskStore: <T,>(selector?: (state: typeof mocks.taskState) => T) =>
    selector ? selector(mocks.taskState) : mocks.taskState,
  useMessageStore: <T,>(selector?: (state: typeof mocks.messageState) => T) =>
    selector ? selector(mocks.messageState) : mocks.messageState,
  useUiStore: Object.assign(
    <T,>(selector?: (state: typeof mocks.uiState) => T) => (selector ? selector(mocks.uiState) : mocks.uiState),
    { getState: () => mocks.uiState },
  ),
  useRoomStore: <T,>(selector?: (state: typeof mocks.roomState) => T) =>
    selector ? selector(mocks.roomState) : mocks.roomState,
  useTeamStore: Object.assign(
    <T,>(selector?: (state: typeof mocks.teamState) => T) => (selector ? selector(mocks.teamState) : mocks.teamState),
    { getState: () => mocks.teamState },
  ),
}));

import { UnknownAgentError } from '@clawwork/core';
import { useChatSend } from '../src/renderer/components/ChatInput/useChatSend';
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
}: {
  clearImported: () => void;
  clearFolder: Dispatch<SetStateAction<TaskContextFile[]>>;
  markMissing?: (localPath: string) => void;
  importedMaterials?: ImportedMaterialFile[];
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
    selectedLocalFiles: [folderMaterial],
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
      <textarea ref={textareaRef} defaultValue="summarize" />
      <button type="button" onClick={() => void chat.handleSend()}>
        send
      </button>
    </>
  );
}

describe('useChatSend abort flow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
    mocks.abort.mockClear();
    mocks.applySlashCommand.mockClear();
    mocks.send.mockClear();
    mocks.toastWarning.mockClear();
    // ⚠️ 必须重置实现，不只是清调用：`commitPendingTask` 有测试会装"抛错"的实现，
    //    不重置就**泄漏给后面所有用例**（2026-09-24 我自己踩了一次：4 条无关用例跟着红）。
    mocks.taskState.commitPendingTask.mockReset();
    mocks.taskState.activeTaskId = 'task-1';
    mocks.taskState.tasks = [{ ...mocks.baseTask }];
    Object.assign(window, {
      clawwork: {
        readInboxFileForSend: vi.fn(async () => ({
          ok: true,
          result: { content: 'cGRm', encoding: 'base64', byteLength: 3 },
        })),
        readTaskContextFileForSend: vi.fn(async () => ({
          ok: true,
          result: { content: 'notes', mimeType: 'text/plain', size: 5, byteLength: 5, truncated: false, tier: 'text' },
        })),
      },
    });
    mocks.uiState.gatewayStatusMap = { 'gw-1': 'connected' };
    mocks.uiState.modelCatalogByGateway = {};
    mocks.uiState.agentCatalogByGateway = {};
    mocks.uiState.toolsCatalogByGateway = {};
    mocks.uiState.effectiveToolsByGateway = {};
    mocks.roomState.rooms = {};
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

  it('rejects more than ten combined materials before reading or dispatching', async () => {
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
    });
    expect(window.clawwork.readInboxFileForSend).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    unmount();
  });

  it('rejects cumulative material bytes using main-process byte lengths instead of stale list metadata', async () => {
    const importedMaterials = [{ ...importedMaterial, size: 1 }];
    vi.mocked(window.clawwork.readInboxFileForSend).mockResolvedValue({
      ok: true,
      result: { content: 'cGRm', encoding: 'base64', byteLength: 20 * 1024 * 1024 },
    } as never);
    vi.mocked(window.clawwork.readTaskContextFileForSend).mockResolvedValue({
      ok: true,
      result: {
        content: 'notes',
        mimeType: 'text/plain',
        size: 20 * 1024 * 1024,
        byteLength: 20 * 1024 * 1024,
        truncated: true,
        tier: 'text',
      },
    });
    const { container, unmount } = render(
      <MaterialHarness clearImported={vi.fn()} clearFolder={vi.fn()} importedMaterials={importedMaterials} />,
    );
    await act(async () => {
      (container.querySelector('button') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(window.clawwork.readInboxFileForSend).toHaveBeenCalledTimes(1);
    expect(window.clawwork.readTaskContextFileForSend).toHaveBeenCalledTimes(1);
    expect(mocks.send).not.toHaveBeenCalled();
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('summarize');
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
    Object.assign(window, { clawwork: {} });
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
