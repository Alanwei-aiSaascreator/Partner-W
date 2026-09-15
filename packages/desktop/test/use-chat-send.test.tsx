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
    abort: vi.fn(async () => {}),
    applySlashCommand: vi.fn(async () => ({ ok: true })),
    send: vi.fn<(taskId: string) => Promise<{ ok: boolean; taskId?: string; partialFailure?: string }>>(async () => ({
      ok: true,
      taskId: 'task-1',
    })),
    toastWarning: vi.fn(),
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
    },
    uiState: {
      gatewayStatusMap: { 'gw-1': 'connected' } as Record<string, 'connected' | 'connecting' | 'disconnected'>,
      modelCatalogByGateway: {} as Record<string, ModelCatalogEntry[]>,
      toolsCatalogByGateway: {},
    },
    roomState: {
      rooms: {},
    },
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    warning: mocks.toastWarning,
  },
}));

vi.mock('../src/renderer/platform', () => ({
  composer: {
    abort: mocks.abort,
    applySlashCommand: mocks.applySlashCommand,
    send: mocks.send,
  },
  useTaskStore: <T,>(selector?: (state: typeof mocks.taskState) => T) =>
    selector ? selector(mocks.taskState) : mocks.taskState,
  useMessageStore: <T,>(selector?: (state: typeof mocks.messageState) => T) =>
    selector ? selector(mocks.messageState) : mocks.messageState,
  useUiStore: <T,>(selector?: (state: typeof mocks.uiState) => T) =>
    selector ? selector(mocks.uiState) : mocks.uiState,
  useRoomStore: <T,>(selector?: (state: typeof mocks.roomState) => T) =>
    selector ? selector(mocks.roomState) : mocks.roomState,
}));

import { useChatSend } from '../src/renderer/components/ChatInput/useChatSend';
import type { ImportedMaterialFile, TaskContextFile } from '../src/renderer/components/ChatInput/useTaskMaterials';
import { useCommercialStore } from '../src/renderer/stores/commercialStore';

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
  size: 5,
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
    mocks.taskState.activeTaskId = 'task-1';
    mocks.taskState.tasks = [mocks.taskState.tasks.find((task) => task.id === 'task-1')!];
    Object.assign(window, {
      clawwork: {
        readInboxFileForSend: vi.fn(async () => ({ ok: true, result: { content: 'cGRm', encoding: 'base64' } })),
        readTaskContextFileForSend: vi.fn(async () => ({
          ok: true,
          result: { content: 'notes', mimeType: 'text/plain', size: 5, truncated: false, tier: 'text' },
        })),
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
      result: { content: 'aW1hZ2U=', mimeType: 'image/png', size: 5, truncated: false, tier: 'image' },
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

  it('rejects cumulative material bytes above twenty-five megabytes before reading', async () => {
    const importedMaterials = [
      { ...importedMaterial, size: 13 * 1024 * 1024 },
      {
        ...importedMaterial,
        fileName: 'second.pdf',
        localPath: 'tasks/task-1/inbox/second.pdf',
        size: 13 * 1024 * 1024,
      },
    ];
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
    mocks.taskState.tasks = [];
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
});
