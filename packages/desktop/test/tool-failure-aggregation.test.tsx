// @vitest-environment jsdom

/**
 * BUG-026（2026-10-06 B 组 · Tool/生成失败的用户层展示）：
 *
 *  1. **聚合**：同一工具重复失败 → 对话里只摊一条（不是一失败一气泡）；其余折叠但可查。
 *  2. **可降级继续** →「部分在线资料暂时不可用，已基于现有资料继续处理。」（次要位置）。
 *  3. **无法继续** →「这一步暂时无法完成。」+「重新尝试 / 继续使用已有资料」。
 *  4. **任务最终成功时**，中间非致命失败不成为主视觉（弱化，不隐藏）。
 *  5. **开发日志保留全部** → console.debug（原始载荷）。
 *
 * 文案断言用 key（mock 的 t 返回 key）钉行为；**真实 9 语言词条**由
 * `tool-failure-copy.test.ts` 与 `pnpm check:i18n` 钉住。
 */

import type { ToolCall } from '@clawwork/shared';
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

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function call(id: string, name: string, status: ToolCall['status'], result?: string): ToolCall {
  return {
    id,
    name,
    status,
    result,
    startedAt: '2026-09-15T00:00:00.000Z',
    ...(status === 'running' ? {} : { completedAt: '2026-09-15T00:00:01.000Z' }),
  };
}

/** 同一工具、同一原因重复失败 N 次 —— 真机里模型"失败 → 重试 → 再失败"的形状。 */
function repeatedFailures(count: number, name = 'web_search', result = 'fetch failed'): ToolCall[] {
  return Array.from({ length: count }, (_, index) => call(String(index + 1), name, 'error', result));
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

function summaryButton(container: HTMLElement): HTMLButtonElement {
  return container.querySelector('[data-testid="tool-activity-summary"]') as HTMLButtonElement;
}

describe('BUG-026 聚合：同一工具重复失败 → 一条', () => {
  it('5 次相同失败：主行只摊一条失败原因 + 如实的重复计数', () => {
    const { container, unmount } = render(<ToolCallSummary settled toolCalls={repeatedFailures(5)} />);

    expect(container.querySelectorAll('[data-testid="tool-failure-reason"]')).toHaveLength(1);
    expect(container.querySelector('[data-testid="tool-failure-repeat"]')?.textContent).toBe(
      'toolActivity.repeatedFailure:5',
    );
    // 主行（trigger）不出现第二、第三条失败行
    expect(summaryButton(container).querySelectorAll('[data-testid="tool-failure-reason"]')).toHaveLength(1);
    unmount();
  });

  it('展开详情后：代表条目占一格，其余 4 次折叠在一个可展开的"相同失败"里（不隐藏事实）', () => {
    const { container, unmount } = render(<ToolCallSummary settled toolCalls={repeatedFailures(5)} />);

    act(() => summaryButton(container).click());

    const fold = container.querySelector('[data-testid="tool-failure-repeats"]');
    expect(fold).not.toBeNull();
    expect(fold?.querySelector('summary')?.textContent).toBe('toolActivity.repeatedFailure:5');
    // 5 次失败全部在 DOM 里（事实不丢）：1 个代表 + 4 个折叠项，折叠项默认不展开
    expect(container.querySelectorAll('[data-testid="tool-call-card"]')).toHaveLength(5);
    expect((fold as HTMLDetailsElement).open).toBe(false);
    unmount();
  });

  it('重复失败不再产生第二条失败原因行（不同工具各摊各的）', () => {
    const { container, unmount } = render(
      <ToolCallSummary
        settled
        toolCalls={[
          ...repeatedFailures(3, 'web_search', 'fetch failed'),
          call('9', 'read_file', 'error', 'permission denied'),
        ]}
      />,
    );

    // web_search 合并成 1 条 + read_file 1 条 = 2 条（不是 4 条）
    expect(container.querySelectorAll('[data-testid="tool-failure-repeat"]')).toHaveLength(1);
    unmount();
  });

  /**
   * 区1 体检 P3-7：计数原来只看 `failures[0]`（第一组）——后面几组的重复全部隐形，
   * 用户看到的"重复失败 ×N"比实际发生的事少。现在**所有重复组合计**。
   */
  it('⭐ 多组重复失败：计数是**合计**，不是只算第一组', () => {
    const { container, unmount } = render(
      <ToolCallSummary
        settled
        toolCalls={[
          ...repeatedFailures(3, 'web_search', 'fetch failed'),
          call('8', 'read_file', 'error', 'permission denied'),
          call('9', 'read_file', 'error', 'permission denied'),
        ]}
      />,
    );

    // 3 + 2 = 5（只算第一组的话这里是 3）
    expect(container.querySelector('[data-testid="tool-failure-repeat"]')?.textContent).toBe(
      'toolActivity.repeatedFailure:5',
    );
    unmount();
  });

  it('只有一次失败（没有重复）⇒ 不出现重复计数（不虚报）', () => {
    const { container, unmount } = render(<ToolCallSummary settled toolCalls={[call('1', 'exec', 'error', 'boom')]} />);

    expect(container.querySelector('[data-testid="tool-failure-repeat"]')).toBeNull();
    unmount();
  });
});

describe('BUG-026 文案与操作项：无法继续 / 可降级继续', () => {
  it('已结束且一步都没成功 ⇒「这一步暂时无法完成。」+ 两个操作项', () => {
    const onRetry = vi.fn();
    const { container, unmount } = render(
      <ToolCallSummary settled onRetry={onRetry} toolCalls={repeatedFailures(2)} />,
    );

    expect(container.querySelector('[data-testid="tool-failure-cannot-continue"]')?.textContent).toBe(
      'toolActivity.failure.cannotContinue',
    );
    expect(container.querySelector('[data-testid="tool-failure-retry"]')?.textContent).toBe(
      'toolActivity.failure.retryAction',
    );
    expect(container.querySelector('[data-testid="tool-failure-continue"]')?.textContent).toBe(
      'toolActivity.failure.continueWithMaterials',
    );
    unmount();
  });

  it('没有重试通道时不给假按钮（只留可用的那一个）', () => {
    const { container, unmount } = render(<ToolCallSummary settled toolCalls={repeatedFailures(2)} />);

    expect(container.querySelector('[data-testid="tool-failure-retry"]')).toBeNull();
    expect(container.querySelector('[data-testid="tool-failure-continue"]')).not.toBeNull();
    unmount();
  });

  it('「重新尝试」接真实重试回调；「继续使用已有资料」把失败降为次要位置（事实仍可查）', () => {
    const onRetry = vi.fn();
    const { container, unmount } = render(
      <ToolCallSummary settled onRetry={onRetry} toolCalls={repeatedFailures(2)} />,
    );

    act(() => (container.querySelector('[data-testid="tool-failure-retry"]') as HTMLButtonElement).click());
    expect(onRetry).toHaveBeenCalledTimes(1);

    act(() => (container.querySelector('[data-testid="tool-failure-continue"]') as HTMLButtonElement).click());
    // 用户选择继续 ⇒ 不再是主视觉（warning、无"无法完成"块），但失败事实仍可展开
    expect(summaryButton(container).dataset.status).toBe('warning');
    expect(container.querySelector('[data-testid="tool-failure-cannot-continue"]')).toBeNull();
    expect(container.querySelector('[data-testid="tool-failure-degraded"]')?.textContent).toContain(
      'toolActivity.failure.degradedContinue',
    );
    unmount();
  });

  it('可降级：已结束 + 有成功步骤 + 网络类失败 ⇒ 次要位置说「已基于现有资料继续处理」', () => {
    const { container, unmount } = render(
      <ToolCallSummary
        settled
        toolCalls={[call('1', 'ls', 'done'), call('2', 'web_search', 'error', 'fetch failed')]}
      />,
    );

    const summary = summaryButton(container);
    // 主视觉不再是红色失败块
    expect(summary.dataset.status).toBe('warning');
    expect(container.querySelector('[data-testid="tool-failure-degraded"]')?.textContent).toBe(
      'toolActivity.failure.degradedContinue',
    );
    unmount();
  });

  /**
   * ⚠️ 2026-10-08（pre19 验收截图）口径反转：**认不出的内核英文**不再原样上屏，
   * 统一走产品兜底句「这一步暂时无法完成。」；原始文本仍在 console.debug。
   * 认不出的**中文**内容照旧原样保留（见「未映射的内核英文不上屏」组第三条）。
   */
  it('可降级但认不出的**内核英文** ⇒ 产品兜底句（不原样上屏）', () => {
    const { container, unmount } = render(
      <ToolCallSummary
        settled
        toolCalls={[call('1', 'ls', 'done'), call('2', 'exec', 'error', 'Command exited with code 1')]}
      />,
    );

    const note = container.querySelector('[data-testid="tool-failure-degraded"]')?.textContent ?? '';
    expect(note).toContain('toolActivity.failure.cannotContinue');
    expect(note).not.toContain('Command exited with code 1');
    unmount();
  });
});

describe('BUG-026 任务成功时失败不成为主视觉', () => {
  it('已结束 + 有成功步骤 ⇒ 失败原因从主行移走（status=warning，仍可展开查到）', () => {
    const { container, unmount } = render(
      <ToolCallSummary
        settled
        toolCalls={[call('1', 'ls', 'done'), call('2', 'web_search', 'error', 'fetch failed')]}
      />,
    );

    const summary = summaryButton(container);
    expect(summary.dataset.status).not.toBe('error');
    // 主行里没有失败原因；它被弱化到次要位置
    expect(summary.querySelector('[data-testid="tool-failure-reason"]')).toBeNull();
    expect(container.querySelector('[data-testid="tool-failure-degraded"]')).not.toBeNull();
    // 事实没被藏：展开后失败卡片仍在（展开失败分组，逐条可查）
    act(() => summary.click());
    expect(container.querySelectorAll('[data-testid="tool-call-card"][data-status="error"]')).toHaveLength(1);
    unmount();
  });

  it('还在跑的一轮：失败仍是主视觉（不能提前弱化"可能还要重试"的失败）', () => {
    const { container, unmount } = render(
      <ToolCallSummary toolCalls={[call('1', 'ls', 'done'), call('2', 'web_search', 'error', 'fetch failed')]} />,
    );

    expect(summaryButton(container).dataset.status).toBe('error');
    expect(summaryButton(container).querySelector('[data-testid="tool-failure-reason"]')).not.toBeNull();
    unmount();
  });
});

describe('BUG-026 开发日志：原始失败载荷进 console.debug', () => {
  it('带 stack 的失败原文完整进 console（用户面看不到，排查拿得到）', () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const stack = 'Error: EACCES\n    at open (D:\\ws\\src\\fs.ts:10:2)';
    const { unmount } = render(<ToolCallSummary settled toolCalls={[call('1', 'exec', 'error', stack)]} />);

    const logged = spy.mock.calls.some(
      ([, payload]) => Array.isArray(payload) && payload.some((entry) => entry?.result === stack),
    );
    expect(logged).toBe(true);
    spy.mockRestore();
    unmount();
  });
});

/**
 * pre19 验收截图实证（2026-10-08）：**未映射的内核英文在聚合视图里原样上屏** ——
 * 「执行了 43 个工具调用（21 个失败）→ no paired nodes available; file-transfer tools require a
 *   paired node from nodes status. Use local file/exec tools for local workspace paths. · 重复失败 ×12」。
 * 产品口径（BUG-012/026）：内核/provider 原文不上屏，原始载荷只进 console.debug。
 */
describe('未映射的内核英文不上屏（聚合视图兜底）', () => {
  const KERNEL_ENGLISH =
    'no paired nodes available; file-transfer tools require a paired node from nodes status. Use local file/exec tools for local workspace paths.';
  const englishFailures = (count: number): ToolCall[] => repeatedFailures(count, 'file_fetch', KERNEL_ENGLISH);

  it('⭐ 弱化态（有成功步骤 + 12 次重复英文失败）：主行只剩产品兜底句 + 重复计数，英文与路径一个都不上屏', () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const { container, unmount } = render(
      <ToolCallSummary settled toolCalls={[call('0', 'read_file', 'done'), ...englishFailures(12)]} />,
    );

    const text = container.textContent ?? '';
    expect(text).not.toContain('no paired nodes');
    expect(text).not.toContain('file-transfer');
    expect(text).not.toContain('Use local file/exec');
    expect(text).not.toContain('paired node from nodes status');
    // 兜底句 + 如实的重复计数（事实不丢、不虚报）
    expect(container.querySelector('[data-testid="tool-failure-degraded"]')?.textContent).toContain(
      'toolActivity.failure.cannotContinue',
    );
    expect(container.querySelector('[data-testid="tool-failure-repeat"]')?.textContent).toBe(
      'toolActivity.repeatedFailure:12',
    );
    // 原始载荷照旧进 console.debug（用户看不到，排查拿得到）
    const logged = spy.mock.calls.some(
      ([, payload]) => Array.isArray(payload) && payload.some((entry) => entry?.result === KERNEL_ENGLISH),
    );
    expect(logged).toBe(true);
    spy.mockRestore();
    unmount();
  });

  it('⭐ 无法继续态：兜底句**只说一次**（不与下方动作行重复），重复计数仍在', () => {
    const { container, unmount } = render(<ToolCallSummary settled toolCalls={englishFailures(12)} />);

    const text = container.textContent ?? '';
    expect(text).not.toContain('no paired nodes');
    expect(summaryButton(container).dataset.status).toBe('error');
    expect(text.split('toolActivity.failure.cannotContinue').length - 1).toBe(1);
    expect(container.querySelector('[data-testid="tool-failure-cannot-continue"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="tool-failure-repeat"]')?.textContent).toBe(
      'toolActivity.repeatedFailure:12',
    );
    unmount();
  });

  it('未被兜底波及：含中文的认不出原因照旧原样展示（不编中文指错方向）', () => {
    const { container, unmount } = render(
      <ToolCallSummary settled toolCalls={[call('1', 'exec', 'error', '工作区里没有这个文件')]} />,
    );

    expect(container.querySelector('[data-testid="tool-failure-reason"]')?.textContent).toContain(
      '工作区里没有这个文件',
    );
    unmount();
  });
});
