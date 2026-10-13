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

  // ⚠️ 2026-10-08 平铺改造（有意改写）：原「先看语义分组、展开组行才看到单卡」的断言反转 ——
  //    分组折叠已取消，工具行按**原始调用顺序**平铺；运行期（settled=false）不点击即可见。
  it('运行期平铺：按原始调用顺序直接展示工具行，不再有分组层', () => {
    const calls = Array.from({ length: 10 }, (_, index) => call(String(index), index < 8 ? 'ls' : 'exec'));
    const { container, unmount } = render(<ToolCallSummary toolCalls={calls} />);

    expect(container.querySelectorAll('[data-testid^="tool-activity-group-"]')).toHaveLength(0);
    const cards = [...container.querySelectorAll('[data-testid="tool-call-card"]')];
    expect(cards).toHaveLength(10);
    expect(cards.slice(0, 8).every((card) => card.textContent?.includes('toolActivity.actions.listDirectory'))).toBe(
      true,
    );
    expect(cards.slice(8).every((card) => card.textContent?.includes('toolActivity.actions.execute'))).toBe(true);
    unmount();
  });

  // ⚠️ 2026-10-08 平铺改造（有意改写）：原断言要求"点开摘要才看到失败的那一次调用"，
  //    现在未确认失败**强制可见**（forcedOpen）——失败不该藏在任何一次点击后面。
  it('⭐ 未确认失败：不展开摘要就能看到失败的工具行与失败说明', () => {
    const { container, unmount } = render(
      <ToolCallSummary toolCalls={[call('1', 'ls'), call('2', 'exec', 'error')]} />,
    );

    const summary = container.querySelector('[data-testid="tool-activity-summary"]') as HTMLButtonElement;
    expect(summary.dataset.status).toBe('error');
    expect(summary.textContent).toContain('chatMessage.toolCallSummaryWithErrors');
    expect(container.querySelectorAll('[data-testid="tool-call-card"]')).toHaveLength(2);
    expect(container.querySelector('[data-testid="tool-call-card"][data-status="error"]')).not.toBeNull();
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
   * 单卡的开合态原来放在组件自己的 `useState` 里 —— 收起再展开就得重新一层层点开。
   * 现在单卡开合态提升到摘要（父级不卸载）。
   *
   * ⚠️ 2026-10-08 平铺改造（有意改写）：组行消失，只剩"单卡"这一层开合态需要保持；
   *    成功态（settled + 全成功）才允许折叠，且展开一次就是**平铺全见**（不再有第二/三层）。
   */
  it('⭐ 收起摘要再展开：单卡的开合态保持', () => {
    const calls: ToolCall[] = [{ ...call('1', 'ls'), result: 'ok: 42 files' }, call('2', 'exec')];
    const { container, unmount } = render(<ToolCallSummary settled toolCalls={calls} />);
    const summary = () => container.querySelector('[data-testid="tool-activity-summary"]') as HTMLButtonElement;
    const firstCard = () => container.querySelector('[data-testid="tool-call-card"]') as HTMLElement;

    expect(container.querySelectorAll('[data-testid="tool-call-card"]'), '全成功才允许默认折叠').toHaveLength(0);
    act(() => summary().click()); // 一层展开：平铺全部工具行
    expect(container.querySelectorAll('[data-testid="tool-call-card"]')).toHaveLength(2);
    expect(container.textContent).not.toContain('ok: 42 files');

    act(() => (firstCard().querySelector('button') as HTMLButtonElement).click()); // 打开第一张卡的详情
    expect(container.textContent).toContain('ok: 42 files');

    act(() => summary().click()); // 收起摘要 ⇒ 子树卸载
    expect(container.textContent).not.toContain('ok: 42 files');

    act(() => summary().click()); // 再展开 ⇒ 那张卡还开着
    expect(container.querySelectorAll('[data-testid="tool-call-card"]')).toHaveLength(2);
    expect(container.textContent).toContain('ok: 42 files');

    unmount();
  });

  // ⚠️ 2026-10-08 平铺改造（有意改写）：原断言"运行中只有摘要行、0 张单卡"反转 ——
  //    运行期必须平铺可见（用户要看得到"每一步在干什么"），摘要行仍给"正在做什么"。
  it('运行中：摘要行说明"正在做什么"，同时工具行已平铺可见', () => {
    const { container, unmount } = render(
      <ToolCallSummary toolCalls={[call('1', 'ls'), call('2', 'exec', 'running')]} />,
    );

    const summary = container.querySelector('[data-testid="tool-activity-summary"]') as HTMLButtonElement;
    expect(summary.dataset.status).toBe('running');
    expect(summary.textContent).toContain('toolActivity.running:1');
    expect(summary.textContent).toContain('toolActivity.actions.execute');
    expect(container.querySelectorAll('[data-testid="tool-call-card"]'), '运行期平铺可见').toHaveLength(2);
    unmount();
  });
});

/**
 * ⚠️ R6（2026-10-08 总审 · CHANGES REQUIRED）：混合成功/失败必须**有确认入口**。
 *
 * 旧行为：`forcedOpen` 由 `hasFailures && !acknowledged` 驱动，但「跳过这个失败」只在 stopped
 * （一步都没成功）分支渲染 ⇒「成功 + 失败 + 已结束」永远收不起来（强制可见却没有确认路径）。
 * 修：**所有 settled 且未确认的失败**都给确认入口；重试按钮沿用既有条件（不加不减）；
 * 确认只对**点下去那一刻的那批失败**有效 —— 新失败到来必须重新强制可见。
 */
describe('R6 · 混合成功/失败的确认入口与确认失效', () => {
  it('⭐ settled 混合（成功+失败）⇒ 有「跳过这个失败」；确认后可收成一层，失败事实仍可展开', () => {
    const toolCalls: ToolCall[] = [call('1', 'read'), call('2', 'exec', 'error')];
    const { container, unmount } = render(<ToolCallSummary settled toolCalls={toolCalls} />);

    expect(container.querySelectorAll('[data-testid="tool-call-card"]')).toHaveLength(2);
    const skip = container.querySelector('[data-testid="tool-failure-continue"]') as HTMLButtonElement;
    expect(skip, '混合结果也要给确认入口').not.toBeNull();

    act(() => skip.click());
    expect(container.querySelectorAll('[data-testid="tool-call-card"]'), '确认后允许收成一层').toHaveLength(0);

    act(() => (container.querySelector('[data-testid="tool-activity-summary"]') as HTMLButtonElement).click());
    expect(
      container.querySelectorAll('[data-testid="tool-call-card"][data-status="error"]'),
      '失败事实仍可展开查到',
    ).toHaveLength(1);
    unmount();
  });

  it('⭐ 确认后新增失败 ⇒ 确认失效、重新强制可见（旧确认不得遮住新失败）', () => {
    const first: ToolCall[] = [call('1', 'read'), { ...call('2', 'exec', 'error'), result: 'boom' }];
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    act(() => root.render(<ToolCallSummary settled toolCalls={first} />));

    act(() => (container.querySelector('[data-testid="tool-failure-continue"]') as HTMLButtonElement).click());
    expect(container.querySelectorAll('[data-testid="tool-call-card"]')).toHaveLength(0);

    act(() =>
      root.render(
        <ToolCallSummary
          settled
          toolCalls={[...first, { ...call('3', 'write', 'error'), result: 'permission denied' }]}
        />,
      ),
    );
    expect(container.querySelectorAll('[data-testid="tool-call-card"]'), '新失败必须重新可见').toHaveLength(3);
    expect(container.querySelector('[data-testid="tool-failure-continue"]')).not.toBeNull();

    act(() => root.unmount());
    container.remove();
  });

  it('⭐ running 期不提供确认入口（不能把还在跑的失败收掉）', () => {
    const { container, unmount } = render(
      <ToolCallSummary toolCalls={[call('1', 'exec', 'error'), call('2', 'ls', 'running')]} />,
    );

    expect(container.querySelector('[data-testid="tool-failure-continue"]')).toBeNull();
    expect(container.querySelectorAll('[data-testid="tool-call-card"]')).toHaveLength(2);
    unmount();
  });

  it('⭐「未收到结果」不受影响：没有失败就没有确认入口，过程仍可见', () => {
    const { container, unmount } = render(
      <ToolCallSummary settled toolCalls={[call('1', 'sessions_spawn', 'running')]} />,
    );

    expect(container.querySelector('[data-testid="tool-failure-continue"]')).toBeNull();
    expect(container.querySelectorAll('[data-testid="tool-call-card"]')).toHaveLength(1);
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

  // ⚠️ 2026-10-08 平铺改造（有意改写）：不再需要"先展开摘要再找那张卡"——
  //    失败的行本身就是平铺可见的，直接定位失败卡（`data-status="error"`）核对标题即可。
  it('失败那一张卡的标题也用 title（平铺可见，无需先展开摘要）', () => {
    const failed: ToolCall = { ...call('2', 'memory_search', 'error'), title: TITLED };
    const { container, unmount } = render(<ToolCallSummary toolCalls={[call('1', 'ls'), failed]} />);

    const card = container.querySelector('[data-testid="tool-call-card"][data-status="error"]');
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

/**
 * V1（2026-10-13 集中整改 step 1）：声明态在摘要组件上的投影。
 * - 实时：只有声明（无执行证据）⇒ data-status `declared`（静态图标，不转圈）；
 * - 定稿：声明 ⇒ 沿用第三态「未收到结果」（不是失败，无重试 CTA）；
 * - 混合：有 running 时仍以 running 为准。
 */
describe('V1 · declared（声明态）摘要投影', () => {
  const declaredCall = (id: string, name = 'exec'): ToolCall => ({
    id,
    name,
    status: 'declared',
    startedAt: '',
  });

  it('⭐ 实时只有声明 ⇒ 摘要 data-status=declared（不伪装"执行中"转圈）', () => {
    const { container, unmount } = render(<ToolCallSummary toolCalls={[declaredCall('1', 'read_file')]} />);

    const summary = container.querySelector('[data-testid="tool-activity-summary"]');
    expect(summary?.getAttribute('data-status')).toBe('declared');
    const card = container.querySelector('[data-testid="tool-call-card"][data-status="declared"]');
    expect(card, '声明卡平铺可见，状态如实为 declared').not.toBeNull();
    unmount();
  });

  it('⭐ 实时混合 [running, declared] ⇒ 摘要以 running 为准', () => {
    const { container, unmount } = render(
      <ToolCallSummary toolCalls={[call('1', 'ls', 'running'), declaredCall('2')]} />,
    );

    expect(container.querySelector('[data-testid="tool-activity-summary"]')?.getAttribute('data-status')).toBe(
      'running',
    );
    unmount();
  });

  it('⭐ 定稿后的声明 ⇒ 「未收到结果」（不算失败、无重试 CTA）', () => {
    const onRetry = vi.fn();
    const { container, unmount } = render(
      <ToolCallSummary settled onRetry={onRetry} toolCalls={[declaredCall('1', 'sessions_spawn')]} />,
    );

    const summary = container.querySelector('[data-testid="tool-activity-summary"]');
    expect(summary?.getAttribute('data-status')).toBe('unreported');
    expect(container.textContent).toContain('toolActivity.unreported:1');
    expect(container.querySelector('[data-testid="tool-failure-cannot-continue"]')).toBeNull();
    expect(container.querySelector('[data-testid="tool-failure-retry"]')).toBeNull();
    unmount();
  });
});

/**
 * V2（2026-10-13 集中整改 step 2）：dispatched（进入处理）在摘要组件上的投影。
 * - 实时：dispatched 归"未结束"桶 ⇒ 摘要 data-status=running（"正在处理"文案），卡片如实 dispatched；
 * - 定稿：与 running 同路投影「未收到结果」（不算失败、无重试 CTA）。
 */
describe('V2 · dispatched（进入处理）摘要投影', () => {
  const dispatchedCall = (id: string, name = 'exec'): ToolCall => ({
    id,
    name,
    status: 'dispatched',
    startedAt: '2026-09-15T00:00:00.000Z',
  });

  it('⭐ 实时只有 dispatched ⇒ 摘要"正在处理"（running 档），卡片如实 dispatched', () => {
    const { container, unmount } = render(<ToolCallSummary toolCalls={[dispatchedCall('1', 'read_file')]} />);

    expect(container.querySelector('[data-testid="tool-activity-summary"]')?.getAttribute('data-status')).toBe(
      'running',
    );
    expect(container.querySelector('[data-testid="tool-call-card"][data-status="dispatched"]')).not.toBeNull();
    unmount();
  });

  it('⭐ 定稿后的 dispatched ⇒ 「未收到结果」（不算失败、无重试 CTA）', () => {
    const onRetry = vi.fn();
    const { container, unmount } = render(
      <ToolCallSummary settled onRetry={onRetry} toolCalls={[dispatchedCall('1', 'sessions_spawn')]} />,
    );

    expect(container.querySelector('[data-testid="tool-activity-summary"]')?.getAttribute('data-status')).toBe(
      'unreported',
    );
    expect(container.textContent).toContain('toolActivity.unreported:1');
    expect(container.querySelector('[data-testid="tool-failure-retry"]')).toBeNull();
    unmount();
  });
});

describe('AssistantBlock tool activity', () => {
  // ⚠️ 2026-10-08 平铺改造（有意改写）：流式期间工具行**平铺可见**（原断言 0 张单卡）。
  it('renders all streaming calls through one shared flat summary', () => {
    const calls = Array.from({ length: 10 }, (_, index) => call(String(index), index < 8 ? 'ls' : 'exec'));
    const { container, unmount } = render(
      <AssistantBlock state="streaming" content="" toolCalls={calls} identity={{ agentName: '助手' }} />,
    );

    expect(container.querySelectorAll('[data-testid="tool-activity-summary"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-testid="tool-call-card"]')).toHaveLength(10);
    expect(container.textContent).toContain('toolActivity.running:10');
    unmount();
  });
});
