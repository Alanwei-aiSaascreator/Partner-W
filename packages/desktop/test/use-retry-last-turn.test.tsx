// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, MessageAttachment } from '@clawwork/shared';

/**
 * 「重试」那一下到底发出去了什么（B10）。
 *
 * 组件那层只管画按钮（`chat-message-retry.test.tsx`），这里管**发**：
 * 目标是"重新发一遍上一条用户消息"，所以最容易错的不是发不发，而是**发了什么**
 * —— 发错对象（发成错误消息自己）、丢掉附件、或者压根没目标还硬发一条空的。
 */

const mocks = vi.hoisted(() => ({
  send: vi.fn(async () => ({ ok: true, taskId: 'task-1' })),
}));

vi.mock('../src/renderer/platform', () => ({
  composer: { send: mocks.send },
}));

import { useRetryLastTurn } from '../src/renderer/hooks/useRetryLastTurn';

const TASK = { id: 'task-1' } as never;

function msg(partial: Partial<Message> & { id: string; role: Message['role'] }): Message {
  return {
    taskId: 'task-1',
    content: '',
    artifacts: [],
    toolCalls: [],
    timestamp: '2026-09-19T00:00:00.000Z',
    ...partial,
  };
}

const ATTACHMENTS: MessageAttachment[] = [
  { fileName: '报表.xlsx', dataUrl: 'data:application/vnd.ms-excel;base64,AAAA', size: 1024 },
];

const MESSAGES: Message[] = [
  msg({ id: 'u1', role: 'user', content: '帮我看看这个表', attachments: ATTACHMENTS }),
  msg({ id: 'a1', role: 'assistant', content: '好的' }),
  msg({ id: 'err-1', role: 'system', content: 'stream: 请求过于频繁' }),
];

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

/** 把 hook 挂进一棵最小组件树，并把回调取出来。 */
function renderHookRetry(task: unknown, messages: Message[]): (messageId: string) => void {
  let captured: ((messageId: string) => void) | null = null;

  function Probe(): null {
    captured = useRetryLastTurn(task as never, messages);
    return null;
  }

  const { unmount } = render(<Probe />);
  cleanups.push(unmount);

  return (messageId: string) => {
    act(() => {
      captured?.(messageId);
    });
  };
}

const cleanups: Array<() => void> = [];

describe('useRetryLastTurn —— 重发上一条用户消息', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.send.mockClear();
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
    vi.restoreAllMocks();
  });

  it('⭐ 点错误上的重试 ⇒ 把那条**用户消息**重发一遍（正文 + 附件）', () => {
    const retry = renderHookRetry(TASK, MESSAGES);

    retry('err-1');

    expect(mocks.send).toHaveBeenCalledTimes(1);
    const [taskId, options] = mocks.send.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(taskId).toBe('task-1');
    expect(options.content).toBe('帮我看看这个表');
    // ⚠️ 丢附件 = 发出去的问题**看起来一样、其实不是同一件事**，而用户看不出来
    expect(options.messageAttachments).toEqual(ATTACHMENTS);
  });

  it('⭐ 找不到可重发的目标 ⇒ 什么都不发（不许发一条空消息出去）', () => {
    const retry = renderHookRetry(TASK, [msg({ id: 'err-1', role: 'system', content: 'stream: 超时' })]);

    retry('err-1');

    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('没有任务（还没落盘）⇒ 不发', () => {
    const retry = renderHookRetry(undefined, MESSAGES);

    retry('err-1');

    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('没有附件时**不带** messageAttachments 这个键（别塞 undefined 进去）', () => {
    const retry = renderHookRetry(TASK, [
      msg({ id: 'u1', role: 'user', content: '在吗' }),
      msg({ id: 'err-1', role: 'system', content: 'stream: 超时' }),
    ]);

    retry('err-1');

    const options = (mocks.send.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
    expect(options.content).toBe('在吗');
    expect('messageAttachments' in options).toBe(false);
  });

  it('⚠️ 不会把错误消息本身当成要发的内容', () => {
    const retry = renderHookRetry(TASK, MESSAGES);

    retry('err-1');

    const options = (mocks.send.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
    expect(options.content).not.toContain('请求过于频繁');
  });
});
