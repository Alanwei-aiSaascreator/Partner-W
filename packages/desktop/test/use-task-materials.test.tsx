// @vitest-environment jsdom

import { act, useLayoutEffect, useRef, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  /**
   * ⚠️ **不是恒等桩**：把传进来的 options 也透出来。
   *    恒等的话，"到底有没有把文件名/个数交给 t" 这类断言整类失效 ——
   *    2026-09-24 在层 2 上实测栽过一次（漏掉外层 `t(...)` 而测试全绿）。
   */
  t: (key: string, options?: Record<string, unknown>) =>
    options?.fileName ? `${key}<${options.fileName}>` : options?.count !== undefined ? `${key}#${options.count}` : key,
  activeTaskId: 'task-1' as string | null,
  commitPendingTask: vi.fn(() => ({ id: 'task-created' })),
  importTaskFiles: vi.fn(),
  listImportedTaskFiles: vi.fn(),
  grantTaskContextFolder: vi.fn(),
  listTaskContextSources: vi.fn(),
  revokeTaskContextSource: vi.fn(),
  listTaskContextFiles: vi.fn(),
  toastError: vi.fn(),
  toastWarning: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mocks.t }),
}));
vi.mock('../src/renderer/lib/toast', () => ({ toast: { error: mocks.toastError, warning: mocks.toastWarning } }));

vi.mock('../src/renderer/stores/taskStore', () => ({
  useTaskStore: Object.assign(
    <T,>(selector: (state: { activeTaskId: string | null }) => T) => selector({ activeTaskId: mocks.activeTaskId }),
    {
      getState: () => ({ activeTaskId: mocks.activeTaskId, commitPendingTask: mocks.commitPendingTask }),
    },
  ),
}));

import { UnknownAgentError } from '@clawwork/core';
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

function Harness({
  taskId,
  immediateAction,
}: {
  taskId?: string | null;
  immediateAction?: 'import' | 'grant' | 'revoke' | 'list';
}) {
  const materials = useTaskMaterials(taskId);
  const actedActionRef = useRef<typeof immediateAction>(undefined);
  useLayoutEffect(() => {
    if (!immediateAction || actedActionRef.current === immediateAction) return;
    actedActionRef.current = immediateAction;
    if (immediateAction === 'import') void materials.importFiles();
    if (immediateAction === 'grant') void materials.grantFolder();
    if (immediateAction === 'revoke') void materials.revokeSource('source-task-1');
    if (immediateAction === 'list') void materials.listSourceFiles('source-task-1');
  }, [
    immediateAction,
    materials.importFiles,
    materials.grantFolder,
    materials.listSourceFiles,
    materials.revokeSource,
  ]);
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
      {/* 按**当前列表里第一份材料**取路径：用例的任务 id 不同，写死一条路径会让点击落空。 */}
      <button
        type="button"
        onClick={() =>
          materials.toggleImportedFile(materials.importedFiles[0]?.localPath ?? 'tasks/task-1/inbox/a.txt')
        }
      >
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
      {/* ⚠️ 新按钮一律**追加在最后**：上面那几条按序号取按钮（[0] import / [1] toggle /
          [2] grant / [3] revoke / [4] load source files），插在中间会把它们全部错位。 */}
      <button
        type="button"
        onClick={() =>
          materials.removeImportedFileReference(materials.importedFiles[0]?.localPath ?? 'tasks/task-1/inbox/a.txt')
        }
      >
        remove reference
      </button>
    </div>
  );
}

describe('useTaskMaterials', () => {
  beforeEach(() => {
    mocks.activeTaskId = 'task-1';
    mocks.commitPendingTask.mockReset();
    mocks.commitPendingTask.mockImplementation(() => ({ id: 'task-created' }));
    mocks.importTaskFiles.mockReset();
    mocks.listImportedTaskFiles.mockReset();
    mocks.grantTaskContextFolder.mockReset();
    mocks.listTaskContextSources.mockReset();
    mocks.revokeTaskContextSource.mockReset();
    mocks.listTaskContextFiles.mockReset();
    mocks.toastError.mockReset();
    mocks.toastWarning.mockReset();
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

  /**
   * BUG-028 的验收原句：**Conversation A 引用 file-A → 新建 B（B 中无 file-A）→ 回 A
   * （file-A 引用仍正常）**。这里钉的是"材料/引用这件事本身不跨对话"：
   * 换到 B 之后 A 的文件一个都不许在 B 的列表里；回到 A 时它照旧在、照旧能引用。
   */
  /**
   * ⭐ 2026-10-07（质量战役区 2 · P2-2）：导入侧放行 100MB、发送侧预算 18MiB ——
   * "收得下但发不出"的文件必须在**进来这一刻**点破（只提示、不拦截：
   * 用户可能就是要先挑别的再发）。
   */
  it('⭐ 导入的单文件超发送预算 ⇒ 立刻提示且照常选中（不拦、不静默）', async () => {
    mocks.listImportedTaskFiles.mockResolvedValue({ ok: true, result: [] });
    mocks.listTaskContextSources.mockResolvedValue({ ok: true, result: [] });
    mocks.importTaskFiles.mockResolvedValue({
      ok: true,
      result: {
        imported: [
          {
            fileName: 'huge.bin',
            localPath: 'tasks/task-1/inbox/huge.bin',
            mimeType: 'application/octet-stream',
            size: 19 * 1024 * 1024,
          },
        ],
        rejected: [],
      },
    });
    const view = render(<Harness taskId="task-1" />);
    await act(async () => void (await Promise.resolve()));
    const buttons = view.container.querySelectorAll('button');
    await act(async () => void (await (buttons[0] as HTMLButtonElement).click()));

    expect(mocks.toastWarning).toHaveBeenCalledWith(
      'chatInput.materialSingleTooLarge',
      expect.objectContaining({ description: 'huge.bin' }),
    );
    expect(view.container.querySelector('[data-testid="selected"]')?.textContent, '只提示，不拦截').toBe('huge.bin');
    view.unmount();
  });

  /**
   * ⭐ 2026-10-07（质量战役区 3 · 问题 6）：重载（`listImportedTaskFiles`）与在途导入的竞态。
   *
   * 列表 IPC 的响应可能**早于导入完成**（列表生成时文件还没拷完）：整表替换会把导入
   * 刚加进来、用户已经看到"本次使用"的文件当场抹掉。重载改走 `mergeImported` 后，
   * 迟到的列表只会补齐/打标，不会吞掉新文件。
   */
  it('⭐ 迟到的重载响应不许抹掉刚导入的文件（merge 而非整表替换）', async () => {
    let releaseList!: (value: unknown) => void;
    mocks.listImportedTaskFiles.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseList = resolve;
      }),
    );
    mocks.listTaskContextSources.mockResolvedValue({ ok: true, result: [] });
    mocks.importTaskFiles.mockResolvedValue({
      ok: true,
      result: {
        imported: [
          {
            fileName: 'late.txt',
            localPath: 'tasks/task-1/inbox/late.txt',
            mimeType: 'text/plain',
            size: 10,
          },
        ],
        rejected: [],
      },
    });
    const view = render(<Harness taskId="task-1" />);

    // 列表还在飞的时候，导入完成了（用户在等列表的这半秒里点了添加）
    const buttons = view.container.querySelectorAll('button');
    await act(async () => void (await (buttons[0] as HTMLButtonElement).click()));
    expect(view.container.querySelector('[data-testid="selected"]')?.textContent).toBe('late.txt');

    // 迟到的列表响应到达（它在导入之前生成 ⇒ 不含 late.txt）
    await act(async () => {
      releaseList({ ok: true, result: [] });
      await Promise.resolve();
    });

    expect(
      view.container.querySelector('[data-testid="selected"]')?.textContent,
      '迟到的列表不许抹掉刚导入的文件',
    ).toBe('late.txt');
    expect(view.container.querySelector('[data-testid="imported"]')?.textContent).toBe('late.txt');
    view.unmount();
  });

  it('⭐ A 引用的材料不会出现在 B；回到 A 时材料与引用能力都还在', async () => {
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
    mocks.listTaskContextSources.mockResolvedValue({ ok: true, result: [] });
    const view = render(<Harness taskId="task-1" />);
    await act(async () => void (await Promise.resolve()));
    act(() => (view.container.querySelectorAll('button')[1] as HTMLButtonElement).click());
    expect(view.container.querySelector('[data-testid="selected"]')?.textContent).toBe('task-1.txt');

    view.rerender(<Harness taskId="task-2" />);
    await act(async () => void (await Promise.resolve()));
    expect(view.container.querySelector('[data-testid="imported"]')?.textContent).toBe('task-2.txt');
    expect(view.container.querySelector('[data-testid="selected"]')?.textContent, 'B 里不许有 A 的引用').toBe('');

    view.rerender(<Harness taskId="task-1" />);
    await act(async () => void (await Promise.resolve()));
    expect(view.container.querySelector('[data-testid="imported"]')?.textContent).toBe('task-1.txt');
    // 引用能力照常：再点一次就能引用（引用本身不跨对话复活，但材料在）
    act(() => (view.container.querySelectorAll('button')[1] as HTMLButtonElement).click());
    expect(view.container.querySelector('[data-testid="selected"]')?.textContent).toBe('task-1.txt');
    view.unmount();
  });

  /**
   * BUG-029：移除的是**当前对话的引用**，不是材料、更不是文件。
   * 材料行里它还在（用户还能再点回来），inbox 也没被动过。
   */
  it('⭐ 移除引用：只掉"本次使用"，材料仍在，能再加回来', async () => {
    mocks.listImportedTaskFiles.mockResolvedValue({ ok: true, result: [] });
    mocks.listTaskContextSources.mockResolvedValue({ ok: true, result: [] });
    mocks.importTaskFiles.mockResolvedValue({
      ok: true,
      result: {
        imported: [{ fileName: 'a.txt', localPath: 'tasks/task-1/inbox/a.txt', mimeType: 'text/plain', size: 12 }],
        rejected: [],
      },
    });
    const view = render(<Harness taskId="task-1" />);
    await act(async () => void (await Promise.resolve()));
    const buttons = view.container.querySelectorAll('button');
    await act(async () => void (await (buttons[0] as HTMLButtonElement).click()));
    expect(view.container.querySelector('[data-testid="selected"]')?.textContent).toBe('a.txt');

    act(() => (buttons[5] as HTMLButtonElement).click()); // remove reference（追加在最后那个）
    expect(view.container.querySelector('[data-testid="selected"]')?.textContent).toBe('');
    expect(view.container.querySelector('[data-testid="imported"]')?.textContent, '材料本身还在').toBe('a.txt');
    expect(mocks.importTaskFiles, '移除引用不是重新导入').toHaveBeenCalledTimes(1);

    act(() => (buttons[1] as HTMLButtonElement).click());
    expect(view.container.querySelector('[data-testid="selected"]')?.textContent, '可以再加回来').toBe('a.txt');
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

  /**
   * ⭐ 2026-09-24（独立复核 I-3）：这条分支原来没有任何测试绑住。
   *
   * `ensureTaskId()` 在**两个调用点的 try 之外**被调，所以 core 新加的拒绝如果不在里面接住，
   * 会逃成 unhandled rejection。判据是用户可见的结果：**如实说"不在本机"**，
   * 且**一个原生选择器都不打开**（打开就等于一边说不在本机、一边又派了新任务）。
   */
  it.each(['import', 'grant'] as const)('⭐ 待发任务的助手不在本机 ⇒ 如实说明，且不打开 %s 选择器', async (action) => {
    mocks.activeTaskId = null;
    mocks.toastError.mockClear();
    mocks.importTaskFiles.mockClear();
    mocks.grantTaskContextFolder.mockClear();
    mocks.commitPendingTask.mockImplementationOnce(() => {
      throw new UnknownAgentError('team-agent-x');
    });
    const view = render(<Harness taskId={null} />);
    const buttons = view.container.querySelectorAll('button');

    const index = action === 'import' ? 0 : 2;
    await act(async () => void (await (buttons[index] as HTMLButtonElement).click()));

    expect(mocks.toastError.mock.calls[0]?.[0], '要如实说"不在本机"').toBe('errors.agentMissing');
    expect(mocks.importTaskFiles, '不许打开导入选择器').not.toHaveBeenCalled();
    expect(mocks.grantTaskContextFolder, '不许打开文件夹选择器').not.toHaveBeenCalled();
    view.unmount();
  });

  it.each(['import', 'grant'] as const)(
    'commits the pending task for an immediate %s action when task A changes to null before effects run',
    async (immediateAction) => {
      mocks.listImportedTaskFiles.mockResolvedValue({ ok: true, result: [] });
      mocks.listTaskContextSources.mockResolvedValue({ ok: true, result: [] });
      mocks.importTaskFiles.mockResolvedValue({ ok: true, result: { imported: [], rejected: [] } });
      mocks.grantTaskContextFolder.mockResolvedValue({ ok: true, result: null });
      const view = render(<Harness taskId="task-1" />);
      await act(async () => void (await Promise.resolve()));

      mocks.activeTaskId = null;
      view.rerender(<Harness taskId={null} immediateAction={immediateAction} />);
      await act(async () => void (await Promise.resolve()));

      expect(mocks.commitPendingTask).toHaveBeenCalledTimes(1);
      const action = immediateAction === 'import' ? mocks.importTaskFiles : mocks.grantTaskContextFolder;
      expect(action).toHaveBeenCalledWith('task-created');
      expect(action).not.toHaveBeenCalledWith('task-1');
      view.unmount();
    },
  );

  it.each(['import', 'grant'] as const)(
    'keeps the async %s result current after pending commit publishes the new active task',
    async (immediateAction) => {
      let resolveAction!: (value: unknown) => void;
      mocks.listImportedTaskFiles.mockResolvedValue({ ok: true, result: [] });
      mocks.listTaskContextSources.mockResolvedValue({ ok: true, result: [] });
      mocks.commitPendingTask.mockImplementation(() => {
        mocks.activeTaskId = 'task-created';
        return { id: 'task-created' };
      });
      if (immediateAction === 'import') {
        mocks.importTaskFiles.mockReturnValue(new Promise((resolve) => (resolveAction = resolve)));
        mocks.grantTaskContextFolder.mockResolvedValue({ ok: true, result: null });
      } else {
        mocks.importTaskFiles.mockResolvedValue({
          ok: true,
          result: { imported: [], rejected: [] },
        });
        mocks.grantTaskContextFolder.mockReturnValue(new Promise((resolve) => (resolveAction = resolve)));
      }

      const view = render(<Harness />);
      await act(async () => void (await Promise.resolve()));
      mocks.activeTaskId = null;
      view.rerender(<Harness immediateAction={immediateAction} />);
      await act(async () => void (await Promise.resolve()));
      view.rerender(<Harness />);

      await act(async () => {
        resolveAction(
          immediateAction === 'import'
            ? {
                ok: true,
                result: {
                  imported: [
                    {
                      fileName: 'created.txt',
                      localPath: 'tasks/task-created/inbox/created.txt',
                      mimeType: 'text/plain',
                      size: 7,
                    },
                  ],
                  rejected: [],
                },
              }
            : {
                ok: true,
                result: {
                  id: 'source-created',
                  taskId: 'task-created',
                  kind: 'folder',
                  absolutePath: 'C:/created',
                  displayName: 'Created folder',
                  createdAt: '',
                  lastSeenAt: '',
                  availability: 'available',
                },
              },
        );
        await Promise.resolve();
      });

      if (immediateAction === 'import') {
        expect(view.container.querySelector('[data-testid="imported"]')?.textContent).toBe('created.txt');
        expect(view.container.querySelector('[data-testid="selected"]')?.textContent).toBe('created.txt');
      } else {
        expect(view.container.querySelector('[data-testid="sources"]')?.textContent).toBe('Created folder');
      }
      view.unmount();
    },
  );

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

  it.each(['import', 'grant', 'revoke', 'list'] as const)(
    'uses the synchronously rendered task for an immediate %s action before passive effects run',
    async (action) => {
      mocks.listImportedTaskFiles.mockResolvedValue({ ok: true, result: [] });
      mocks.listTaskContextSources.mockResolvedValue({ ok: true, result: [] });
      mocks.importTaskFiles.mockResolvedValue({ ok: true, result: { imported: [], rejected: [] } });
      mocks.grantTaskContextFolder.mockResolvedValue({ ok: true, result: null });
      mocks.revokeTaskContextSource.mockResolvedValue({ ok: true, result: false });
      mocks.listTaskContextFiles.mockResolvedValue({ ok: true, result: [] });
      const view = render(<Harness taskId="task-1" />);
      await act(async () => void (await Promise.resolve()));

      view.rerender(<Harness taskId="task-2" immediateAction={action} />);
      await act(async () => void (await Promise.resolve()));

      const calls = {
        import: mocks.importTaskFiles,
        grant: mocks.grantTaskContextFolder,
        revoke: mocks.revokeTaskContextSource,
        list: mocks.listTaskContextFiles,
      }[action].mock.calls;
      expect(calls[0]?.[0]).toBe('task-2');
      view.unmount();
    },
  );

  /**
   * ⭐ 2026-09-24：被拒的文件必须说清**是哪个、为什么**。
   *
   * 同事的真机反馈是「添加文件或内容添加不上 → 无法操作」，而截图里只有
   * `⚠ 有 1 个文件未能添加` —— 因为界面只用了 `rejected.length`，把数据里现成的
   * `fileName` 与 `reason` 一起丢了。
   *
   * 这条钉的是**接线**：纯函数自己的测试证明不了"调用点有没有把说明传进 toast"。
   */
  it('被拒的文件要在 toast 里带上文件名与原因（不是只说"有 N 个未能添加"）', async () => {
    mocks.listTaskContextSources.mockResolvedValue({ ok: true, result: [] });
    mocks.listImportedTaskFiles.mockResolvedValue({ ok: true, result: [] });
    mocks.importTaskFiles.mockResolvedValue({
      ok: true,
      result: {
        imported: [],
        rejected: [{ fileName: '五家户外店主营品类统计.xlsx', reason: 'too-large' }],
      },
    });

    const view = render(<Harness taskId="task-1" immediateAction="import" />);
    await act(async () => void (await Promise.resolve()));

    expect(mocks.toastWarning, '确实弹了提示').toHaveBeenCalled();
    const [message, data] = mocks.toastWarning.mock.calls[0] as [string, { description?: string }];
    expect(message, '标题仍报个数').toBe('chatInput.importFilesPartiallyRejected#1');
    expect(String(data?.description), '要说清是哪个文件').toContain('五家户外店主营品类统计.xlsx');
    expect(String(data?.description), '也要说清为什么').toContain('chatInput.importRejected.tooLarge');
    view.unmount();
  });

  it('没有被拒的文件 ⇒ 不弹这个提示（别造噪音）', async () => {
    mocks.listTaskContextSources.mockResolvedValue({ ok: true, result: [] });
    mocks.listImportedTaskFiles.mockResolvedValue({ ok: true, result: [] });
    mocks.importTaskFiles.mockResolvedValue({
      ok: true,
      result: {
        imported: [{ fileName: 'ok.txt', localPath: 'tasks/task-1/inbox/ok.txt', mimeType: 'text/plain', size: 1 }],
        rejected: [],
      },
    });

    const view = render(<Harness taskId="task-1" immediateAction="import" />);
    await act(async () => void (await Promise.resolve()));

    expect(mocks.toastWarning).not.toHaveBeenCalled();
    view.unmount();
  });
});
