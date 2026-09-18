// @vitest-environment jsdom

import type { ToolCall, ToolCallStatus } from '@clawwork/shared';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => (values ? `${key}:${Object.values(values).join(':')}` : key),
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: ReactElement }) => children,
  motion: { div: 'div', span: 'span' },
}));

import ToolCallSummary from '../src/renderer/components/ToolCallSummary';
import StreamingMessage from '../src/renderer/components/StreamingMessage';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function call(id: string, name: string, status: ToolCallStatus = 'done'): ToolCall {
  return {
    id,
    name,
    status,
    startedAt: '2026-09-15T00:00:00.000Z',
    ...(status === 'running' ? {} : { completedAt: '2026-09-15T00:00:01.000Z' }),
  };
}

function render(ui: ReactElement): { container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => root.render(ui));
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe('ToolCallSummary', () => {
  it('shows one compact summary for many successful calls', () => {
    const calls = Array.from({ length: 10 }, (_, index) => call(String(index), index < 8 ? 'ls' : 'exec'));
    const { container, unmount } = render(<ToolCallSummary toolCalls={calls} />);

    expect(container.querySelectorAll('[data-testid="tool-activity-summary"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-testid="tool-call-card"]')).toHaveLength(0);
    expect(container.textContent).toContain('toolActivity.completed:10');
    unmount();
  });

  it('reveals semantic groups before raw calls', () => {
    const calls = Array.from({ length: 10 }, (_, index) => call(String(index), index < 8 ? 'ls' : 'exec'));
    const { container, unmount } = render(<ToolCallSummary toolCalls={calls} />);

    act(() => (container.querySelector('[data-testid="tool-activity-summary"]') as HTMLButtonElement).click());

    const groups = container.querySelectorAll('[data-testid^="tool-activity-group-"]');
    expect(groups).toHaveLength(2);
    expect(groups[0].textContent).toContain('toolActivity.actions.listDirectory');
    expect(groups[0].textContent).toContain('toolActivity.groupCount:8');
    expect(groups[1].textContent).toContain('toolActivity.actions.execute');
    expect(container.querySelectorAll('[data-testid="tool-call-card"]')).toHaveLength(0);
    unmount();
  });

  it('makes failures visible and opens their raw call after expanding the summary', () => {
    const { container, unmount } = render(
      <ToolCallSummary toolCalls={[call('1', 'ls'), call('2', 'exec', 'error')]} />,
    );

    const summary = container.querySelector('[data-testid="tool-activity-summary"]') as HTMLButtonElement;
    expect(summary.dataset.status).toBe('error');
    expect(summary.textContent).toContain('chatMessage.toolCallSummaryWithErrors');
    act(() => summary.click());
    expect(container.querySelectorAll('[data-testid="tool-call-card"]')).toHaveLength(1);
    unmount();
  });

  it('shows only the current semantic action while work is running', () => {
    const { container, unmount } = render(
      <ToolCallSummary toolCalls={[call('1', 'ls'), call('2', 'exec', 'running')]} />,
    );

    const summary = container.querySelector('[data-testid="tool-activity-summary"]') as HTMLButtonElement;
    expect(summary.dataset.status).toBe('running');
    expect(summary.textContent).toContain('toolActivity.running:1');
    expect(summary.textContent).toContain('toolActivity.actions.execute');
    expect(container.querySelectorAll('[data-testid="tool-call-card"]')).toHaveLength(0);
    unmount();
  });
});

/**
 * 「做了什么操作」= 网关 `item` 流里拼好的 `title`（形如 `memory_search 游戏 爆款 创作 内容`）。
 *
 * 用户原话：「回复期间显示调用了什么工具、做了什么操作很重要」。
 * 只显示 `name`（工具名）或按工具名分类的泛化文案（"执行命令"）说不出**具体在干什么**，
 * 而 `title` 是网关带参数摘要拼好的、可直接给人看的一行。
 */
describe('工具过程显示"做了什么操作"', () => {
  const TITLED = 'memory_search 游戏 爆款 创作 内容';

  it('⭐ 运行中那一行优先显示 title，不是泛化文案', () => {
    const running: ToolCall = { ...call('1', 'memory_search', 'running'), title: TITLED };
    const { container, unmount } = render(<ToolCallSummary toolCalls={[running]} />);

    const summary = container.querySelector('[data-testid="tool-activity-summary"]') as HTMLButtonElement;
    expect(summary.dataset.status).toBe('running');
    expect(summary.textContent).toContain(TITLED);
    unmount();
  });

  it('展开后的单卡标题也用 title（点开能看到具体那一条）', () => {
    const failed: ToolCall = { ...call('2', 'memory_search', 'error'), title: TITLED };
    const { container, unmount } = render(<ToolCallSummary toolCalls={[call('1', 'ls'), failed]} />);

    act(() => (container.querySelector('[data-testid="tool-activity-summary"]') as HTMLButtonElement).click());

    const card = container.querySelector('[data-testid="tool-call-card"]');
    expect(card?.textContent).toContain(TITLED);
    unmount();
  });

  it('拿不到 title 时退回工具名，不留空白', () => {
    const running: ToolCall = { ...call('1', 'exec', 'running') };
    const { container, unmount } = render(<ToolCallSummary toolCalls={[running]} />);

    expect(container.textContent).toContain('toolActivity.actions.execute');
    unmount();
  });
});

describe('StreamingMessage tool activity', () => {
  it('renders all streaming calls through one shared compact summary', () => {
    const calls = Array.from({ length: 10 }, (_, index) => call(String(index), index < 8 ? 'ls' : 'exec'));
    const { container, unmount } = render(<StreamingMessage content="" toolCalls={calls} />);

    expect(container.querySelectorAll('[data-testid="tool-activity-summary"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-testid="tool-call-card"]')).toHaveLength(0);
    expect(container.textContent).toContain('toolActivity.completed:10');
    unmount();
  });
});
