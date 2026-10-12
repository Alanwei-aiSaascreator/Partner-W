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
 * ⚠️ DOCX-205 合同 §5.C（2026-10-10）：`docgen` 卡片的**文案跟随真实交付状态**。
 *
 * 判据全部取自既有接线（不做新轮询、不发明布尔标记）：
 *  - 交付活动（`useDeliveryActivityStore` 的 records，按 taskId+messageId 取最新）：
 *    active ⇒ 正在生成；failed ⇒ 失败；needs-review/canceled ⇒ 未确认；
 *  - 成功 ⇒ succeeded **且**该 messageId 有 `availability: 'available'` 的**已登记**产物
 *    （`useTaskArtifacts` 实时核验），缺一不可 —— 只有这时才出现"已生成"+「打开」。
 */

const DOCGEN = ['```docgen', JSON.stringify({ kind: 'docx', title: '验收文档-205' }, null, 2), '```'].join('\n');
const TASK = 'task-205';
const MESSAGE = 'message-205';

const activity = (
  status: ArtifactDeliveryActivity['status'],
  phase: ArtifactDeliveryPhase = 'generating-document',
): ArtifactDeliveryActivity => ({
  taskId: TASK,
  sessionKey: 'session-205',
  messageId: MESSAGE,
  workspaceScope: 'workspace',
  workspaceRevision: 1,
  operationId: 'op-205',
  sequence: 1,
  startedAt: Date.now() - 1000,
  phase,
  status,
});

const registeredArtifact = (over: Partial<Artifact> = {}): Artifact => ({
  id: 'artifact-205',
  taskId: TASK,
  messageId: MESSAGE,
  type: 'file',
  name: '验收文档-205.docx',
  filePath: 'E:\\荣盈魔方工作区\\task-205\\验收文档-205.docx',
  localPath: 'task-205/验收文档-205.docx',
  mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  size: 8836,
  createdAt: '2026-10-10T00:00:00.000Z',
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
  // ⚠️ 刻意**不**提供 listArtifacts：宿主守卫会让 useTaskArtifacts 直接以 store 行落定
  //（本档测的是卡片判据本身，取数通道的实时性由 use-task-artifacts 套件另行钉住）。
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

const card = (): HTMLElement | null => container.querySelector('[data-testid="docgen-block"]');
const state = (): string | null => card()?.getAttribute('data-delivery-state') ?? null;

describe('docgen 卡片跟随真实交付状态（DOCX-205 §5.C）', () => {
  it('⭐ 无交付活动 ⇒ 待处理（不再承诺"成品见右侧「产物」"）', () => {
    render(<MarkdownContent content={DOCGEN} taskId={TASK} messageId={MESSAGE} />);
    expect(state()).toBe('pending');
    expect(container.textContent).toContain('chatMessage.docgenPending');
    expect(container.textContent).not.toContain('chatMessage.docgenDelivered');
    expect(container.querySelector('button')).toBeNull();
  });

  it('⭐ 交付流水线在跑（含 generating-document 相位）⇒ 正在生成', () => {
    useDeliveryActivityStore.getState().record(activity('active', 'generating-document'), 0);
    render(<MarkdownContent content={DOCGEN} taskId={TASK} messageId={MESSAGE} />);
    expect(state()).toBe('generating');
    expect(container.textContent).toContain('chatMessage.docgenGenerating');
  });

  it('⭐ 结算 failed ⇒ 失败（不显示成功、不给打开按钮）', () => {
    useDeliveryActivityStore.getState().record(activity('failed', 'reconciling-artifacts'), 0);
    render(<MarkdownContent content={DOCGEN} taskId={TASK} messageId={MESSAGE} />);
    expect(state()).toBe('failed');
    expect(container.textContent).toContain('chatMessage.docgenFailed');
    expect(container.querySelector('button')).toBeNull();
  });

  it.each(['needs-review', 'canceled'] as const)('⭐ 结算 %s ⇒ 未确认', (status) => {
    useDeliveryActivityStore.getState().record(activity(status, 'reconciling-artifacts'), 0);
    render(<MarkdownContent content={DOCGEN} taskId={TASK} messageId={MESSAGE} />);
    expect(state()).toBe('unconfirmed');
    expect(container.textContent).toContain('chatMessage.docgenUnconfirmed');
    expect(container.querySelector('button')).toBeNull();
  });

  it('⭐⭐ succeeded 但**没有已登记可读的产物** ⇒ 未确认（不许凭结算就变绿）', () => {
    useDeliveryActivityStore.getState().record(activity('succeeded', 'reconciling-artifacts'), 0);
    render(<MarkdownContent content={DOCGEN} taskId={TASK} messageId={MESSAGE} />);
    expect(state()).toBe('unconfirmed');
    expect(container.querySelector('button')).toBeNull();
  });

  it('⭐⭐ succeeded 但产物 availability=missing ⇒ 仍未确认（登记≠可打开）', () => {
    useDeliveryActivityStore.getState().record(activity('succeeded', 'reconciling-artifacts'), 0);
    useFileStore.setState({ artifacts: [registeredArtifact({ availability: 'missing' })] });
    render(<MarkdownContent content={DOCGEN} taskId={TASK} messageId={MESSAGE} />);
    expect(state()).toBe('unconfirmed');
    expect(container.querySelector('button')).toBeNull();
  });

  it('⭐⭐⭐ succeeded + 已登记且可读（availability=available）⇒ 已生成，按钮打开**已登记的那一版**', async () => {
    useDeliveryActivityStore.getState().record(activity('succeeded', 'reconciling-artifacts'), 0);
    useFileStore.setState({ artifacts: [registeredArtifact()] });
    render(<MarkdownContent content={DOCGEN} taskId={TASK} messageId={MESSAGE} />);
    expect(state()).toBe('delivered');
    expect(container.textContent).toContain('chatMessage.docgenDelivered');
    const button = container.querySelector('button');
    expect(button).not.toBeNull();
    await act(async () => button?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(openArtifactFile).toHaveBeenCalledWith('artifact-205', TASK);
  });

  it('⭐ 作用域不符（活动的 messageId/任务对不上）⇒ 待处理，不借别人的状态', () => {
    useDeliveryActivityStore
      .getState()
      .record({ ...activity('succeeded', 'reconciling-artifacts'), messageId: 'other' }, 0);
    useFileStore.setState({ artifacts: [registeredArtifact({ messageId: 'other' })] });
    render(<MarkdownContent content={DOCGEN} taskId={TASK} messageId={MESSAGE} />);
    expect(state()).toBe('pending');
    expect(container.querySelector('button')).toBeNull();
  });

  it('⭐ 同 message 多帧取**最新**（先 active 后 succeeded ⇒ 已生成判定走 succeeded）', () => {
    const store = useDeliveryActivityStore.getState();
    store.record({ ...activity('active'), operationId: 'op-a', startedAt: 1 }, 0);
    store.record(
      { ...activity('succeeded', 'reconciling-artifacts'), operationId: 'op-b', startedAt: 2, sequence: 2 },
      0,
    );
    useFileStore.setState({ artifacts: [registeredArtifact()] });
    render(<MarkdownContent content={DOCGEN} taskId={TASK} messageId={MESSAGE} />);
    expect(state()).toBe('delivered');
  });
});
