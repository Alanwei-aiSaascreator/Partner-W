// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Artifact, TeamMeetingRecord } from '@clawwork/shared';
import { toast } from '../src/renderer/lib/toast';
vi.mock('../src/renderer/lib/toast', () => ({ toast: { error: vi.fn() } }));

vi.mock('react-i18next', () => ({
  // ⚠️ 把插值参数也渲染出来：否则"还有 {{count}} 条"这类文案**数字看不见**，
  //    测试只能断言"那句话在"，而它到底报了几条谁也说不准（本仓栽过"存在性断言绑不住值"）。
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key}(${Object.values(params).join(',')})` : key),
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));
const { setActiveTaskSpy, taskState } = vi.hoisted(() => ({
  setActiveTaskSpy: vi.fn(),
  taskState: { activeTaskId: 'task-1' as string | null, workspaceEpoch: 0 },
}));
const meetingState = vi.hoisted(() => ({ records: [] as TeamMeetingRecord[] }));
vi.mock('../src/renderer/features/team-meeting/instance', () => ({
  useTeamMeetingStore: (selector: (state: typeof meetingState) => unknown) => selector(meetingState),
}));

vi.mock('../src/renderer/stores/taskStore', () => ({
  useTaskStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({
        activeTaskId: taskState.activeTaskId,
        workspaceEpoch: taskState.workspaceEpoch,
        // 历史产物那一块要拿会话标题（跳回来源会话时用户得知道跳到哪）
        tasks: [
          { id: 'task-1', title: '当前会话' },
          { id: 'task-2', title: '上一个会话' },
        ],
        setActiveTask: setActiveTaskSpy,
      }),
    { getState: () => taskState },
  ),
}));
vi.mock('../src/renderer/stores/messageStore', () => ({
  useMessageStore: (selector: (state: { setHighlightedMessage: () => void }) => unknown) =>
    selector({ setHighlightedMessage: vi.fn() }),
}));
vi.mock('../src/renderer/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import RightPanel from '../src/renderer/layouts/RightPanel';
import { useFileStore } from '../src/renderer/stores/fileStore';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const artifact: Artifact = {
  id: 'artifact-1',
  taskId: 'task-1',
  messageId: 'message-1',
  type: 'file',
  name: 'report.txt',
  filePath: '',
  localPath: 'task-1/report.txt',
  mimeType: 'text/plain',
  size: 12,
  createdAt: '2026-09-16T08:00:00.000Z',
  availability: 'available',
};

describe('RightPanel artifacts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    meetingState.records = [];
    taskState.activeTaskId = 'task-1';
    taskState.workspaceEpoch = 0;
    document.body.innerHTML = '';
    useFileStore.setState({ selectedArtifactId: null });
  });

  it('hides current and historical files when the workspace changes but task ids are reused', async () => {
    const oldHistory = { ...artifact, id: 'old-history', taskId: 'task-2', name: 'old-workspace.txt' };
    const listArtifacts = vi.fn().mockResolvedValue({ ok: true, result: [artifact, oldHistory] });
    Object.assign(window, {
      clawwork: { listArtifacts, onArtifactSaved: vi.fn(() => () => {}), readArtifactThumbnail: vi.fn() },
    });
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => root.render(<RightPanel />));
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-action="toggle-artifact-history"]')!.click(),
    );
    expect(container.textContent).toContain('old-workspace.txt');
    taskState.workspaceEpoch++;
    listArtifacts.mockRejectedValue(new Error('new workspace unavailable'));
    await act(async () => root.render(<RightPanel />));
    expect(container.textContent).not.toContain('report.txt');
    expect(container.textContent).not.toContain('old-workspace.txt');
    expect(toast.error).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });

  it.each(['success', 'error'])('ignores an old workspace %s before React has rendered the reset', async (outcome) => {
    let resolveOld!: (value: { ok: boolean; result: Artifact[] }) => void;
    let rejectOld!: (error: Error) => void;
    const listArtifacts = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, result: [] })
      .mockImplementationOnce(
        () =>
          new Promise((resolve, reject) => {
            resolveOld = resolve;
            rejectOld = reject;
          }),
      )
      .mockResolvedValue({ ok: true, result: [] });
    Object.assign(window, { clawwork: { listArtifacts, onArtifactSaved: vi.fn(() => () => {}) } });
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => root.render(<RightPanel />));
    taskState.workspaceEpoch++;
    await act(async () => {
      if (outcome === 'error') rejectOld(new Error('old workspace disconnected'));
      else resolveOld({ ok: true, result: [{ ...artifact, taskId: 'task-2' }] });
    });
    expect(toast.error).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('report.txt');
    expect(container.querySelector('[data-testid="artifact-history"]')).toBeNull();
    await act(async () => root.render(<RightPanel />));
    act(() => root.unmount());
  });

  it('shows all meeting stage artifacts once while preserving original source tasks', async () => {
    meetingState.records = [
      {
        id: 'meeting-a',
        ownerTaskId: 'task-1',
        turns: [{ taskId: 'task-1' }, { taskId: 'task-2' }, { taskId: 'task-3' }],
      } as TeamMeetingRecord,
    ];
    const child = { ...artifact, id: 'child', taskId: 'task-2', name: 'review.docx' };
    const unrelated = { ...artifact, id: 'unrelated', taskId: 'other', name: 'unrelated.txt' };
    const listArtifacts = vi.fn(async (taskId?: string) => ({
      ok: true,
      result: taskId ? [artifact] : [artifact, child, child, unrelated],
    }));
    Object.assign(window, {
      clawwork: { listArtifacts, onArtifactSaved: vi.fn(() => () => {}), readArtifactThumbnail: vi.fn() },
    });
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => root.render(<RightPanel />));
    expect(container.textContent).toContain('review.docx');
    expect(container.textContent?.match(/review\.docx/g)).toHaveLength(1);
    expect(container.textContent).not.toContain('unrelated.txt');
    expect(container.querySelector('[data-meeting-source="task-2"]')).not.toBeNull();
    act(() => root.unmount());
  });

  it('allows refreshing historical files without an active task', async () => {
    taskState.activeTaskId = null;
    const listArtifacts = vi.fn(async () => ({ ok: true, result: [artifact] }));
    Object.assign(window, { clawwork: { listArtifacts, onArtifactSaved: vi.fn(() => () => {}) } });
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => root.render(<RightPanel />));
    const refresh = container.querySelector<HTMLButtonElement>('[aria-label="artifactCard.refresh"]')!;
    expect(refresh.disabled).toBe(false);
    await act(async () => refresh.click());
    expect(listArtifacts).toHaveBeenCalledTimes(2);
    expect(listArtifacts).toHaveBeenLastCalledWith();
    act(() => root.unmount());
  });

  it('never displays previous-task artifacts after switching when refresh fails', async () => {
    const listArtifacts = vi.fn(async () => ({ ok: true, result: [artifact] }));
    Object.assign(window, {
      clawwork: { listArtifacts, onArtifactSaved: vi.fn(() => () => {}), readArtifactThumbnail: vi.fn() },
    });
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => root.render(<RightPanel />));
    expect(container.textContent).toContain('report.txt');
    taskState.activeTaskId = null;
    listArtifacts.mockRejectedValue(new Error('offline'));
    await act(async () => root.render(<RightPanel />));
    expect(container.textContent).not.toContain('report.txt');
    expect(container.querySelector<HTMLButtonElement>('[aria-label="artifactCard.refresh"]')?.disabled).toBe(false);
    act(() => root.unmount());
  });

  it('ignores a late response from the previous task after the next task has loaded', async () => {
    let resolveOld!: (value: { ok: boolean; result: Artifact[] }) => void;
    const next = { ...artifact, id: 'next', taskId: 'task-2', name: 'next-report.txt' };
    const listArtifacts = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValueOnce({ ok: true, result: [] })
      .mockResolvedValue({ ok: true, result: [next] });
    Object.assign(window, {
      clawwork: { listArtifacts, onArtifactSaved: vi.fn(() => () => {}), readArtifactThumbnail: vi.fn() },
    });
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => root.render(<RightPanel />));
    taskState.activeTaskId = 'task-2';
    await act(async () => root.render(<RightPanel />));
    expect(container.textContent).toContain('next-report.txt');
    await act(async () => resolveOld({ ok: true, result: [{ ...artifact, name: 'stale-report.txt' }] }));
    expect(container.textContent).toContain('next-report.txt');
    expect(container.textContent).not.toContain('stale-report.txt');
    expect(container.querySelector<HTMLButtonElement>('[aria-label="artifactCard.refresh"]')?.disabled).toBe(false);
    act(() => root.unmount());
  });

  it('refreshes the list and displays a newly missing file state', async () => {
    // ⚠️ 每次刷新**查两条**：会话内（带 taskId）与全库（不带，历史产物用）。
    //    所以这里给"前两次"（= 挂载那一次的两个查询）喂可用态，其后一律喂缺失态。
    const listArtifacts = vi
      .fn()
      .mockResolvedValue({ ok: true, result: [{ ...artifact, availability: 'missing' }] })
      .mockResolvedValueOnce({ ok: true, result: [artifact] })
      .mockResolvedValueOnce({ ok: true, result: [artifact] });
    Object.assign(window, {
      clawwork: {
        listArtifacts,
        onArtifactSaved: vi.fn(() => () => undefined),
        readArtifactThumbnail: vi.fn(),
        saveArtifactAs: vi.fn(),
        openArtifactFile: vi.fn(),
        showArtifactInFolder: vi.fn(),
      },
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(<RightPanel />));

    expect(container.textContent).toContain('report.txt');
    const refresh = container.querySelector<HTMLButtonElement>('[aria-label="artifactCard.refresh"]');
    expect(refresh).not.toBeNull();
    await act(async () => refresh?.click());
    expect(container.textContent).toContain('artifactCard.missing');
    // 两条查询都要发出去：会话内那条带 id，全库那条不带（历史产物就是靠它）
    expect(listArtifacts.mock.calls.some(([taskId]) => taskId === 'task-1')).toBe(true);
    expect(listArtifacts.mock.calls.some(([taskId]) => taskId === undefined)).toBe(true);

    act(() => root.unmount());
    container.remove();
  });

  it('marks the selected artifact from the active task in the rendered list', async () => {
    const newestArtifact = {
      ...artifact,
      id: 'artifact-newest',
      name: 'latest-report.txt',
      createdAt: '2026-09-17T08:00:00.000Z',
    };
    useFileStore.setState({ selectedArtifactId: newestArtifact.id });
    Object.assign(window, {
      clawwork: {
        listArtifacts: vi.fn(async () => ({ ok: true, result: [artifact, newestArtifact] })),
        onArtifactSaved: vi.fn(() => () => undefined),
        readArtifactThumbnail: vi.fn(),
        saveArtifactAs: vi.fn(),
        openArtifactFile: vi.fn(),
        showArtifactInFolder: vi.fn(),
      },
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(<RightPanel />));

    const selected = container.querySelector('[aria-current="true"]');
    expect(selected).not.toBeNull();
    expect(selected?.textContent).toContain('latest-report.txt');
    expect(selected?.classList.contains('border-[var(--border-accent)]')).toBe(true);

    act(() => root.unmount());
    container.remove();
  });

  it('refreshes same-id metadata when a reconciliation update arrives through artifact:saved', async () => {
    let saved: ((value: Artifact) => void) | undefined;
    let current = artifact;
    const listArtifacts = vi.fn(async () => ({ ok: true, result: [current] }));
    Object.assign(window, {
      clawwork: {
        listArtifacts,
        onArtifactSaved: (callback: typeof saved) => {
          saved = callback;
          return () => {};
        },
        readArtifactThumbnail: vi.fn(),
        saveArtifactAs: vi.fn(),
        openArtifactFile: vi.fn(),
        showArtifactInFolder: vi.fn(),
      },
    });
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => root.render(<RightPanel />));
    expect(container.textContent).toContain('report.txt');
    current = { ...artifact, name: 'updated-report.txt', availability: 'missing' };
    await act(async () => saved!(current));
    expect(container.textContent).toContain('updated-report.txt');
    expect(container.textContent).toContain('artifactCard.missing');
    expect(listArtifacts).toHaveBeenCalledTimes(4);
    act(() => root.unmount());
  });

  it('does not mark an artifact selected when the selected id belongs to another task', async () => {
    useFileStore.setState({ selectedArtifactId: 'external-artifact' });
    const externalArtifact = {
      ...artifact,
      id: 'external-artifact',
      taskId: 'task-2',
      name: 'external-report.txt',
    };
    Object.assign(window, {
      clawwork: {
        listArtifacts: vi.fn(async () => ({ ok: true, result: [artifact, externalArtifact] })),
        onArtifactSaved: vi.fn(() => () => undefined),
        readArtifactThumbnail: vi.fn(),
        saveArtifactAs: vi.fn(),
        openArtifactFile: vi.fn(),
        showArtifactInFolder: vi.fn(),
      },
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(<RightPanel />));

    expect(container.querySelector('[aria-current="true"]')).toBeNull();

    act(() => root.unmount());
    container.remove();
  });

  /**
   * 历史产物（2026-09-26，用户点名的"产物列表跨对话记忆"）。
   *
   * 改之前：右侧面板只查 `activeTaskId` ⇒ 新会话里**看不到**上一个会话产出的东西。
   * ⚠️ 这东西**不是**"把别的会话的产物塞进主列表"——主列表必须仍然只是当前会话的，
   *    否则上面那条"别的任务的产物不高亮"的判据就自相矛盾了。
   */
  describe('历史产物（跨会话）', () => {
    const otherTaskArtifact: Artifact = {
      ...artifact,
      id: 'artifact-2',
      taskId: 'task-2',
      messageId: 'message-2',
      name: '上次做的报告.pptx',
    };

    const renderWith = async (artifacts: Artifact[]) => {
      Object.assign(window, {
        clawwork: {
          listArtifacts: vi.fn(async () => ({ ok: true, result: artifacts })),
          onArtifactSaved: vi.fn(() => () => undefined),
          readArtifactThumbnail: vi.fn(),
          saveArtifactAs: vi.fn(),
          openArtifactFile: vi.fn(),
          showArtifactInFolder: vi.fn(),
        },
      });
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      await act(async () => root.render(<RightPanel />));
      return { container, root };
    };

    it('⭐ 默认折叠：区块在，但别的会话的产物**不摊开**', async () => {
      const { container, root } = await renderWith([artifact, otherTaskArtifact]);

      expect(container.querySelector('[data-testid="artifact-history"]')).not.toBeNull();
      expect(container.querySelector('[data-action="toggle-artifact-history"]')?.getAttribute('aria-expanded')).toBe(
        'false',
      );
      expect(container.querySelector('[data-history-task]')).toBeNull();

      act(() => root.unmount());
      container.remove();
    });

    it('⭐ 展开后按来源会话分组，且当前会话的产物**只在主列表里出现一次**', async () => {
      const { container, root } = await renderWith([artifact, otherTaskArtifact]);

      act(() => {
        (container.querySelector('[data-action="toggle-artifact-history"]') as HTMLElement).click();
      });

      expect(container.querySelector('[data-history-task="task-2"]')).not.toBeNull();
      expect(container.querySelector('[data-history-task="task-1"]'), '当前会话不进历史区').toBeNull();
      expect(container.textContent).toContain('上一个会话');
      expect(container.textContent).toContain('上次做的报告.pptx');

      act(() => root.unmount());
      container.remove();
    });

    it('⭐ 点来源会话 ⇒ 跳回那个会话', async () => {
      const { container, root } = await renderWith([artifact, otherTaskArtifact]);

      act(() => {
        (container.querySelector('[data-action="toggle-artifact-history"]') as HTMLElement).click();
      });
      act(() => {
        (container.querySelector('[data-action="jump-to-task"]') as HTMLElement).click();
      });

      expect(setActiveTaskSpy).toHaveBeenCalledWith('task-2');

      act(() => root.unmount());
      container.remove();
    });

    it('⭐ 超过上限：只列 50 条，并把"还有几条"**说出来**（不许悄悄消失）', async () => {
      const many = Array.from({ length: 53 }, (_, i) => ({
        ...artifact,
        id: `h-${i}`,
        taskId: 'task-2',
        messageId: `m-${i}`,
        name: `历史-${i}.txt`,
        createdAt: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(),
      }));
      const { container, root } = await renderWith(many);

      act(() => {
        (container.querySelector('[data-action="toggle-artifact-history"]') as HTMLElement).click();
      });

      expect(container.querySelectorAll('[data-history-task="task-2"] [data-testid="artifact-card"]')).toHaveLength(50);
      expect(container.textContent, '还剩 3 条要说出来').toContain('rightPanel.historyMore(3)');

      act(() => root.unmount());
      container.remove();
    });

    it('没有历史 ⇒ 整块不渲染（不给新用户看一个空框）', async () => {
      const { container, root } = await renderWith([artifact]);

      expect(container.querySelector('[data-testid="artifact-history"]')).toBeNull();

      act(() => root.unmount());
      container.remove();
    });
  });
});
