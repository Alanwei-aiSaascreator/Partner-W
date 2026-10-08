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
  Object.assign(window, {
    clawwork: {
      listArtifacts,
      onArtifactSaved: vi.fn(() => () => {}),
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
});
