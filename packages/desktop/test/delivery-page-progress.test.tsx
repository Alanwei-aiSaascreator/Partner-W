// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ArtifactDeliveryActivity from '../src/renderer/components/ArtifactDeliveryActivity';
import { useTaskStore } from '../src/renderer/stores/taskStore';
import { useDeliveryActivityStore } from '../src/renderer/stores/deliveryActivityStore';
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, args?: Record<string, unknown>) => (args ? key + ' ' + JSON.stringify(args) : key),
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement;
const frame = (completed = 3, total = 12) => ({
  taskId: 'task',
  sessionKey: 'session',
  messageId: 'message',
  workspaceScope: 'workspace',
  workspaceRevision: 1,
  operationId: 'operation',
  sequence: 1,
  startedAt: Date.now() - 5000,
  phase: 'generating-presentation' as const,
  status: 'active' as const,
  pageProgress: { completed, total },
});
beforeEach(() => {
  useTaskStore.setState({ activeTaskId: 'task', workspaceEpoch: 0 });
  useDeliveryActivityStore.setState({
    owner: { scope: null, revision: -1 },
    workspaceEpoch: 0,
    records: {},
    active: [],
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const render = () => act(() => root.render(<ArtifactDeliveryActivity sessionKey="session" />));
it('shows measured page counts and a page progress bar while all pages still do not imply saved files', () => {
  const event = frame(12, 12);
  useDeliveryActivityStore.getState().record(event, 0);
  render();
  const progress = container.querySelector('progress')!;
  expect(progress).not.toBeNull();
  expect(progress.getAttribute('value')).toBe('12');
  expect(progress.getAttribute('max')).toBe('12');
  expect(container.textContent).toContain('chatInput.deliveryPageProgress');
  expect(container.querySelector('[data-testid="artifact-delivery-activity"]')).not.toBeNull();
  act(() =>
    useDeliveryActivityStore
      .getState()
      .record({ ...event, sequence: 2, phase: 'saving-artifacts', pageProgress: undefined }, 0),
  );
  expect(container.querySelector('progress')).toBeNull();
  expect(container.textContent).toContain('chatInput.deliveryActivity.saving-artifacts');
});
it('has no invented progress when the sender has no page measurements', () => {
  useDeliveryActivityStore.getState().record({ ...frame(), pageProgress: undefined }, 0);
  render();
  expect(container.querySelector('progress')).toBeNull();
  expect(container.textContent).not.toContain('%');
});
it.each([
  [13, 12],
  [-1, 12],
  [3, 0],
  [0.5, 12],
  [1, 201],
])('ignores malformed page progress %s/%s', (completed, total) => {
  useDeliveryActivityStore.getState().record(frame(completed, total), 0);
  render();
  expect(container.querySelector('progress')).toBeNull();
});
it('keeps captured progress immutable when sender objects change', () => {
  const event = frame();
  useDeliveryActivityStore.getState().record(event, 0);
  event.pageProgress.completed = 12;
  expect(useDeliveryActivityStore.getState().active[0]).toMatchObject({ pageProgress: { completed: 3, total: 12 } });
});
