// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ArtifactDeliveryActivity, ArtifactDeliveryPhase } from '@clawwork/shared';
import { useTaskStore } from '../src/renderer/stores/taskStore';
import { useMessageStore } from '../src/renderer/stores/messageStore';
import { useDeliveryActivityStore } from '../src/renderer/stores/deliveryActivityStore';
import ComposerActivity from '../src/renderer/components/ComposerActivity';
import en from '../src/renderer/i18n/locales/en.json';
import zh from '../src/renderer/i18n/locales/zh.json';
import zhTW from '../src/renderer/i18n/locales/zh-TW.json';
import de from '../src/renderer/i18n/locales/de.json';
import es from '../src/renderer/i18n/locales/es.json';
import fr from '../src/renderer/i18n/locales/fr.json';
import ja from '../src/renderer/i18n/locales/ja.json';
import ko from '../src/renderer/i18n/locales/ko.json';
import pt from '../src/renderer/i18n/locales/pt.json';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const activity = (phase: ArtifactDeliveryPhase = 'downloading-media'): ArtifactDeliveryActivity => ({
  taskId: 'task',
  sessionKey: 'session',
  messageId: 'message',
  workspaceScope: 'workspace',
  workspaceRevision: 1,
  operationId: 'operation',
  sequence: 1,
  startedAt: Date.now() - 5000,
  phase,
  status: 'active',
});
let root: Root, container: HTMLDivElement;
const cancel = vi.fn();
beforeEach(() => {
  useTaskStore.setState({ activeTaskId: 'task', workspaceEpoch: 0 });
  useMessageStore.setState({ processingBySession: new Set(), activeTurnBySession: {} });
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
const render = () => act(() => root.render(<ComposerActivity sessionKey="session" onCancel={cancel} />));

it('all supported languages translate every actual delivery stage', () => {
  for (const locale of [en, zh, zhTW, de, es, fr, ja, ko, pt]) {
    expect(Object.keys(locale.chatInput.deliveryActivity).sort()).toEqual([
      'downloading-media',
      'generating-document',
      'generating-html',
      'generating-presentation',
      'reconciling-artifacts',
      'saving-artifacts',
    ]);
    expect(Object.values(locale.chatInput.deliveryActivity).every((text) => text.trim().length > 0)).toBe(true);
  }
});

it.each([
  'downloading-media',
  'generating-presentation',
  'generating-document',
  'generating-html',
  'saving-artifacts',
  'reconciling-artifacts',
] as const)('shows actual %s after the model turn finishes', (phase) => {
  useDeliveryActivityStore.getState().record(activity(phase), 0);
  render();
  expect(container.textContent).toContain(`chatInput.deliveryActivity.${phase}`);
  expect(container.querySelector('[data-testid="artifact-delivery-activity"]')).not.toBeNull();
  expect(container.querySelector('button')).toBeNull();
  expect(container.textContent).not.toContain('%');
});

it('ends the delivery row only when its actual operation terminates', () => {
  const frame = activity();
  useDeliveryActivityStore.getState().record(frame, 0);
  render();
  act(() => useDeliveryActivityStore.getState().record({ ...frame, sequence: 2, status: 'failed' }, 0));
  expect(container.querySelector('[data-testid="artifact-delivery-activity"]')).toBeNull();
});

it.each(['task', 'session', 'workspace'] as const)('hides stale activity on %s replacement', (kind) => {
  useDeliveryActivityStore.getState().record(activity(), 0);
  if (kind === 'task') useTaskStore.setState({ activeTaskId: 'replacement' });
  if (kind === 'session') useDeliveryActivityStore.setState({ active: [{ ...activity(), sessionKey: 'replacement' }] });
  if (kind === 'workspace') useTaskStore.setState({ workspaceEpoch: 1 });
  render();
  expect(container.querySelector('[data-testid="artifact-delivery-activity"]')).toBeNull();
});

it('keeps concurrent independent delivery operations visible', () => {
  useDeliveryActivityStore.getState().record(activity('downloading-media'), 0);
  useDeliveryActivityStore
    .getState()
    .record({ ...activity('generating-presentation'), operationId: 'second', messageId: 'second-message' }, 0);
  render();
  expect(container.querySelectorAll('[data-testid="artifact-delivery-activity"]')).toHaveLength(2);
});
