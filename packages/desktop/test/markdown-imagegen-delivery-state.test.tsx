// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
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
const TASK = 'task-image',
  MESSAGE = 'message-image';
const fence = (kind: string) =>
  [
    '```' + kind,
    JSON.stringify({
      operationId: 'mountain-001',
      model: 'qwen-image-plus',
      prompt: 'A mountain',
      size: '1328*1328',
      title: 'Mountain',
    }),
    '```',
  ].join('\n');
const frame = (
  status: ArtifactDeliveryActivity['status'],
  phase: ArtifactDeliveryPhase = 'generating-image',
  extra: Partial<ArtifactDeliveryActivity> = {},
): ArtifactDeliveryActivity => ({
  taskId: TASK,
  messageId: MESSAGE,
  sessionKey: 'session',
  workspaceScope: 'workspace',
  workspaceRevision: 1,
  operationId: 'image-op',
  sequence: 1,
  startedAt: 1,
  phase,
  status,
  ...extra,
});
const artifact = (name = 'image.png'): Artifact => ({
  id: name,
  taskId: TASK,
  messageId: MESSAGE,
  type: 'image',
  name,
  filePath: `C:/work/${TASK}/${name}`,
  localPath: `${TASK}/${name}`,
  mimeType: 'image/png',
  size: 100,
  createdAt: '2026-10-15T00:00:00Z',
  availability: 'available',
});
let root: Root, container: HTMLDivElement;
const open = vi.fn(async () => ({ ok: true }));
beforeEach(() => {
  useTaskStore.setState({ workspaceEpoch: 0 });
  useFileStore.setState({ artifacts: [] });
  useDeliveryActivityStore.setState({
    owner: { scope: null, revision: -1 },
    workspaceEpoch: 0,
    records: {},
    active: [],
  });
  (window as unknown as { clawwork?: unknown }).clawwork = { openArtifactFile: open };
  open.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (window as unknown as { clawwork?: unknown }).clawwork;
});
const render = (content = fence('imagegen')) =>
  act(() => root.render(<MarkdownContent content={content} taskId={TASK} messageId={MESSAGE} />));
const state = (kind = 'imagegen') =>
  container.querySelector(`[data-testid="${kind}-block"]`)?.getAttribute('data-delivery-state');
it('image fence becomes a pending artifact card without a false open action', () => {
  render();
  expect(state()).toBe('pending');
  expect(container.querySelector('pre')).toBeNull();
  expect(container.querySelector('button')).toBeNull();
});
it('image activity is generating and failure cannot expose an open button', () => {
  useDeliveryActivityStore.getState().record(frame('active'), 0);
  render();
  expect(state()).toBe('generating');
  act(() => useDeliveryActivityStore.getState().record(frame('failed', 'generating-image', { sequence: 2 }), 0));
  expect(state()).toBe('failed');
  expect(container.querySelector('button')).toBeNull();
});
it('success without a registered PNG remains unconfirmed', () => {
  useDeliveryActivityStore.getState().record(frame('succeeded'), 0);
  useFileStore.setState({ artifacts: [artifact('video.mp4'), artifact('document.docx')] });
  render();
  expect(state()).toBe('unconfirmed');
});
it('success and available PNG opens only the registered artifact', async () => {
  useDeliveryActivityStore.getState().record(frame('succeeded'), 0);
  useFileStore.setState({ artifacts: [artifact()] });
  render();
  expect(state()).toBe('delivered');
  expect(container.textContent).toContain('chatMessage.imagegenDelivered');
  await act(async () => container.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  expect(open).toHaveBeenCalledWith('image.png', TASK);
});
it('generic completion or video completion cannot turn an image card green', () => {
  useDeliveryActivityStore.getState().record(frame('succeeded', 'generating-video'), 0);
  useFileStore.setState({ artifacts: [artifact()] });
  render();
  expect(state()).toBe('pending');
});
it('late failed image job cannot contaminate delivered document and video cards', () => {
  const record = useDeliveryActivityStore.getState().record;
  record(frame('succeeded', 'generating-document', { operationId: 'doc-op', startedAt: 1 }), 0);
  record(frame('succeeded', 'generating-video', { operationId: 'video-op', startedAt: 2 }), 0);
  record(frame('failed', 'generating-image', { operationId: 'image-op', startedAt: 3 }), 0);
  useFileStore.setState({ artifacts: [artifact('document.docx'), artifact('video.mp4')] });
  render([fence('docgen'), fence('videogen'), fence('imagegen')].join('\n'));
  expect(state('docgen')).toBe('delivered');
  expect(state('videogen')).toBe('delivered');
  expect(state('imagegen')).toBe('failed');
});
it('a PNG cannot make document or video cards delivered', () => {
  const record = useDeliveryActivityStore.getState().record;
  record(frame('succeeded', 'generating-document', { operationId: 'doc' }), 0);
  record(frame('succeeded', 'generating-video', { operationId: 'vid' }), 0);
  useFileStore.setState({ artifacts: [artifact()] });
  render([fence('docgen'), fence('videogen')].join('\n'));
  expect(state('docgen')).toBe('unconfirmed');
  expect(state('videogen')).toBe('unconfirmed');
});
it('saving phase retains image attribution through observed phases', () => {
  useDeliveryActivityStore.getState().record(
    frame('succeeded', 'saving-artifacts', {
      observedPhases: [{ phase: 'generating-image', observedAt: 1, sequence: 1 }],
    }),
    0,
  );
  useFileStore.setState({ artifacts: [artifact()] });
  render();
  expect(state()).toBe('delivered');
});

it('recovered message opens the original artifact through its explicit activity reference', async () => {
  useDeliveryActivityStore.getState().record(frame('succeeded', 'generating-image', { artifactId: 'original.png' }), 0);
  useFileStore.setState({ artifacts: [{ ...artifact('original.png'), messageId: 'original-message' }] });
  render();
  expect(state()).toBe('delivered');
  await act(async () => container.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  expect(open).toHaveBeenCalledWith('original.png', TASK);
});
it.each(['wrong-task', 'missing', 'wrong-id'])(
  'recovered reference rejects %s instead of falling back to an unrelated PNG',
  (reason) => {
    useDeliveryActivityStore
      .getState()
      .record(frame('succeeded', 'generating-image', { artifactId: 'original.png' }), 0);
    const original = { ...artifact('original.png'), messageId: 'original-message' };
    if (reason === 'wrong-task') original.taskId = 'foreign-task';
    if (reason === 'missing') original.availability = 'missing';
    if (reason === 'wrong-id') original.id = 'different-id';
    useFileStore.setState({ artifacts: [original, artifact('unrelated.png')] });
    render();
    expect(state()).toBe('unconfirmed');
    expect(container.querySelector('button')).toBeNull();
  },
);
