// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Artifact, ArtifactDeliveryActivity, ArtifactDeliveryPhase } from '@clawwork/shared';
import { useTaskStore } from '../src/renderer/stores/taskStore';
import { useFileStore } from '../src/renderer/stores/fileStore';
import { useDeliveryActivityStore } from '../src/renderer/stores/deliveryActivityStore';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

import MarkdownContent from '../src/renderer/components/MarkdownContent';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 2026-10-12 视频接入：`videogen` 卡片的**文案跟随真实交付状态**（与 docgen 五态同款，
 * DOCX-205 合同 §5.C 的延伸）。
 *
 * 视频特有的两条判据（与 docgen/htmlgen 卡**不同**，这里逐条钉住）：
 *  1. **活动帧按相位归属**：视频是脱离消息路径的后台作业（分钟级），有自己的活动帧。
 *     videogen 卡只认含 `generating-video` 相位的帧；docgen/htmlgen 卡跳过它 ——
 *     否则"文档+视频"混排消息里视频帧失败会把已交付的文档卡染成失败。
 *  2. **产物按扩展名归属**：`.mp4` 才算视频的交付物（反向：视频卡不拿 `.docx` 变绿）。
 */

const VIDEOGEN = ['```videogen', JSON.stringify({ prompt: '一只猫打盹', title: '小猫' }, null, 2), '```'].join('\n');
const DOCGEN = ['```docgen', JSON.stringify({ kind: 'docx', title: '验收文档' }, null, 2), '```'].join('\n');
const TASK = 'task-video-ui';
const MESSAGE = 'message-video-ui';

const activity = (
  status: ArtifactDeliveryActivity['status'],
  phase: ArtifactDeliveryPhase = 'generating-video',
  over: Partial<ArtifactDeliveryActivity> = {},
): ArtifactDeliveryActivity => ({
  taskId: TASK,
  sessionKey: 'session-video-ui',
  messageId: MESSAGE,
  workspaceScope: 'workspace',
  workspaceRevision: 1,
  operationId: 'op-video-ui',
  sequence: 1,
  startedAt: Date.now() - 1000,
  phase,
  status,
  ...over,
});

const registeredArtifact = (over: Partial<Artifact> = {}): Artifact => ({
  id: 'artifact-video-1',
  taskId: TASK,
  messageId: MESSAGE,
  type: 'file',
  name: '小猫.mp4',
  filePath: 'E:\\荣盈魔方工作区\\task-video-ui\\小猫.mp4',
  localPath: 'task-video-ui/小猫.mp4',
  mimeType: 'video/mp4',
  size: 4_804_785,
  createdAt: '2026-10-12T00:00:00.000Z',
  availability: 'available',
  ...over,
});

const openArtifactFile = vi.fn(async () => ({ ok: true as const }));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  useTaskStore.setState({ workspaceEpoch: 0 });
  useFileStore.setState({ artifacts: [] });
  useDeliveryActivityStore.setState({
    owner: { scope: null, revision: -1 },
    workspaceEpoch: 0,
    records: {},
    active: [],
  });
  openArtifactFile.mockClear();
  (window as unknown as { clawwork?: unknown }).clawwork = { openArtifactFile };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (window as unknown as { clawwork?: unknown }).clawwork;
});

function render(ui: ReactElement): void {
  act(() => root.render(ui));
}

const card = (): HTMLElement | null => container.querySelector('[data-testid="videogen-block"]');
const state = (): string | null => card()?.getAttribute('data-delivery-state') ?? null;

describe('videogen 卡片跟随真实交付状态', () => {
  it('围栏渲染成卡片（不是代码块 + 复制按钮）', () => {
    render(<MarkdownContent content={VIDEOGEN} taskId={TASK} messageId={MESSAGE} />);
    expect(card()).not.toBeNull();
    expect(container.querySelector('pre')).toBeNull();
  });

  it('无活动 ⇒ 待处理', () => {
    render(<MarkdownContent content={VIDEOGEN} taskId={TASK} messageId={MESSAGE} />);
    expect(state()).toBe('pending');
    expect(container.textContent).toContain('chatMessage.videogenPending');
    expect(container.querySelector('button')).toBeNull();
  });

  it('视频作业帧 active（generating-video）⇒ 正在生成', () => {
    useDeliveryActivityStore.getState().record(activity('active'), 0);
    render(<MarkdownContent content={VIDEOGEN} taskId={TASK} messageId={MESSAGE} />);
    expect(state()).toBe('generating');
    expect(container.textContent).toContain('chatMessage.videogenGenerating');
  });

  it('视频作业帧 failed ⇒ 失败；不显示成功、不给打开按钮', () => {
    useDeliveryActivityStore.getState().record(activity('failed'), 0);
    render(<MarkdownContent content={VIDEOGEN} taskId={TASK} messageId={MESSAGE} />);
    expect(state()).toBe('failed');
    expect(container.querySelector('button')).toBeNull();
  });

  it('succeeded 但没有已登记 mp4 ⇒ 未确认', () => {
    useDeliveryActivityStore.getState().record(activity('succeeded'), 0);
    render(<MarkdownContent content={VIDEOGEN} taskId={TASK} messageId={MESSAGE} />);
    expect(state()).toBe('unconfirmed');
  });

  it('succeeded + 已登记 available 的 mp4 ⇒ 已生成，按钮打开已登记那一版', async () => {
    useDeliveryActivityStore.getState().record(activity('succeeded'), 0);
    useFileStore.setState({ artifacts: [registeredArtifact()] });
    render(<MarkdownContent content={VIDEOGEN} taskId={TASK} messageId={MESSAGE} />);
    expect(state()).toBe('delivered');
    expect(container.textContent).toContain('chatMessage.videogenDelivered');
    const button = container.querySelector('button');
    await act(async () => button?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(openArtifactFile).toHaveBeenCalledWith('artifact-video-1', TASK);
  });

  it('⭐ 只有**非视频**活动帧（消息收尾帧）⇒ 视频卡不拿它当自己的状态', () => {
    useDeliveryActivityStore.getState().record(activity('succeeded', 'reconciling-artifacts'), 0);
    useFileStore.setState({ artifacts: [registeredArtifact()] });
    render(<MarkdownContent content={VIDEOGEN} taskId={TASK} messageId={MESSAGE} />);
    expect(state()).toBe('pending');
  });

  it('⭐ 产物归属：available 的 `.docx` 不算视频的交付物（不误变绿）', () => {
    useDeliveryActivityStore.getState().record(activity('succeeded'), 0);
    useFileStore.setState({
      artifacts: [registeredArtifact({ name: '验收文档.docx', mimeType: 'application/msword' })],
    });
    render(<MarkdownContent content={VIDEOGEN} taskId={TASK} messageId={MESSAGE} />);
    expect(state()).toBe('unconfirmed');
  });

  it('⭐ 混排消息：docgen 卡**跳过**视频作业帧、且不拿 mp4 当自己的交付物', () => {
    const record = useDeliveryActivityStore.getState().record;
    // 文档那条早已 succeeded（消息收尾帧），视频作业帧更晚且失败。
    record(activity('succeeded', 'generating-document', { operationId: 'op-doc', startedAt: 1 }), 0);
    record(activity('failed', 'generating-video', { operationId: 'op-vid', startedAt: 10_000 }), 0);
    useFileStore.setState({
      artifacts: [registeredArtifact({ name: '验收文档.docx' }), registeredArtifact()],
    });
    render(<MarkdownContent content={DOCGEN} taskId={TASK} messageId={MESSAGE} />);
    const docCard = container.querySelector('[data-testid="docgen-block"]');
    // 视频帧失败不染文档卡：文档卡跟随自己那条 succeeded + docx 产物 ⇒ delivered。
    expect(docCard?.getAttribute('data-delivery-state')).toBe('delivered');
  });
});
