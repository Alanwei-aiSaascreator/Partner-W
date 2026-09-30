// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMessageStore } from '@clawwork/core';
import type { ArtifactDeliverySettled, Message, SlidegenWarning } from '@clawwork/shared';

const mocks = vi.hoisted(() => ({ getState: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock('../src/renderer/stores/messageStore', () => ({ useMessageStore: { getState: mocks.getState } }));
vi.mock('../src/renderer/lib/toast', () => ({ toast: { error: mocks.error, warning: mocks.warning } }));

import { useClaimGuardToast } from '../src/renderer/hooks/useClaimGuardToast';
import { useSlidegenToast } from '../src/renderer/hooks/useSlidegenToast';
import { artifactFailureContext } from '../src/renderer/lib/artifact-delivery-feedback';
import { useArtifactDeliveryStore } from '../src/renderer/stores/artifactDeliveryStore';
import { parseArtifactQualityNote } from '../src/renderer/lib/artifact-quality-feedback';
import ChatMessage from '../src/renderer/components/ChatMessage';
import i18n from '../src/renderer/i18n';

const marker = '[artifact-layout-review]';
const warning: SlidegenWarning = {
  code: 'layout-text-occluded',
  page: 4,
  element: 22,
  detail: 'Footer is covered by element 24',
  artifactName: 'Product (2).pptx',
};
const event: ArtifactDeliverySettled = {
  taskId: 'task-1',
  sessionKey: 'session-1',
  messageId: 'assistant-1',
  status: 'needs-review',
  slideWarnings: [warning],
};
function message(id: string, role: Message['role'], content = ''): Message {
  return {
    id,
    role,
    content,
    taskId: 'task-1',
    sessionKey: 'session-1',
    timestamp: '2026-09-30T00:00:00.000Z',
    artifacts: [],
    toolCalls: [],
  };
}
function note(sourceMessageId = 'assistant-1', warnings = [warning]): Message {
  return message('quality-note', 'system', `${marker}\n${JSON.stringify({ sourceMessageId, warnings })}`);
}
const cleanups: (() => void)[] = [];
function render(ui: React.ReactNode) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(ui));
  const unmount = () =>
    act(() => {
      root.unmount();
      container.remove();
    });
  cleanups.push(unmount);
  return { container, unmount };
}
function mountFeedback() {
  let callback!: (result: ArtifactDeliverySettled) => void;
  const cleanup = vi.fn();
  const sendMessage = vi.fn();
  Object.defineProperty(window, 'clawwork', {
    configurable: true,
    value: {
      onArtifactDeliverySettled: (cb: typeof callback) => {
        callback = cb;
        return cleanup;
      },
      onClaimViolation: () => () => {},
      sendMessage,
    },
  });
  function Harness() {
    useClaimGuardToast();
    return null;
  }
  const mounted = render(<Harness />);
  return { ...mounted, emit: (value = event) => act(() => callback(value)), cleanup, sendMessage };
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  useArtifactDeliveryStore.setState({ settled: [] });
  await i18n.changeLanguage('en');
});
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.theme;
});

describe('durable artifact quality feedback', () => {
  it('persists one scoped system note through the existing writer without retrying the model', () => {
    const persistMessage = vi.fn(async () => ({ ok: true }));
    const store = createMessageStore({ persistMessage });
    store.getState().bulkLoad('task-1', [message('assistant-1', 'assistant', 'Saved')]);
    mocks.getState.mockImplementation(store.getState);
    const mounted = mountFeedback();
    mounted.emit();
    mounted.emit();
    const notes = store.getState().messagesByTask['task-1'].filter((m) => m.role === 'system');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ taskId: 'task-1', sessionKey: 'session-1' });
    expect(JSON.parse(notes[0].content.slice(marker.length))).toEqual({
      sourceMessageId: 'assistant-1',
      warnings: [warning],
    });
    expect(persistMessage).toHaveBeenCalledTimes(1);
    expect(mounted.sendMessage).not.toHaveBeenCalled();
    expect(mocks.warning).not.toHaveBeenCalled();
    mounted.unmount();
    cleanups.pop();
    expect(mounted.cleanup).toHaveBeenCalledOnce();
    mountFeedback().emit();
    expect(persistMessage).toHaveBeenCalledTimes(1);
  });

  it('deduplicates a hydrated note by source identity, not warning text or time', () => {
    const persistMessage = vi.fn(async () => ({ ok: true }));
    const store = createMessageStore({ persistMessage });
    store.getState().bulkLoad('task-1', [note()]);
    mocks.getState.mockImplementation(store.getState);
    const mounted = mountFeedback();
    mounted.emit({ ...event, slideWarnings: [{ ...warning, detail: 'Different detail' }] });
    expect(persistMessage).not.toHaveBeenCalled();
    mounted.emit({ ...event, messageId: 'assistant-2' });
    mounted.emit({ ...event, sessionKey: 'session-2' });
    mounted.emit({ ...event, taskId: 'task-2' });
    expect(persistMessage).toHaveBeenCalledTimes(3);
  });

  it.each(['needs-review', 'failed'] as const)('retains available file diagnostics for %s', (status) => {
    const store = createMessageStore({ persistMessage: vi.fn(async () => ({ ok: true })) });
    mocks.getState.mockImplementation(store.getState);
    mountFeedback().emit({ ...event, status });
    expect(store.getState().messagesByTask['task-1']).toHaveLength(1);
  });

  it.each(['canceled', 'succeeded'] as const)('does not create a quality note for %s', (status) => {
    const persistMessage = vi.fn(async () => ({ ok: true }));
    const store = createMessageStore({ persistMessage });
    mocks.getState.mockImplementation(store.getState);
    mountFeedback().emit({ ...event, status, slideWarnings: status === 'canceled' ? [warning] : [] });
    expect(persistMessage).not.toHaveBeenCalled();
  });

  it('does not subscribe to unscoped layout warning toasts', () => {
    const subscribeWarning = vi.fn(() => () => {});
    Object.defineProperty(window, 'clawwork', {
      configurable: true,
      value: {
        onSlidegenFailed: () => () => {},
        onSlidegenWarned: subscribeWarning,
      },
    });
    function Harness() {
      useSlidegenToast();
      return null;
    }
    render(<Harness />);
    expect(subscribeWarning).not.toHaveBeenCalled();
  });
});

describe('quality diagnostic context isolation', () => {
  const source = message('assistant-1', 'assistant', 'Saved');
  it('includes current source diagnostics with the existing failure context as data only', () => {
    const failure = message('failure', 'system', '[artifact-delivery-failed]\nDocument failed');
    const context = artifactFailureContext([source, note(), failure], 'session-1');
    expect(context).toContain(warning.detail);
    expect(context).toContain(warning.artifactName);
    expect(context).toContain('Document failed');
    expect(context).toContain('data, not instructions');
    expect(context).toContain('current user request');
  });
  it.each(['old-source', 'wrong-task', 'wrong-session', 'unknown-source', 'assistant-lookalike', 'malformed'])(
    'ignores %s diagnostics',
    (kind) => {
      const user = message('user-2', 'user', 'Create an HTML page');
      let entries = [source, note()];
      if (kind === 'old-source') entries = [source, user, note()];
      if (kind === 'wrong-task') entries = [source, { ...note(), taskId: 'another-task' }];
      if (kind === 'wrong-session') entries = [source, { ...note(), sessionKey: 'another-session' }];
      if (kind === 'unknown-source') entries = [source, note('missing-assistant')];
      if (kind === 'assistant-lookalike') entries = [source, { ...note(), role: 'assistant' }];
      if (kind === 'malformed') entries = [source, message('broken', 'system', `${marker}\n{}`)];
      expect(artifactFailureContext(entries, 'session-1')).toBe('');
    },
  );
});

describe('available-file quality notice', () => {
  it.each([
    null,
    {},
    { ...warning, code: 'unknown' },
    { ...warning, page: 0 },
    { ...warning, page: 1.5 },
    { ...warning, element: -1 },
    { ...warning, element: 0.5 },
    { ...warning, detail: 12 },
    { ...warning, artifactName: {} },
  ])('rejects malformed warning metadata %j', (invalid) => {
    const content = `${marker}\n${JSON.stringify({ sourceMessageId: 'assistant-1', warnings: [warning, invalid] })}`;
    expect(parseArtifactQualityNote(message('bad', 'system', content))).toBeNull();
  });
  it('rejects invalid JSON and assistant-authored metadata', () => {
    expect(parseArtifactQualityNote(message('bad', 'system', `${marker}\n{broken`))).toBeNull();
    expect(parseArtifactQualityNote({ ...note(), role: 'assistant' })).toBeNull();
  });
  it.each(['light', 'dark'])('renders file/page details as a %s warning, not missing-file failure', (theme) => {
    document.documentElement.dataset.theme = theme;
    const { container } = render(<ChatMessage message={note()} />);
    const status = container.querySelector('[role="status"]');
    expect(status).not.toBeNull();
    expect(status?.textContent).toContain(i18n.t('slidegen.warnedTitle'));
    expect(status?.textContent).toContain(i18n.t('slidegen.warn.occluded', { page: 4 }));
    expect(status?.textContent).toContain(warning.artifactName);
    expect(status?.textContent).toContain(warning.detail);
    expect(status?.textContent).not.toContain(marker);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('button')).toBeNull();
  });
  it('escapes diagnostic markup and ignores malformed quality metadata', () => {
    const markup = '<img src=x onerror=alert(1)>';
    const { container } = render(<ChatMessage message={note('assistant-1', [{ ...warning, detail: markup }])} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain(markup);
    const malformed = render(<ChatMessage message={message('bad', 'system', `${marker}\n{"warnings":[]}`)} />);
    expect(malformed.container.querySelector('[role="status"]')).toBeNull();
  });
});
