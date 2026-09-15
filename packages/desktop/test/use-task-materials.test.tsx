// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  t: (key: string) => key,
  activeTaskId: 'task-1' as string | null,
  commitPendingTask: vi.fn(() => ({ id: 'task-created' })),
  importTaskFiles: vi.fn(),
  listImportedTaskFiles: vi.fn(),
  grantTaskContextFolder: vi.fn(),
  listTaskContextSources: vi.fn(),
  revokeTaskContextSource: vi.fn(),
  listTaskContextFiles: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mocks.t }),
}));
vi.mock('../src/renderer/lib/toast', () => ({ toast: { error: mocks.toastError, warning: vi.fn() } }));

vi.mock('../src/renderer/stores/taskStore', () => ({
  useTaskStore: Object.assign(
    <T,>(selector: (state: { activeTaskId: string | null }) => T) => selector({ activeTaskId: mocks.activeTaskId }),
    {
      getState: () => ({ activeTaskId: mocks.activeTaskId, commitPendingTask: mocks.commitPendingTask }),
    },
  ),
}));

import { useTaskMaterials } from '../src/renderer/components/ChatInput/useTaskMaterials';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render(ui: ReactElement): {
  container: HTMLDivElement;
  rerender: (next: ReactElement) => void;
  unmount: () => void;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => root.render(ui));
  return {
    container,
    rerender: (next) => act(() => root.render(next)),
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function Harness({ taskId }: { taskId: string | null }) {
  const materials = useTaskMaterials(taskId);
  return (
    <div>
      <output data-testid="task">{materials.taskId ?? 'none'}</output>
      <output data-testid="imported">{materials.importedFiles.map((file) => file.fileName).join(',')}</output>
      <output data-testid="selected">{materials.selectedImportedFiles.map((file) => file.fileName).join(',')}</output>
      <output data-testid="sources">{materials.sources.map((source) => source.displayName).join(',')}</output>
      <output data-testid="context">{materials.contextFiles.map((file) => file.fileName).join(',')}</output>
      <button type="button" onClick={() => void materials.importFiles()}>
        import
      </button>
      <button type="button" onClick={() => materials.toggleImportedFile('tasks/task-1/inbox/a.txt')}>
        toggle
      </button>
      <button type="button" onClick={() => void materials.grantFolder()}>
        grant
      </button>
      <button type="button" onClick={() => void materials.revokeSource('source-task-1')}>
        revoke
      </button>
      <button type="button" onClick={() => void materials.loadSourceFiles()}>
        load source files
      </button>
    </div>
  );
}

describe('useTaskMaterials', () => {
  beforeEach(() => {
    mocks.activeTaskId = 'task-1';
    mocks.commitPendingTask.mockClear();
    mocks.importTaskFiles.mockReset();
    mocks.listImportedTaskFiles.mockReset();
    mocks.grantTaskContextFolder.mockReset();
    mocks.listTaskContextSources.mockReset();
    mocks.revokeTaskContextSource.mockReset();
    mocks.listTaskContextFiles.mockReset();
    mocks.toastError.mockReset();
    Object.assign(window, {
      clawwork: {
        importTaskFiles: mocks.importTaskFiles,
        listImportedTaskFiles: mocks.listImportedTaskFiles,
        grantTaskContextFolder: mocks.grantTaskContextFolder,
        listTaskContextSources: mocks.listTaskContextSources,
        revokeTaskContextSource: mocks.revokeTaskContextSource,
        listTaskContextFiles: mocks.listTaskContextFiles,
      },
    });
  });

  it('isolates loaded sources and imported files when the task changes', async () => {
    mocks.listImportedTaskFiles.mockImplementation(async (taskId: string) => ({
      ok: true,
      result: [
        {
          fileName: `${taskId}.txt`,
          localPath: `tasks/${taskId}/inbox/${taskId}.txt`,
          mimeType: 'text/plain',
          size: 10,
        },
      ],
    }));
    mocks.listTaskContextSources.mockImplementation(async (taskId: string) => ({
      ok: true,
      result: [
        {
          id: `source-${taskId}`,
          taskId,
          kind: 'folder',
          absolutePath: `C:/${taskId}`,
          displayName: taskId,
          createdAt: '',
          lastSeenAt: '',
          availability: 'available',
        },
      ],
    }));
    const view = render(<Harness taskId="task-1" />);
    await act(async () => void (await Promise.resolve()));
    expect(view.container.querySelector('[data-testid="imported"]')?.textContent).toBe('task-1.txt');
    expect(view.container.querySelector('[data-testid="sources"]')?.textContent).toBe('task-1');

    view.rerender(<Harness taskId="task-2" />);
    await act(async () => void (await Promise.resolve()));
    expect(view.container.querySelector('[data-testid="imported"]')?.textContent).toBe('task-2.txt');
    expect(view.container.querySelector('[data-testid="selected"]')?.textContent).toBe('');
    expect(view.container.querySelector('[data-testid="sources"]')?.textContent).toBe('task-2');
    view.unmount();
  });

  it('selects newly imported files and toggling a draft selection never deletes the inbox copy', async () => {
    mocks.listImportedTaskFiles.mockResolvedValue({ ok: true, result: [] });
    mocks.listTaskContextSources.mockResolvedValue({ ok: true, result: [] });
    mocks.importTaskFiles.mockResolvedValue({
      ok: true,
      result: {
        imported: [
          {
            fileName: 'a.txt',
            localPath: 'tasks/task-1/inbox/a.txt',
            mimeType: 'text/plain',
            size: 12,
          },
        ],
        rejected: [],
      },
    });
    const view = render(<Harness taskId="task-1" />);
    await act(async () => void (await Promise.resolve()));
    const buttons = view.container.querySelectorAll('button');
    await act(async () => void (await (buttons[0] as HTMLButtonElement).click()));
    expect(view.container.querySelector('[data-testid="imported"]')?.textContent).toBe('a.txt');
    expect(view.container.querySelector('[data-testid="selected"]')?.textContent).toBe('a.txt');

    act(() => (buttons[1] as HTMLButtonElement).click());
    expect(view.container.querySelector('[data-testid="imported"]')?.textContent).toBe('a.txt');
    expect(view.container.querySelector('[data-testid="selected"]')?.textContent).toBe('');
    expect(mocks.importTaskFiles).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it('commits a pending task before opening a native file picker', async () => {
    mocks.activeTaskId = null;
    mocks.listImportedTaskFiles.mockResolvedValue({ ok: true, result: [] });
    mocks.listTaskContextSources.mockResolvedValue({ ok: true, result: [] });
    mocks.importTaskFiles.mockResolvedValue({ ok: true, result: { imported: [], rejected: [] } });
    mocks.grantTaskContextFolder.mockResolvedValue({ ok: true, result: null });
    const view = render(<Harness taskId={null} />);
    const buttons = view.container.querySelectorAll('button');

    await act(async () => void (await (buttons[0] as HTMLButtonElement).click()));
    expect(mocks.commitPendingTask).toHaveBeenCalledTimes(1);
    expect(mocks.importTaskFiles).toHaveBeenCalledWith('task-created');

    view.unmount();
  });

  it('commits a pending task before opening a native folder picker', async () => {
    mocks.activeTaskId = null;
    mocks.listImportedTaskFiles.mockResolvedValue({ ok: true, result: [] });
    mocks.listTaskContextSources.mockResolvedValue({ ok: true, result: [] });
    mocks.grantTaskContextFolder.mockResolvedValue({ ok: true, result: null });
    const view = render(<Harness taskId={null} />);
    const buttons = view.container.querySelectorAll('button');

    await act(async () => void (await (buttons[2] as HTMLButtonElement).click()));
    expect(mocks.commitPendingTask).toHaveBeenCalledTimes(1);
    expect(mocks.grantTaskContextFolder).toHaveBeenCalledWith('task-created');
    view.unmount();
  });

  it('ignores an import that resolves after switching to another task', async () => {
    let resolveImport!: (value: unknown) => void;
    mocks.listImportedTaskFiles.mockResolvedValue({ ok: true, result: [] });
    mocks.listTaskContextSources.mockResolvedValue({ ok: true, result: [] });
    mocks.importTaskFiles.mockReturnValue(new Promise((resolve) => (resolveImport = resolve)));
    const view = render(<Harness taskId="task-1" />);
    await act(async () => void (await Promise.resolve()));
    act(() => (view.container.querySelectorAll('button')[0] as HTMLButtonElement).click());
    view.rerender(<Harness taskId="task-2" />);
    await act(async () => {
      resolveImport({
        ok: true,
        result: {
          imported: [
            { fileName: 'late.txt', localPath: 'tasks/task-1/inbox/late.txt', mimeType: 'text/plain', size: 1 },
          ],
          rejected: [],
        },
      });
      await Promise.resolve();
    });
    expect(view.container.querySelector('[data-testid="imported"]')?.textContent).toBe('');
    view.unmount();
  });

  it('reports structured load failures instead of treating them as an empty success', async () => {
    mocks.listImportedTaskFiles.mockResolvedValue({ ok: false, error: 'inbox unavailable' });
    mocks.listTaskContextSources.mockResolvedValue({ ok: false, error: 'sources unavailable' });
    const view = render(<Harness taskId="task-1" />);
    await act(async () => void (await Promise.resolve()));
    expect(mocks.toastError).toHaveBeenCalledWith('chatInput.materialsLoadFailed', expect.any(Object));
    view.unmount();
  });

  it('does not let a delayed source listing clear the next task context files', async () => {
    let resolveTaskOne!: (value: unknown) => void;
    mocks.listImportedTaskFiles.mockResolvedValue({ ok: true, result: [] });
    mocks.listTaskContextSources.mockImplementation(async (taskId: string) => ({
      ok: true,
      result: [
        {
          id: `source-${taskId}`,
          taskId,
          kind: 'folder',
          absolutePath: `C:/${taskId}`,
          displayName: taskId,
          createdAt: '',
          lastSeenAt: '',
          availability: 'available',
        },
      ],
    }));
    mocks.listTaskContextFiles.mockImplementation((taskId: string) => {
      if (taskId === 'task-1') return new Promise((resolve) => (resolveTaskOne = resolve));
      return Promise.resolve({
        ok: true,
        result: [
          {
            fileName: 'task-2.txt',
            relativePath: 'task-2.txt',
            absolutePath: 'C:/task-2/task-2.txt',
            mimeType: 'text/plain',
            size: 1,
            mtime: 1,
            tier: 'text',
          },
        ],
      });
    });
    const view = render(<Harness taskId="task-1" />);
    await act(async () => void (await Promise.resolve()));
    act(() => (view.container.querySelectorAll('button')[4] as HTMLButtonElement).click());
    view.rerender(<Harness taskId="task-2" />);
    await act(async () => void (await Promise.resolve()));
    await act(async () => void (await (view.container.querySelectorAll('button')[4] as HTMLButtonElement).click()));
    expect(view.container.querySelector('[data-testid="context"]')?.textContent).toBe('task-2.txt');

    await act(async () => {
      resolveTaskOne({ ok: true, result: [] });
      await Promise.resolve();
    });
    expect(view.container.querySelector('[data-testid="context"]')?.textContent).toBe('task-2.txt');
    view.unmount();
  });

  it('removes revoked source files from the current context list', async () => {
    mocks.listImportedTaskFiles.mockResolvedValue({ ok: true, result: [] });
    mocks.listTaskContextSources.mockResolvedValue({
      ok: true,
      result: [
        {
          id: 'source-task-1',
          taskId: 'task-1',
          kind: 'folder',
          absolutePath: 'C:/task-1',
          displayName: 'task-1',
          createdAt: '',
          lastSeenAt: '',
          availability: 'available',
        },
      ],
    });
    mocks.listTaskContextFiles.mockResolvedValue({
      ok: true,
      result: [
        {
          fileName: 'a.txt',
          relativePath: 'a.txt',
          absolutePath: 'C:/task-1/a.txt',
          mimeType: 'text/plain',
          size: 1,
          mtime: 1,
          tier: 'text',
        },
      ],
    });
    mocks.revokeTaskContextSource.mockResolvedValue({ ok: true, result: true });
    const view = render(<Harness taskId="task-1" />);
    await act(async () => void (await Promise.resolve()));
    await act(async () => void (await (view.container.querySelectorAll('button')[4] as HTMLButtonElement).click()));
    expect(view.container.querySelector('[data-testid="context"]')?.textContent).toBe('a.txt');
    await act(async () => void (await (view.container.querySelectorAll('button')[3] as HTMLButtonElement).click()));
    expect(view.container.querySelector('[data-testid="context"]')?.textContent).toBe('');
    view.unmount();
  });
});
