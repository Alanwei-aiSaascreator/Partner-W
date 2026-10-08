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
import ToolCallCard from '../src/renderer/components/ToolCallCard';
// 流式那一格现在是 `AssistantBlock` 的 `state="streaming"`（`StreamingMessage` 已并入）。
import AssistantBlock from '../src/renderer/components/AssistantBlock';

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
  it('does not declare a running model turn completed just because its tools are done', () => {
    const { container, unmount } = render(<ToolCallSummary toolCalls={[call('1', 'agents_list')]} />);
    expect(container.querySelector('[data-testid="tool-activity-summary"]')?.getAttribute('data-status')).toBe(
      'running',
    );
    expect(container.textContent).toContain('toolActivity.running:1');
    expect(container.textContent).not.toContain('toolActivity.duration');
    unmount();
  });

  it.each(['', 'invalid', '2026-09-15T00:00:01.019Z'])('hides untrustworthy individual tool timing %s', (startedAt) => {
    const { container, unmount } = render(<ToolCallCard toolCall={{ ...call('1', 'agents_list'), startedAt }} />);
    expect(container.textContent).not.toMatch(/NaNs|-0\.0s|0\.0s/);
    unmount();
  });

  it('shows one compact summary for many successful calls', () => {
    const calls = Array.from({ length: 10 }, (_, index) => call(String(index), index < 8 ? 'ls' : 'exec'));
    const { container, unmount } = render(<ToolCallSummary settled toolCalls={calls} />);

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

  /**
   * ⚠️ 区1 体检 P1-1（有意反转）：已结束的消息里还在转圈的步骤原来是**硬写成 error** 的 ——
   * 用户中途取消/历史截断的一轮，重启后会看到「无法继续」+「重新尝试」，而它**从未失败**
   * （重试 = 重发 = 计费）。现在单列第三态「未收到结果」：不计失败、不给 CTA。
   */
  it('⭐ 已结束的消息里还在转圈的步骤 ⇒ 单列「未收到结果」，不写成失败、不给重试 CTA', () => {
    const onRetry = vi.fn();
    const { container, unmount } = render(
      <ToolCallSummary settled onRetry={onRetry} toolCalls={[call('1', 'sessions_spawn', 'running')]} />,
    );
    const summary = container.querySelector('[data-testid="tool-activity-summary"]') as HTMLButtonElement;

    expect(summary.dataset.status).toBe('unreported');
    expect(summary.dataset.status, '没收到结果不是失败').not.toBe('error');
    expect(summary.textContent).toContain('toolActivity.unreported:1');
    expect(container.querySelector('[data-testid="tool-unreported-reason"]')?.textContent).toBe(
      'toolActivity.noResult',
    );
    // 假失败的两个尾巴都不许出现
    expect(container.querySelector('[data-testid="tool-failure-cannot-continue"]')).toBeNull();
    expect(container.querySelector('[data-testid="tool-failure-retry"]')).toBeNull();
    expect(container.querySelector('[data-testid="tool-failure-reason"]')).toBeNull();
    unmount();
  });

  it('⭐ 拿到过结果（网关 meta 摘要）就不许说"没有返回结果"', () => {
    const withMeta: ToolCall = { ...call('1', 'sessions_spawn', 'running'), result: 'spawned 3 agents' };
    const { container, unmount } = render(<ToolCallSummary settled toolCalls={[withMeta]} />);

    expect(container.querySelector('[data-testid="tool-unreported-reason"]')?.textContent).toBe('spawned 3 agents');
    expect(container.textContent).not.toContain('toolActivity.noResult');
    unmount();
  });

  it('这一轮还在跑 ⇒ 维持 running 转圈（不能提前说"没收到结果"）', () => {
    const { container, unmount } = render(<ToolCallSummary toolCalls={[call('1', 'sessions_spawn', 'running')]} />);
    const summary = container.querySelector('[data-testid="tool-activity-summary"]') as HTMLButtonElement;

    expect(summary.dataset.status).toBe('running');
    expect(container.querySelector('[data-testid="tool-unreported-reason"]')).toBeNull();
    unmount();
  });

  /**
   * 区1 体检 P3-11：摘要收起会把整棵子树**卸载**（`AnimatePresence` 里按 `expanded` 渲染），
   * 组与单卡的开合态原来放在它们自己的 `useState` 里 —— 收起再展开就得重新一层层点开。
   * 现在两层开合态都提升到摘要（父级不卸载）。
   */
  it('⭐ 收起摘要再展开：组与单卡的开合态都保持', () => {
    const calls: ToolCall[] = [{ ...call('1', 'ls'), result: 'ok: 42 files' }, call('2', 'exec')];
    const { container, unmount } = render(<ToolCallSummary toolCalls={calls} />);
    const summary = () => container.querySelector('[data-testid="tool-activity-summary"]') as HTMLButtonElement;
    const group = () =>
      container.querySelector('[data-testid="tool-activity-group-listDirectory-done"]') as HTMLButtonElement;

    act(() => summary().click());
    act(() => group().click());
    act(() => (container.querySelector('[data-testid="tool-call-card"] button') as HTMLButtonElement).click());
    expect(container.textContent).toContain('ok: 42 files');

    act(() => summary().click()); // 收起摘要 ⇒ 子树卸载
    expect(container.textContent).not.toContain('ok: 42 files');

    act(() => summary().click()); // 再展开 ⇒ 组还开着、那张卡也还开着
    expect(container.querySelectorAll('[data-testid="tool-call-card"]')).toHaveLength(1);
    expect(container.textContent).toContain('ok: 42 files');

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
  /** 图12（2026-10-06）：title 上屏前剥掉开头的原始工具名（`memory_search` 不上屏）。 */
  const TITLED_DISPLAY = '游戏 爆款 创作 内容';

  it('⭐ 运行中那一行优先显示 title，不是泛化文案', () => {
    const running: ToolCall = { ...call('1', 'memory_search', 'running'), title: TITLED };
    const { container, unmount } = render(<ToolCallSummary toolCalls={[running]} />);

    const summary = container.querySelector('[data-testid="tool-activity-summary"]') as HTMLButtonElement;
    expect(summary.dataset.status).toBe('running');
    expect(summary.textContent).toContain(TITLED_DISPLAY);
    expect(summary.textContent).not.toContain('memory_search');
    unmount();
  });

  it('展开后的单卡标题也用 title（点开能看到具体那一条）', () => {
    const failed: ToolCall = { ...call('2', 'memory_search', 'error'), title: TITLED };
    const { container, unmount } = render(<ToolCallSummary toolCalls={[call('1', 'ls'), failed]} />);

    act(() => (container.querySelector('[data-testid="tool-activity-summary"]') as HTMLButtonElement).click());

    const card = container.querySelector('[data-testid="tool-call-card"]');
    expect(card?.textContent).toContain(TITLED_DISPLAY);
    expect(card?.textContent).not.toContain('memory_search');
    unmount();
  });

  // ⚠️ 区1 体检 P3-12b：这条原来的名字写的是「退回工具名」，断言却是**动作词**——
  //    名字说谎比没名字更糟（下一个人照着名字改代码）。按实现与图12 的口径改名并补齐断言。
  it('拿不到 title 时退回**产品化动作词**（原始工具名不上屏），不留空白', () => {
    const running: ToolCall = { ...call('1', 'memory_search', 'running') };
    const { container, unmount } = render(<ToolCallSummary toolCalls={[running]} />);

    expect(container.textContent).toContain('toolActivity.actions.search');
    expect(container.textContent).not.toContain('memory_search');
    unmount();
  });
});

describe('AssistantBlock tool activity', () => {
  it('renders all streaming calls through one shared compact summary', () => {
    const calls = Array.from({ length: 10 }, (_, index) => call(String(index), index < 8 ? 'ls' : 'exec'));
    const { container, unmount } = render(
      <AssistantBlock state="streaming" content="" toolCalls={calls} identity={{ agentName: '助手' }} />,
    );

    expect(container.querySelectorAll('[data-testid="tool-activity-summary"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-testid="tool-call-card"]')).toHaveLength(0);
    expect(container.textContent).toContain('toolActivity.running:10');
    unmount();
  });
});
