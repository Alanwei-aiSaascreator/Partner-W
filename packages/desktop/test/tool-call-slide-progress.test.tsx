// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ToolCall } from '@clawwork/shared';
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      key === 'chatInput.deliveryPageProgress' ? 'Pages ' + values?.completed + '/' + values?.total : key,
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));
import ToolCallCard from '../src/renderer/components/ToolCallCard';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement;
const progress = {
  schemaVersion: 1 as const,
  status: 'slidegen-progress' as const,
  sourceSha256: 'a'.repeat(64),
  completed: 2,
  total: 3,
};
const call: ToolCall = { id: 'pages', name: 'exec', status: 'running', startedAt: '', slideProgress: progress };
function render(value: ToolCall) {
  act(() => root.render(<ToolCallCard toolCall={value} />));
}
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.documentElement.className = '';
});

it.each(['dark', 'light'])('shows actual known pages in %s without changing tool completion', (theme) => {
  document.documentElement.className = theme;
  render(call);
  const bar = container.querySelector('progress');
  expect(bar?.value).toBe(2);
  expect(bar?.max).toBe(3);
  expect(container.textContent).toContain('Pages 2/3');
  render({ ...call, slideProgress: { ...progress, completed: 3 } });
  expect(container.querySelector('[data-testid="tool-call-card"]')?.getAttribute('data-status')).toBe('running');
  expect(container.querySelector('[data-generation-state]')?.getAttribute('data-generation-state')).toBe('pending');
  expect(container.querySelector('progress')?.value).toBe(3);
});

it('retains background poll pages as observed history after the poll call returns', () => {
  render({
    ...call,
    name: 'process',
    status: 'done',
    args: { action: 'poll', sessionId: 'native-session' },
    result: 'actual page output\n\nProcess still running.',
  });
  expect(container.querySelector('progress')).toBeNull();
  expect(container.textContent).toContain('Pages 2/3');
  expect(container.querySelector('[data-generation-state]')?.getAttribute('data-generation-state')).toBe('settled');
});

it('retains historical page counts but stops the live bar on a terminal tool result', () => {
  render({ ...call, status: 'done', result: 'actual final report' });
  expect(container.querySelector('progress')).toBeNull();
  expect(container.textContent).toContain('Pages 2/3');
  expect(container.querySelector('[data-generation-state]')?.getAttribute('data-generation-state')).toBe('settled');
});

it.each([undefined, { ...progress, completed: 4 }, { ...progress, total: 201 }])(
  'hides missing or invalid known-page metadata',
  (slideProgress) => {
    render({ ...call, slideProgress });
    expect(container.querySelector('progress')).toBeNull();
    expect(container.textContent).not.toContain('Pages');
  },
);

it('does not keep a historical background launch live after another call confirms its process ended', () => {
  const launch = {
    ...call,
    status: 'done' as const,
    result: 'Command still running (session native-session, pid 123). Use process for follow-up.',
  };
  const terminal = {
    ...call,
    id: 'poll-terminal',
    name: 'process',
    status: 'done' as const,
    args: { action: 'poll', sessionId: 'native-session' },
    result: 'actual terminal report\n\nProcess exited with code 0.',
    slideProgress: { ...progress, completed: 3 },
  };
  act(() =>
    root.render(
      <>
        <ToolCallCard toolCall={launch} />
        <ToolCallCard toolCall={terminal} />
      </>,
    ),
  );
  expect(container.querySelectorAll('progress')).toHaveLength(0);
  expect(
    [...container.querySelectorAll('[data-generation-state]')].map((node) =>
      node.getAttribute('data-generation-state'),
    ),
  ).toEqual(['settled', 'settled']);
  expect(container.textContent).toContain('Pages 2/3');
  expect(container.textContent).toContain('Pages 3/3');
});
