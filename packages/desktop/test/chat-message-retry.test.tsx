// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@clawwork/shared';
import i18n from '../src/renderer/i18n';
import ChatMessage from '../src/renderer/components/ChatMessage';

vi.mock('framer-motion', async () => {
  const React = await import('react');

  const motion = new Proxy(
    {},
    {
      get: (_target, tag: string) =>
        React.forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement>>(({ children, ...props }, ref) =>
          React.createElement(tag, { ...props, ref }, children),
        ),
    },
  );

  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    motion,
  };
});

/**
 * 错误消息上的「重试」入口（B10）。
 *
 * 两条**相反**的失败都要挡住：
 *   - 该给的没给 ⇒ 用户又得把整句话重打一遍（这就是要修的病）；
 *   - 不该给的给了 ⇒ 点一下再花一次钱，而结果**必然**还是失败
 *     （模型拒答 / 上下文超长重发同一句话没有任何意义）。
 */

function buildMessage(partial: Partial<Message>): Message {
  return {
    id: 'msg-1',
    taskId: 'task-1',
    role: 'system',
    content: 'stream: 请求过于频繁',
    artifacts: [],
    toolCalls: [],
    timestamp: '2026-09-19T00:00:00.000Z',
    ...partial,
  };
}

function render(ui: ReactElement): { container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  act(() => {
    root.render(ui);
  });

  return {
    container,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

const cleanups: Array<() => void> = [];
const retryButton = (container: HTMLElement): HTMLButtonElement | null =>
  container.querySelector('[data-testid="chat-message-retry"]');

describe('错误消息上的重试入口', () => {
  // 默认是 en；这里要断言的是"文案真的来自 i18n"，切到 zh 才看得出区别
  //（否则 'Retry' 和写死的 'Retry' 分不清）。
  beforeAll(async () => {
    await i18n.changeLanguage('zh');
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
    vi.restoreAllMocks();
  });

  it('⭐ 可重试的错误上出现按钮，点了就调 onRetry', () => {
    const onRetry = vi.fn();
    const { container, unmount } = render(<ChatMessage message={buildMessage({})} retryable onRetry={onRetry} />);
    cleanups.push(unmount);

    const button = retryButton(container);
    expect(button, '可重试的错误必须给入口').not.toBeNull();
    expect(button?.textContent).toBe(i18n.t('common.retry'));

    act(() => {
      button?.click();
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('⭐ 不可重试的错误上**不许**有按钮 —— 连 onRetry 一起给也不给（防调用方漏判）', () => {
    const onRetry = vi.fn();
    const { container, unmount } = render(
      <ChatMessage message={buildMessage({})} retryable={false} onRetry={onRetry} />,
    );
    cleanups.push(unmount);

    expect(retryButton(container)).toBeNull();
    expect(container.textContent).toContain('请求过于频繁'); // 错误本身照旧要说出来
  });

  it('没有 onRetry 就不渲染按钮（点了没反应比没有更糟）', () => {
    const { container, unmount } = render(<ChatMessage message={buildMessage({})} retryable />);
    cleanups.push(unmount);

    expect(retryButton(container)).toBeNull();
  });

  it('⭐ 按钮上写清楚"会再花一次"（title 提示），别让用户以为重试免费', () => {
    const { container, unmount } = render(<ChatMessage message={buildMessage({})} retryable onRetry={vi.fn()} />);
    cleanups.push(unmount);

    const title = retryButton(container)?.getAttribute('title') ?? '';
    // ① 走的是 i18n 那条路（不是写死的字符串）
    expect(title).toBe(i18n.t('chatMessage.retryHint'));
    // ② 而且这句真的把"会再扣一次"说出来了 —— 光有个 key 不算数
    expect(title).toContain('积分');
  });

  it('普通消息（用户 / 助手）不会长出重试按钮', () => {
    const user = render(
      <ChatMessage message={buildMessage({ role: 'user', content: '你好' })} retryable onRetry={vi.fn()} />,
    );
    cleanups.push(user.unmount);
    expect(retryButton(user.container)).toBeNull();

    const assistant = render(
      <ChatMessage message={buildMessage({ role: 'assistant', content: '在的' })} retryable onRetry={vi.fn()} />,
    );
    cleanups.push(assistant.unmount);
    expect(retryButton(assistant.container)).toBeNull();
  });

  it('同一个会话里已被后续一轮作废的错误不再出现（retryable 由 false 表达）', () => {
    // 状态归 store 管（`retryableErrorBySession` 在"空闲→忙"时清空），
    // 组件只认传进来的这一位 —— 这条只是把契约钉死：**不认** message 自身的内容猜。
    const { container, unmount } = render(
      <ChatMessage message={buildMessage({ content: 'stream: timeout' })} retryable={false} onRetry={vi.fn()} />,
    );
    cleanups.push(unmount);

    expect(retryButton(container)).toBeNull();
  });
});
