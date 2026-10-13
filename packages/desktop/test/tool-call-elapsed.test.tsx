// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolCall } from '@clawwork/shared';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => `${key}:${values?.time ?? ''}`,
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

import ToolCallCard from '../src/renderer/components/ToolCallCard';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const startedAt = '2026-10-02T00:00:00.000Z';
const running: ToolCall = { id: 'call', name: 'exec', status: 'running', startedAt };
let root: Root;
let container: HTMLDivElement;

function render(call: ToolCall) {
  act(() => root.render(<ToolCallCard toolCall={call} />));
}

function waiting() {
  return container.querySelector('[data-testid="tool-call-waiting-time"]')?.textContent ?? null;
}

describe('tool card elapsed waiting', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-02T00:00:02.200Z'));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it.each(['running', 'awaitingApproval'] as const)(
    'updates observed waiting for %s without claiming execution duration',
    (status) => {
      render({ ...running, status });
      expect(waiting()).toBe('toolActivity.waitingElapsed:2.2s');
      act(() => vi.advanceTimersByTime(3000));
      expect(waiting()).toBe('toolActivity.waitingElapsed:5.2s');
      expect(container.textContent).not.toContain('0.0s');
      if (status === 'awaitingApproval') expect(container.querySelector('.glow-running')).toBeNull();
    },
  );

  it.each(['', 'invalid', '2026-10-02T00:00:50.000Z'])('hides unknown or future starts %s', (start) => {
    render({ ...running, startedAt: start });
    expect(waiting()).toBeNull();
    expect(container.textContent).not.toMatch(/NaNs|-0\.0s|0\.0s/);
    act(() => vi.advanceTimersByTime(1000));
    expect(waiting()).toBeNull();
  });

  it('does not restart waiting when tool title updates or the card remounts', () => {
    render(running);
    act(() => vi.advanceTimersByTime(5000));
    render({ ...running, title: 'generate presentation' });
    expect(waiting()).toBe('toolActivity.waitingElapsed:7.2s');
    act(() => root.unmount());
    root = createRoot(container);
    render(running);
    expect(waiting()).toBe('toolActivity.waitingElapsed:7.2s');
  });

  it.each(['done', 'error'] as const)('freezes the actual interval when the tool becomes %s', (status) => {
    render(running);
    act(() => vi.advanceTimersByTime(3000));
    render({ ...running, status, completedAt: '2026-10-02T00:00:04.800Z' });
    expect(waiting()).toBeNull();
    expect(container.textContent).toContain('4.8s');
    act(() => vi.advanceTimersByTime(8000));
    expect(container.textContent).toContain('4.8s');
  });

  it('does not invent a completion interval when the ending timestamp is missing', () => {
    render({ ...running, status: 'done' });
    expect(waiting()).toBeNull();
    expect(container.textContent).not.toMatch(/\d+\.\d+s/);
  });

  it('distinguishes genuinely short completion from unknown timing', () => {
    render({ ...running, status: 'done', completedAt: '2026-10-02T00:00:00.020Z' });
    expect(container.textContent).toContain('<0.1s');
  });

  /**
   * V1（2026-10-13）：`declared`（模型声明、无执行证据）**不显示等待耗时**——
   * 计时器只在"确认在跑/等人"时挂；声明不是执行，计时就是在编开始时间。
   */
  it('⭐ declared（声明）不显示等待耗时，也不随时间走动', () => {
    render({ id: 'call', name: 'exec', status: 'declared', startedAt: '' });

    expect(waiting(), '声明无开始时间 ⇒ 无等待耗时').toBeNull();
    act(() => vi.advanceTimersByTime(3000));
    expect(waiting()).toBeNull();
    expect(container.textContent).not.toMatch(/\d+\.\d+s/);
  });
});
