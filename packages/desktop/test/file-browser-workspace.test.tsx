// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const scope = vi.hoisted(() => ({ workspaceEpoch: 0, tasks: [], setActiveTask: vi.fn() }));
vi.mock('../src/renderer/stores/taskStore', () => ({
  useTaskStore: Object.assign((select: (s: typeof scope) => unknown) => select(scope), { getState: () => scope }),
}));
vi.mock('../src/renderer/stores/messageStore', () => ({
  useMessageStore: (select: (s: unknown) => unknown) => select({ setHighlightedMessage: vi.fn() }),
}));
vi.mock('../src/renderer/stores/uiStore', () => ({
  useUiStore: (select: (s: unknown) => unknown) => select({ setMainView: vi.fn() }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));
vi.mock('../src/renderer/components/FileCard', () => ({
  default: ({ artifact }: { artifact: { name: string } }) => <div>{artifact.name}</div>,
}));
vi.mock('../src/renderer/components/FilePreview', () => ({ default: () => <div>preview</div> }));
vi.mock('../src/renderer/layouts/FileBrowser/WorkspaceAccessSummary', () => ({ default: () => null }));
vi.mock('../src/renderer/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('../src/renderer/hooks/useResizePanel', () => ({
  useResizePanel: () => ({ width: 360, isDragging: false, handleMouseDown: vi.fn() }),
}));
vi.mock('../src/renderer/components/ContextMenu', () => ({ TaskContextMenuPopover: () => null }));
import FileBrowser from '../src/renderer/layouts/FileBrowser';
import { useFileStore } from '../src/renderer/stores/fileStore';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
function deferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
const oldArtifact = {
  id: 'old',
  name: 'old.txt',
  type: 'file',
  mimeType: 'text/plain',
  taskId: 'same-task',
  messageId: 'same-message',
  createdAt: '2026-09-30',
  size: 1,
  localPath: 'old.txt',
  filePath: '',
};
describe('FileBrowser workspace RPC ownership', () => {
  let root: Root | undefined, container: HTMLDivElement;
  let list: ReturnType<typeof vi.fn>, search: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers();
    scope.workspaceEpoch = 0;
    useFileStore.setState({
      artifacts: [],
      selectedArtifactId: null,
      searchQuery: '',
      searchResults: null,
      isSearching: false,
      typeFilter: 'all',
    });
    list = vi.fn().mockResolvedValue({ ok: true, result: [] });
    search = vi.fn();
    window.clawwork = { listArtifacts: list, searchArtifacts: search } as unknown as Window['clawwork'];
    container = document.createElement('div');
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    vi.useRealTimers();
  });
  async function render() {
    await act(async () => root!.render(<FileBrowser />));
  }
  async function query(value: string) {
    await act(async () => useFileStore.getState().setSearchQuery(value));
    await act(async () => vi.advanceTimersByTimeAsync(300));
  }
  it('ignores list success from the old workspace before React renders the reset', async () => {
    const old = deferred();
    list.mockReturnValueOnce(old.promise);
    await render();
    scope.workspaceEpoch++;
    await act(async () => old.resolve({ ok: true, result: [oldArtifact] }));
    expect(useFileStore.getState().artifacts).toEqual([]);
    await render();
    expect(list).toHaveBeenCalledTimes(2);
  });
  it('ignores search completion after the query is cleared', async () => {
    const old = deferred();
    search.mockReturnValueOnce(old.promise);
    await render();
    await query('same');
    await act(async () => useFileStore.getState().setSearchQuery(''));
    await act(async () => old.resolve({ ok: true, result: [oldArtifact] }));
    expect(useFileStore.getState().searchResults).toBeNull();
  });
  it('refetches a stale list snapshot after a live save without retaining a subsequent deletion', async () => {
    const old = deferred(),
      fresh = deferred();
    list.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    await render();
    await act(async () => useFileStore.getState().upsertArtifact(oldArtifact as never));
    await act(async () => old.resolve({ ok: true, result: [] }));
    expect(useFileStore.getState().artifacts).toEqual([oldArtifact]);
    expect(list).toHaveBeenCalledTimes(2);
    await act(async () => fresh.resolve({ ok: true, result: [] }));
    expect(useFileStore.getState().artifacts).toEqual([]);
  });
  it('shows a current list failure instead of an empty successful directory', async () => {
    list.mockResolvedValueOnce({ ok: false, error: 'current-error' });
    await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('errors.requestFailed');
    expect(container.textContent).not.toContain('common.noFiles');
    scope.workspaceEpoch++;
    await render();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain('common.noFiles');
  });
  it('shows a current thrown search error and clears it for a subsequent empty success', async () => {
    search.mockRejectedValueOnce(new Error('current-error')).mockResolvedValueOnce({ ok: true, result: [] });
    await render();
    await query('first');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('errors.requestFailed');
    expect(container.textContent).not.toContain('common.noFiles');
    await query('second');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain('common.noFiles');
  });
  it.each(['success', 'failure'] as const)(
    'ignores stale search %s when query and task ids are reused',
    async (outcome) => {
      const old = deferred(),
        current = deferred();
      search.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
      await render();
      await query('same');
      scope.workspaceEpoch++;
      await render();
      await act(async () => vi.advanceTimersByTimeAsync(300));
      await act(async () =>
        old.resolve(outcome === 'success' ? { ok: true, result: [oldArtifact] } : { ok: false, error: 'old-error' }),
      );
      expect(useFileStore.getState().isSearching).toBe(true);
      expect(useFileStore.getState().searchResults).toBeNull();
      await act(async () => current.resolve({ ok: false, error: 'current-error' }));
      expect(container.querySelector('[role="alert"]')?.textContent).toBe('errors.requestFailed');
      expect(container.textContent).not.toContain('common.noFiles');
    },
  );
});
