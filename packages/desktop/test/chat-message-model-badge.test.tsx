// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@clawwork/shared';
import '../src/renderer/i18n';
import ChatMessage from '../src/renderer/components/ChatMessage';
// 流式那一格现在与定稿态是**同一个组件**（`StreamingMessage` 已并入 `AssistantBlock`），
// 只是 `state="streaming"`。见 `AssistantBlock.tsx` 顶部注释。
import AssistantBlock from '../src/renderer/components/AssistantBlock';

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

function buildMessage(partial: Partial<Message>): Message {
  return {
    id: 'msg-1',
    taskId: 'task-1',
    role: 'assistant',
    content: '收到',
    artifacts: [],
    toolCalls: [],
    timestamp: '2026-03-13T00:00:00.000Z',
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

const badgeOf = (container: HTMLElement): Element | null => container.querySelector('[data-testid="model-badge"]');

describe('per-message model badge', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
    vi.restoreAllMocks();
  });

  it('有模型就渲染徽章，原文 id 放 title（展示名可能是目录里的别名）', () => {
    const { container, unmount } = render(
      <ChatMessage message={buildMessage({ model: 'glm-4.7' })} modelLabel="GLM 4.7" agentName="助手" />,
    );
    cleanups.push(unmount);

    const badge = badgeOf(container);
    expect(badge?.textContent).toBe('GLM 4.7');
    expect(badge?.getAttribute('title')).toBe('glm-4.7');
  });

  // ⚠️ 最容易漏的一条：元信息行的渲染条件原本是 `(agentName || agentRoleLabel)`，
  // 不改的话，单 agent、没有角色标签的会话里徽章**永远不出现**。
  it('只有模型、没有名字和角色时，元信息行仍然渲染', () => {
    const { container, unmount } = render(
      <ChatMessage message={buildMessage({ model: 'qwen-turbo' })} modelLabel="qwen-turbo" />,
    );
    cleanups.push(unmount);

    const badge = badgeOf(container);
    expect(badge?.textContent).toBe('qwen-turbo');
    expect(badge?.parentElement?.className).toContain('flex-wrap');
  });

  it('没有模型就不渲染徽章 —— 老数据不猜、不占位', () => {
    const { container, unmount } = render(<ChatMessage message={buildMessage({})} agentName="助手" />);
    cleanups.push(unmount);

    expect(badgeOf(container)).toBeNull();
    expect(container.textContent).toContain('收到');
  });

  it('用户消息即使带了 modelLabel 也不显示徽章', () => {
    const { container, unmount } = render(
      <ChatMessage message={buildMessage({ role: 'user', model: 'glm-4.7' })} modelLabel="GLM 4.7" />,
    );
    cleanups.push(unmount);

    expect(badgeOf(container)).toBeNull();
  });

  // 流式期间走的是 delta 帧，网关**不发** model（实测：delta 的 message 是现造的
  // `{role,content:[{type:'text'}]}`）。这一段不许拿 picker 猜，所以流式不显示徽章，
  // finalize 之后由 canonical 消息带出来。
  it('流式期间不显示徽章（这一刻还不知道是谁生成的）', () => {
    const { container, unmount } = render(
      <AssistantBlock
        state="streaming"
        content="正在回复"
        thinkingContent=""
        toolCalls={[]}
        identity={{ agentName: '助手' }}
      />,
    );
    cleanups.push(unmount);

    expect(badgeOf(container)).toBeNull();
  });
});
