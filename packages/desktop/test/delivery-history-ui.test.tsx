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

it('active details expose only actually observed phases and times', () => {
  useDeliveryActivityStore.getState().record(
    {
      ...activity(),
      observedPhases: [
        { phase: 'downloading-media', observedAt: 100, sequence: 1 },
        { phase: 'saving-artifacts', observedAt: 200, sequence: 2 },
      ],
    },
    0,
  );
  render();
  expect(container.querySelector('details')).not.toBeNull();
  expect(container.querySelector('summary')?.textContent).toContain('chatInput.deliveryHistory.details');
  expect(container.querySelectorAll('li')).toHaveLength(2);
  expect(container.querySelectorAll('time')).toHaveLength(2);
  expect(container.querySelector('ol')?.textContent).toContain(
    'chatInput.deliveryHistory.phaseTypes.downloading-media',
  );
  expect(container.querySelector('ol')?.textContent).toContain('chatInput.deliveryHistory.phaseTypes.saving-artifacts');
  expect(container.querySelector('ol')?.textContent).not.toContain('chatInput.deliveryActivity.');
  expect(container.textContent).not.toContain('generating-presentation');
  expect(container.querySelector('button')).toBeNull();
});

it.each(['succeeded', 'needs-review', 'failed', 'canceled'] as const)(
  'retains the actual %s terminal result with nonnegative elapsed time',
  (status) => {
    useDeliveryActivityStore.getState().record({ ...activity(), status, startedAt: 5000, endedAt: 1000 }, 0);
    render();
    const row = container.querySelector('[data-testid="artifact-delivery-history"]');
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain('chatInput.deliveryHistory.' + status);
    expect(row?.textContent).toContain('chatInput.deliveryHistory.phaseTypes.downloading-media');
    expect(row?.textContent).toContain('0.0s');
    expect(container.querySelector('[data-testid="artifact-delivery-activity"]')).toBeNull();
  },
);

it('terminal context uses an actually observed initial action rather than an ongoing final-stage label', () => {
  useDeliveryActivityStore.getState().record(
    {
      ...activity('saving-artifacts'),
      status: 'succeeded',
      endedAt: 1000,
      observedPhases: [{ phase: 'generating-presentation', observedAt: 100, sequence: 1 }],
    },
    0,
  );
  render();
  expect(container.querySelector('summary')?.textContent).toContain(
    'chatInput.deliveryHistory.phaseTypes.generating-presentation',
  );
  expect(container.querySelector('summary')?.textContent).not.toContain('chatInput.deliveryActivity.saving-artifacts');
});

it('shows a truncation notice rather than claiming a full history', () => {
  useDeliveryActivityStore.getState().record(
    {
      ...activity(),
      historyTruncated: true,
      observedPhases: [{ phase: 'saving-artifacts', observedAt: 100, sequence: 9 }],
    },
    0,
  );
  render();
  expect(container.textContent).toContain('chatInput.deliveryHistory.truncated');
});

it('keeps only the five latest terminal summaries under a recent-history label', () => {
  for (let i = 0; i < 7; i++)
    useDeliveryActivityStore
      .getState()
      .record({ ...activity(), operationId: 'completed-' + i, status: 'failed', endedAt: i + 100 }, 0);
  render();
  expect(container.textContent).toContain('chatInput.deliveryHistory.recent');
  expect(container.querySelectorAll('[data-testid="artifact-delivery-history"]')).toHaveLength(5);
});

it.each(['task', 'session', 'workspace'] as const)('hides terminal history after %s replacement', (kind) => {
  const frame = { ...activity(), status: 'succeeded' as const, endedAt: 1000 };
  useDeliveryActivityStore.getState().record(frame, 0);
  if (kind === 'task') useTaskStore.setState({ activeTaskId: 'other' });
  if (kind === 'session')
    useDeliveryActivityStore.setState({ records: { operation: { ...frame, sessionKey: 'other' } } });
  if (kind === 'workspace') useTaskStore.setState({ workspaceEpoch: 1 });
  render();
  expect(container.querySelector('[data-testid="artifact-delivery-history"]')).toBeNull();
});

it('all supported locales have the same nonempty minimal history labels', () => {
  for (const locale of [en, zh, zhTW, de, es, fr, ja, ko, pt]) {
    const labels = (locale.chatInput as Record<string, unknown>).deliveryHistory as Record<
      string,
      string | Record<string, string>
    >;
    expect(Object.keys(labels).sort()).toEqual([
      'canceled',
      'details',
      'failed',
      'needs-review',
      'phaseTypes',
      'recent',
      'succeeded',
      'truncated',
    ]);
    expect(
      Object.values(labels)
        .filter((value) => typeof value === 'string')
        .every((value) => value.trim()),
    ).toBe(true);
    expect(Object.keys(labels.phaseTypes).sort()).toEqual(Object.keys(locale.chatInput.deliveryActivity).sort());
  }
});
