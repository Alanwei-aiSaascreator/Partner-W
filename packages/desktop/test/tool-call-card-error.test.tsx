// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { ToolCall } from '@clawwork/shared';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

import ToolCallCard from '../src/renderer/components/ToolCallCard';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

function call(over: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'tc-1',
    name: 'exec',
    status: 'done',
    title: 'exec 列出桌面lulu文件夹内容',
    startedAt: '2026-09-24T09:00:00.000Z',
    completedAt: '2026-09-24T09:00:03.700Z',
    ...over,
  };
}

function errorLine(container: HTMLElement): string | null {
  return container.querySelector('[data-testid="tool-call-error"]')?.textContent ?? null;
}

/**
 * 工具调用失败时，**原因要摊在行上**，不能只留一个红色 ×。
 *
 * ## 为什么单独钉这一条
 *
 * 2026-09-24 同事的真机截图：`执行操作 · exec 列出桌面lulu文件夹内容  3.7s` 配一个红叉，
 * 行上**一个字的原因都没有**；汇总行也只说「执行了 1 个工具调用（1 个失败）」。
 * 用户唯一能得到的结论就是"无法操作"。
 *
 * 而原因**本来就在数据里**：`ToolCall.result` 存的是**运行时自己那段原文**
 * （审批路径见 `gateway-dispatcher.ts` 的 `explanation`；工具结果路径是
 * `extractToolResultText(data.result) ?? data.meta`）。所以这一刀**不编任何中文**，
 * 只把已有的原文摊出来 —— 与 `gateway-error-message.ts` 立的规矩一致：
 * 「认不出来的一律返回 null……宁可给英文也不要给一句错的中文」。
 */
describe('ToolCallCard 的失败原因', () => {
  it('失败 ⇒ 行上直接显示运行时给的原文', () => {
    const reason = 'exec: path "C:\\\\Users\\\\Administrator\\\\Desktop\\\\lulu" is outside the workspace';
    const { container, unmount } = render(<ToolCallCard toolCall={call({ status: 'error', result: reason })} />);

    expect(errorLine(container), '行上要有失败原因').not.toBeNull();
    expect(errorLine(container)).toContain('outside the workspace');
    unmount();
  });

  it('失败但运行时没给原文 ⇒ 不渲染空行（宁可什么都不加，也不编一句话）', () => {
    const { container, unmount } = render(<ToolCallCard toolCall={call({ status: 'error', result: undefined })} />);
    expect(errorLine(container)).toBeNull();
    unmount();
  });

  it('空白原文（只有空格/换行）同样不渲染', () => {
    const { container, unmount } = render(<ToolCallCard toolCall={call({ status: 'error', result: '   \n  ' })} />);
    expect(errorLine(container)).toBeNull();
    unmount();
  });

  it('**成功**的调用不摊结果 —— 否则每一行都拖一行正文，折叠就没意义了', () => {
    const { container, unmount } = render(<ToolCallCard toolCall={call({ status: 'done', result: 'ok: 42 files' })} />);
    expect(errorLine(container)).toBeNull();
    unmount();
  });

  it('还在跑的调用也不摊', () => {
    const { container, unmount } = render(
      <ToolCallCard toolCall={call({ status: 'running', result: 'partial', completedAt: undefined })} />,
    );
    expect(errorLine(container)).toBeNull();
    unmount();
  });

  it('原文很长时整段都在 DOM 里（行上截断、title 可悬停看全）', () => {
    const long = `exec failed: ${'x'.repeat(400)}`;
    const { container, unmount } = render(<ToolCallCard toolCall={call({ status: 'error', result: long })} />);

    const node = container.querySelector('[data-testid="tool-call-error"]');
    expect(node?.getAttribute('title'), 'title 带全文，用户能悬停看全').toBe(long);
    expect(node?.textContent?.length, 'DOM 里也是全文，没有为了好看把内容截掉').toBe(long.length);
    unmount();
  });
});
