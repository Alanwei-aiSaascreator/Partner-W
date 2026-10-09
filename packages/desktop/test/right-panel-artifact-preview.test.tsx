// @vitest-environment jsdom
/**
 * Task 3（WorkBuddy 产物 UI A 批）：RightPanel 的**列表 / 预览两态**。
 *
 * - 默认列表（现状不变），卡片上的预览动作进入预览态（真实 FilePreview，内容来自
 *   既有 previewArtifact/readArtifactFile 通道）；
 * - 「返回列表」回列表并复位模式；
 * - 选中 ID 不在**当前任务权威成果集合**里（跨任务残留/已删除）⇒ 不预览，回列表；
 * - 选中项 availability=missing ⇒ 不启动预览（文件已不在），回列表。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Artifact, TeamMeetingRecord } from '@clawwork/shared';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));
vi.mock('../src/renderer/lib/toast', () => ({ toast: { error: vi.fn() } }));

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
        tasks: [{ id: 'task-1', title: '当前会话' }],
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
import { requestArtifactPreview } from '../src/renderer/lib/artifact-preview-navigation';
import { useFileStore } from '../src/renderer/stores/fileStore';
import { useUiStore } from '../src/renderer/stores/uiStore';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const artifact: Artifact = {
  id: 'artifact-1',
  taskId: 'task-1',
  messageId: 'message-1',
  type: 'file',
  name: 'deck.docx',
  filePath: '',
  localPath: 'task-1/deck.docx',
  mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  size: 12,
  createdAt: '2026-10-09T08:00:00.000Z',
  availability: 'available',
};

let container: HTMLDivElement;
let root: Root;
const listArtifacts = vi.fn();
/** `artifact:saved` 的信号回调（用例里手动触发"产物刚保存"）。 */
let savedCallback: ((artifact: Artifact) => void) | null = null;

const flushFrames = async (): Promise<void> => {
  for (let i = 0; i < 3; i += 1) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
};

beforeEach(() => {
  vi.clearAllMocks();
  meetingState.records = [];
  taskState.activeTaskId = 'task-1';
  taskState.workspaceEpoch = 0;
  document.body.innerHTML = '';
  useFileStore.setState({ selectedArtifactId: null });
  useUiStore.setState({ artifactPanelMode: 'list', rightPanelOpen: true, mainView: 'chat', settingsOpen: false });
  listArtifacts.mockResolvedValue({ ok: true, result: [artifact] });
  Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: vi.fn() });
  savedCallback = null;
  Object.assign(window, {
    clawwork: {
      listArtifacts,
      onArtifactSaved: vi.fn((callback: (artifact: Artifact) => void) => {
        savedCallback = callback;
        return () => {};
      }),
      readArtifactThumbnail: vi.fn(),
      previewArtifact: vi.fn().mockResolvedValue({
        ok: true,
        result: { kind: 'docx', paragraphs: ['预览里的正文'], truncated: false },
      }),
      readArtifactFile: vi.fn(),
    },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  // ⚠️ 必须先卸载再让下一个用例改 store —— 旧 root 还订阅着 store，
  //    否则它会替新用例发起预览请求（本文件曾因此出现"越界读取"假失败）。
  act(() => root.unmount());
  container.remove();
});

describe('Task3 · RightPanel 列表/预览两态', () => {
  it('⭐ 默认列表（无预览窗格）；卡上点预览 ⇒ 进入预览态并显示真实 FilePreview；返回列表还原', async () => {
    await act(async () => root.render(<RightPanel />));
    await act(async () => {
      await flushFrames();
    });
    expect(container.querySelector('[data-testid="artifact-preview-pane"]'), '默认必须是列表').toBeNull();
    expect(container.querySelector('[data-testid="artifact-card"]')).not.toBeNull();

    const previewButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="artifact-card"] [data-action="artifact-preview"]',
    );
    expect(previewButton, '面板里的卡片也必须有预览入口').not.toBeNull();
    await act(async () => previewButton!.click());
    await act(async () => {
      await flushFrames();
    });

    const pane = container.querySelector('[data-testid="artifact-preview-pane"]');
    expect(pane, '进入预览态必须出现预览窗格').not.toBeNull();
    expect(pane!.textContent).toContain('deck.docx');
    expect(pane!.textContent, '真实 FilePreview 内容').toContain('预览里的正文');

    const back = pane!.querySelector<HTMLButtonElement>('[data-action="artifact-preview-back"]');
    expect(back).not.toBeNull();
    await act(async () => back!.click());
    expect(container.querySelector('[data-testid="artifact-preview-pane"]'), '返回列表').toBeNull();
    expect(useUiStore.getState().artifactPanelMode).toBe('list');
  });

  it('⭐ 选中 ID 不在当前任务成果集合里（跨任务残留）⇒ 不预览，显示列表', async () => {
    useFileStore.setState({ selectedArtifactId: 'ghost-from-other-task' });
    useUiStore.setState({ artifactPanelMode: 'preview' });
    await act(async () => root.render(<RightPanel />));
    await act(async () => {
      await flushFrames();
    });
    expect(container.querySelector('[data-testid="artifact-preview-pane"]')).toBeNull();
    expect(container.querySelector('[data-testid="artifact-card"]'), '列表照常在').not.toBeNull();
    // ⭐ 独立复核（2026-10-09）：解析不到必须**把模式复位回 list** —— 否则残留 'preview'
    //    会在随后窄窗 resize 时把右栏以抽屉形态弹出（幽灵弹层）。
    expect(useUiStore.getState().artifactPanelMode).toBe('list');
  });

  it('⭐ 选中项缺失（availability=missing）⇒ 不启动预览（文件已不在），回列表', async () => {
    listArtifacts.mockResolvedValue({ ok: true, result: [{ ...artifact, availability: 'missing' }] });
    useFileStore.setState({ selectedArtifactId: 'artifact-1' });
    useUiStore.setState({ artifactPanelMode: 'preview' });
    await act(async () => root.render(<RightPanel />));
    await act(async () => {
      await flushFrames();
    });
    expect(container.querySelector('[data-testid="artifact-preview-pane"]')).toBeNull();
    expect(window.clawwork.previewArtifact, 'missing 不得触发越界读取').not.toHaveBeenCalled();
    expect(useUiStore.getState().artifactPanelMode, 'missing 同样要复位回 list').toBe('list');
  });

  it('对照：requestArtifactPreview 直接调用（聊天卡路径同款）同样进入预览态', async () => {
    await act(async () => root.render(<RightPanel />));
    await act(async () => {
      await flushFrames();
    });
    await act(async () => {
      requestArtifactPreview(artifact);
    });
    await act(async () => {
      await flushFrames();
    });
    expect(container.querySelector('[data-testid="artifact-preview-pane"]')!.textContent).toContain('预览里的正文');
  });

  /**
   * ⭐ H4b（2026-10-09 复审 RED 反例）：**新卡先出现，右栏旧列表还没有它**。
   *
   * 旧实现只按「旧快照属于当前任务」就敢判"不存在" ⇒ 把这次点击清回列表。
   * 正确语义：这次选择必须等**它自己的**权威查询回答 —— 期间显示加载窗格、
   * 保持预览模式，也绝不提前读文件。
   */
  it('⭐ 旧列表 + 在途刷新时点击新卡：pending 保持，刷新回来进预览', async () => {
    // 先让面板以「旧列表 = []」加载完成（新卡刚出现、右栏还没刷到它的真实缺口场景）。
    listArtifacts.mockResolvedValue({ ok: true, result: [] });
    await act(async () => root.render(<RightPanel />));
    await act(async () => {
      await flushFrames();
    });
    expect(container.querySelector('[data-testid="artifact-card"]')).toBeNull();

    // 让下一步的权威查询悬停（模拟在途刷新）。
    let resolveList!: (value: { ok: true; result: Artifact[] }) => void;
    const delayed = new Promise<{ ok: true; result: Artifact[] }>((resolve) => {
      resolveList = resolve;
    });
    listArtifacts.mockReturnValue(delayed);

    await act(async () => {
      requestArtifactPreview(artifact);
    });

    expect(useUiStore.getState().artifactPanelMode, '旧列表没有这个 ID 不许判"不存在"').toBe('preview');
    expect(container.querySelector('[data-testid="artifact-preview-pane"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="artifact-preview-pending"]'),
      '等待自己的查询时必须是加载窗格',
    ).not.toBeNull();
    expect(container.querySelector('[data-testid="artifact-card"]'), '不能把列表误装进预览窗格').toBeNull();
    expect(window.clawwork.previewArtifact, '权威查询没回答前不许读文件').not.toHaveBeenCalled();

    await act(async () => {
      resolveList({ ok: true, result: [artifact] });
    });
    await act(async () => {
      await flushFrames();
    });
    expect(useUiStore.getState().artifactPanelMode).toBe('preview');
    expect(container.querySelector('[data-testid="artifact-preview-pane"]')!.textContent).toContain('预览里的正文');
  });

  /**
   * ⭐ H4a：unknown / unsafe 直接不给进可读预览（按钮禁用 + 不发起 IPC）。
   * unsafe 会落进「历史与问题文件」折叠区 —— 展开后按钮同样必须禁用。
   */
  it.each(['unknown', 'unsafe'] as const)(
    '⭐ availability=%s 的卡：预览按钮禁用，点击不进入可读预览、不发起 IPC',
    async (availability) => {
      listArtifacts.mockResolvedValue({ ok: true, result: [{ ...artifact, availability }] });
      await act(async () => root.render(<RightPanel />));
      await act(async () => {
        await flushFrames();
      });
      const archiveToggle = container.querySelector<HTMLButtonElement>('[data-action="toggle-artifact-archived"]');
      if (archiveToggle) await act(async () => archiveToggle.click());

      const button = container.querySelector<HTMLButtonElement>('[data-action="artifact-preview"]');
      expect(button, '卡上仍要有预览入口（只是禁用）').not.toBeNull();
      expect(button!.disabled).toBe(true);

      await act(async () => button!.click());
      await act(async () => {
        await flushFrames();
      });
      expect(window.clawwork.previewArtifact).not.toHaveBeenCalled();
      expect(container.querySelector('[data-testid="artifact-preview-pane"]')).toBeNull();
      expect(useUiStore.getState().artifactPanelMode).toBe('list');
    },
  );

  /**
   * ⭐ H4a（降级）：已显示的正文在产物刷新为不可用后**立即失效** ——
   * 不许把"那个文件"的旧正文继续挂在新的可用性状态下面。
   */
  it('⭐ available→unknown 刷新：旧正文失效、回列表、不再读文件', async () => {
    await act(async () => root.render(<RightPanel />));
    await act(async () => {
      await flushFrames();
    });
    await act(async () => {
      requestArtifactPreview(artifact);
    });
    await act(async () => {
      await flushFrames();
    });
    expect(container.textContent).toContain('预览里的正文');
    const readCalls = vi.mocked(window.clawwork.previewArtifact).mock.calls.length;

    listArtifacts.mockResolvedValue({ ok: true, result: [{ ...artifact, availability: 'unknown' }] });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="artifactCard.refresh"]')!.click();
    });
    await act(async () => {
      await flushFrames();
    });

    expect(container.textContent, '不可用之后旧正文不许继续挂在屏上').not.toContain('预览里的正文');
    expect(useUiStore.getState().artifactPanelMode, '权威答案说不可用 ⇒ 回列表').toBe('list');
    expect(vi.mocked(window.clawwork.previewArtifact).mock.calls.length, '降级后不再读文件').toBe(readCalls);
  });

  /**
   * ⭐ H4b（scope 作废）：切任务后，上一次选择的答案/正文都作废 ——
   * 新任务集合里没有这份文件时必须回列表，不许把旧任务的正文跟过来。
   */
  it('⭐ 切任务（scope 变化）⇒ 本次选择作废：旧任务的文件不许继续预览', async () => {
    await act(async () => root.render(<RightPanel />));
    await act(async () => {
      await flushFrames();
    });
    await act(async () => {
      requestArtifactPreview(artifact);
    });
    await act(async () => {
      await flushFrames();
    });
    expect(container.textContent).toContain('预览里的正文');
    const readCalls = vi.mocked(window.clawwork.previewArtifact).mock.calls.length;

    // 新任务：集合里没有这份文件。
    taskState.activeTaskId = 'task-2';
    listArtifacts.mockResolvedValue({ ok: true, result: [] });
    await act(async () => root.render(<RightPanel />));
    await act(async () => {
      await flushFrames();
    });

    expect(container.textContent, '旧任务的文件不许跟到新任务').not.toContain('预览里的正文');
    expect(useUiStore.getState().artifactPanelMode, '权威查询在新范围里说"没有" ⇒ 回列表').toBe('list');
    expect(vi.mocked(window.clawwork.previewArtifact).mock.calls.length, '作废后不再读文件').toBe(readCalls);
  });

  /**
   * ⭐ H4b（RAF 合并）：产物保存信号刚排进 RAF、还没执行时点击预览 ——
   * 那次刷新的"起点"早于这次选择，不够资格回答它；取消它、合并成这次选择自己的一次刷新。
   */
  it('⭐ artifact:saved 的 RAF 尚未执行时点击预览：合并成一次刷新（不多发一轮）', async () => {
    await act(async () => root.render(<RightPanel />));
    await act(async () => {
      await flushFrames();
    });
    const callsBefore = listArtifacts.mock.calls.length;

    await act(async () => {
      savedCallback?.(artifact); // 排进 RAF
      requestArtifactPreview(artifact); // 立刻点击：这次选择把它合并掉
    });
    await act(async () => {
      await flushFrames();
    });

    expect(useUiStore.getState().artifactPanelMode).toBe('preview');
    expect(container.querySelector('[data-testid="artifact-preview-pane"]')).not.toBeNull();
    // 一次刷新 = 两条 listArtifacts（会话内 + 全库）：只多出这一对（合并，不是两轮）。
    expect(listArtifacts.mock.calls.length).toBe(callsBefore + 2);
  });
});
