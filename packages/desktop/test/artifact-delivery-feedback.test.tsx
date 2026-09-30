// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMessageStore } from '@clawwork/core';
import type { ArtifactDeliveryFailure, ArtifactDeliverySettled, Message } from '@clawwork/shared';

const mocks = vi.hoisted(() => ({ getState: vi.fn(), toast: vi.fn() }));
vi.mock('../src/renderer/stores/messageStore', () => ({ useMessageStore: { getState: mocks.getState } }));
vi.mock('../src/renderer/lib/toast', () => ({ toast: { error: mocks.toast } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { useClaimGuardToast } from '../src/renderer/hooks/useClaimGuardToast';
import { artifactFailureContext } from '../src/renderer/lib/artifact-delivery-feedback';
import { useArtifactDeliveryStore } from '../src/renderer/stores/artifactDeliveryStore';

afterEach(() => vi.unstubAllGlobals());

describe('artifact delivery failure feedback', () => {
  it('records the preload delivery outcome and unregisters both event subscriptions on unmount', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    useArtifactDeliveryStore.setState({ settled: [] });
    let settled: ((event: ArtifactDeliverySettled) => void) | undefined;
    const cleanupSettled = vi.fn();
    const cleanupViolation = vi.fn();
    Object.defineProperty(window, 'clawwork', {
      configurable: true,
      value: {
        onArtifactDeliverySettled: (callback: typeof settled) => {
          settled = callback;
          return cleanupSettled;
        },
        onClaimViolation: () => cleanupViolation,
      },
    });
    const root = createRoot(document.createElement('div'));
    function Harness() {
      useClaimGuardToast();
      return null;
    }
    act(() => root.render(<Harness />));
    const event: ArtifactDeliverySettled = {
      taskId: 'task-1',
      sessionKey: 'session-1',
      messageId: 'persisted-1',
      status: 'failed',
    };
    act(() => settled!(event));
    expect(useArtifactDeliveryStore.getState().settled).toEqual([event]);
    act(() => settled!({ ...event, messageId: 'persisted-2', status: 'succeeded' }));
    expect(useArtifactDeliveryStore.getState().settled).toHaveLength(2);
    act(() => root.unmount());
    expect(cleanupSettled).toHaveBeenCalledTimes(1);
    expect(cleanupViolation).toHaveBeenCalledTimes(1);
    useArtifactDeliveryStore.setState({ settled: [] });
  });

  it('persists one visible system note with diagnostic code and offset without sending a model request', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const persistMessage = vi.fn(async () => ({ ok: true }));
    const store = createMessageStore({ persistMessage });
    mocks.getState.mockImplementation(store.getState);
    let callback: ((event: ArtifactDeliveryFailure) => void) | undefined;
    const sendMessage = vi.fn();
    vi.stubGlobal('clawwork', undefined);
    Object.defineProperty(window, 'clawwork', {
      configurable: true,
      value: {
        onClaimViolation: (cb: typeof callback) => {
          callback = cb;
          return () => {};
        },
        sendMessage,
      },
    });
    const container = document.createElement('div');
    const root = createRoot(container);
    function Harness() {
      useClaimGuardToast();
      return null;
    }
    act(() => root.render(<Harness />));
    const event: ArtifactDeliveryFailure = {
      taskId: 'task-1',
      sessionKey: 'session-1',
      messageId: 'assistant-1',
      missing: ['report.pptx'],
      slideFailures: [
        {
          code: 'slidegen-unparsable',
          diagnostic: {
            code: 'dsl-close-mismatch',
            offset: 34,
            detail: 'expected </Text> but found </Slide>',
          },
        },
      ],
    };
    act(() => {
      callback!(event);
      callback!(event);
    });
    const messages = store.getState().messagesByTask['task-1'];
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: 'system', sessionKey: 'session-1' });
    expect(messages[0].content).toContain('dsl-close-mismatch');
    expect(messages[0].content).toContain('34');
    expect(persistMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(artifactFailureContext(messages, 'session-1')).toContain('dsl-close-mismatch');
    expect(artifactFailureContext(messages, 'other-session')).toBe('');
    act(() => root.unmount());
  });

  it('does not replay old failures after a subsequent user turn or assistant-authored lookalike', () => {
    const makeMessage = (role: Message['role'], content: string): Message => ({
      id: role,
      taskId: 'task-1',
      sessionKey: 'session-1',
      role,
      content,
      timestamp: '2026-09-29T00:00:00.000Z',
      artifacts: [],
      toolCalls: [],
    });
    const note = makeMessage('system', '[artifact-delivery-failed]\nmissing report.pptx');
    expect(artifactFailureContext([note], 'session-1')).toContain('report.pptx');
    expect(artifactFailureContext([note, makeMessage('user', 'continue')], 'session-1')).toBe('');
    expect(artifactFailureContext([makeMessage('assistant', note.content)], 'session-1')).toBe('');
  });

  it.each([
    { docFailures: [{ code: 'request-invalid' }], expected: 'request-invalid' },
    {
      htmlFailures: [{ code: 'htmlgen-unsupported-field', field: 'sections[0].style' }],
      expected: 'sections[0].style',
    },
  ])('persists non-slide diagnostics for the next user turn: $expected', (failure) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const persistMessage = vi.fn(async () => ({ ok: true }));
    const store = createMessageStore({ persistMessage });
    mocks.getState.mockImplementation(store.getState);
    let callback: ((event: ArtifactDeliveryFailure) => void) | undefined;
    Object.defineProperty(window, 'clawwork', {
      configurable: true,
      value: {
        onClaimViolation: (cb: typeof callback) => {
          callback = cb;
          return () => {};
        },
      },
    });
    const root = createRoot(document.createElement('div'));
    function Harness() {
      useClaimGuardToast();
      return null;
    }
    act(() => root.render(<Harness />));
    act(() =>
      callback!({
        taskId: 'task-1',
        sessionKey: 'session-1',
        messageId: 'assistant-1',
        missing: [],
        ...failure,
      } as ArtifactDeliveryFailure),
    );
    const messages = store.getState().messagesByTask['task-1'] ?? [];
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('system');
    expect(persistMessage).toHaveBeenCalledTimes(1);
    expect(artifactFailureContext(messages, 'session-1')).toContain(failure.expected);
    act(() => root.unmount());
  });
});
