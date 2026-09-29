// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it, vi, afterEach } from 'vitest';
import type { Message } from '@clawwork/shared';
import '../src/renderer/i18n';

// 与 `chat-message-copy.test.tsx` 同款：framer-motion 换成"原样渲染"（只去掉动效），
// 于是断言看到的就是产品里那棵树。`useReducedMotion` 必须给（`ThinkingIndicator` 用它）。
vi.mock('framer-motion', async () => {
  const React = await import('react');
  const MOTION_ONLY = new Set([
    'initial',
    'animate',
    'exit',
    'transition',
    'variants',
    'whileHover',
    'whileTap',
    'whileInView',
    'layout',
    'layoutId',
  ]);
  // ⚠️ 每个 tag 只造**一个**组件：`motion.div` 每次访问都新建类型的话，React 每渲染一次都会
  //    当成"换了组件"⇒ 整块卸载重建 —— 那这个测试文件量到的东西就全是脚手架自伤的假象。
  const cache = new Map<string, unknown>();
  const motion = new Proxy(
    {},
    {
      get: (_target, tag: string) => {
        const cached = cache.get(tag);
        if (cached) return cached;
        const component = React.forwardRef<HTMLElement, Record<string, unknown>>((props, ref) => {
          const { children, ...rest } = props;
          const clean = Object.fromEntries(Object.entries(rest).filter(([key]) => !MOTION_ONLY.has(key)));
          return React.createElement(tag, { ...clean, ref }, children as React.ReactNode);
        });
        cache.set(tag, component);
        return component;
      },
    },
  );
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    motion,
    useReducedMotion: () => false,
  };
});

import AssistantBlock from '../src/renderer/components/AssistantBlock';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function buildMessage(partial: Partial<Message>): Message {
  return {
    id: 'msg-1',
    taskId: 'task-1',
    role: 'assistant',
    content: '',
    artifacts: [],
    toolCalls: [],
    timestamp: '2026-09-20T00:00:00.000Z',
    ...partial,
  };
}

const identity = { agentName: '内容助手', agentRoleLabel: '内容', localAvatarUrl: 'file:///avatar.png' };

const cleanups: Array<() => void> = [];

function render(ui: ReactElement): {
  container: HTMLDivElement;
  rerender: (next: ReactElement) => void;
  unmount: () => void;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => root.render(ui));
  const unmount = () => {
    act(() => root.unmount());
    container.remove();
  };
  cleanups.push(unmount);
  return { container, rerender: (next) => act(() => root.render(next)), unmount };
}

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
  document.body.innerHTML = '';
});

/**
 * 2026-09-20 实机报障：「我发完要求，那个对话头像会消失一下，然后再给我反馈」。
 *
 * 三处报障归根到底都是**同一个助手块被卸载重建**（头像跟着换节点 ⇒ 肉眼就是"闪一下"）：
 *   ① 等待 → 流式（T-a9/T-a11，已修）；② 流式 → 定稿（T-a12）；③ 定稿 → 收编成正式消息。
 * 这条测试盯的是 `AssistantBlock` 自己：**状态换、身体换，块与头像不换**。
 *
 * ⚠️ 桩绿了不等于真身对（IPC 那次就是桩与真身各写一遍 → 假绿）—— 所以这里用**真身**组件
 * （真头像、真定稿身体、真流式身体），只把动效换掉。
 */
describe('AssistantBlock：状态切换时块与头像不能被卸载重建', () => {
  it('⭐ 等待（空流式）→ 有内容：块与头像都是同一个 DOM 节点，跳动点消失', () => {
    const view = render(<AssistantBlock state="streaming" content="" toolCalls={[]} identity={identity} />);

    const blockBefore = view.container.querySelector('[data-testid="assistant-block"]');
    const avatarBefore = view.container.querySelector('[data-testid="message-avatar"]');
    expect(blockBefore, '等待态就该有这一块（它就是"从头到尾那一个"）').not.toBeNull();
    expect(avatarBefore, '头像在第一格').not.toBeNull();
    expect(
      view.container.querySelector('[data-testid="thinking-indicator"]'),
      '什么都没到 ⇒ 显示跳动点',
    ).not.toBeNull();

    view.rerender(<AssistantBlock state="streaming" content="你好" toolCalls={[]} identity={identity} />);

    expect(view.container.querySelector('[data-testid="assistant-block"]'), '整块必须是同一个节点').toBe(blockBefore);
    expect(view.container.querySelector('[data-testid="message-avatar"]'), '头像必须是同一个节点').toBe(avatarBefore);
    expect(view.container.querySelector('[data-testid="thinking-indicator"]'), '内容到了跳动点就该没了').toBeNull();
    expect(view.container.textContent).toContain('你好');
  });

  it('⭐ 流式 → 定稿：块与头像还是同一个节点，换的只有身体', () => {
    const view = render(<AssistantBlock state="streaming" content="正在写…" toolCalls={[]} identity={identity} />);

    const blockBefore = view.container.querySelector('[data-testid="assistant-block"]');
    const avatarBefore = view.container.querySelector('[data-testid="message-avatar"]');
    expect(view.container.textContent).toContain('正在写…');

    view.rerender(
      <AssistantBlock
        state="finalized"
        message={buildMessage({ content: '答好了', toolCalls: [] })}
        identity={{ ...identity, modelLabel: 'DeepSeek V4 Flash', modelTitle: 'deepseek-v4-flash' }}
      />,
    );

    // 判据（队列 T-a12 的原文）：定稿前后 `头像` 必须是同一个 DOM 节点。
    expect(view.container.querySelector('[data-testid="assistant-block"]'), '整块必须是同一个节点').toBe(blockBefore);
    expect(
      view.container.querySelector('[data-testid="message-avatar"]'),
      '头像必须是同一个节点 —— 换了就等于被卸载重建，用户看到的就是"闪一下"',
    ).toBe(avatarBefore);
    // 身体确实换了（否则"同一个节点"可能是"什么都没发生"这种假绿）
    expect(view.container.textContent, '定稿正文要在').toContain('答好了');
    expect(view.container.textContent, '流式那份该没了').not.toContain('正在写…');
    expect(view.container.querySelector('[data-testid="model-badge"]')?.textContent, '定稿才拿得到模型来源').toBe(
      'DeepSeek V4 Flash',
    );
  });

  it('定稿 → 又一轮流式（同一会话继续问）：块与头像仍然是同一个节点', () => {
    const view = render(
      <AssistantBlock state="finalized" message={buildMessage({ content: '第一轮答案' })} identity={identity} />,
    );
    const blockBefore = view.container.querySelector('[data-testid="assistant-block"]');
    const avatarBefore = view.container.querySelector('[data-testid="message-avatar"]');

    view.rerender(<AssistantBlock state="streaming" content="" toolCalls={[]} identity={identity} />);

    expect(view.container.querySelector('[data-testid="assistant-block"]')).toBe(blockBefore);
    expect(view.container.querySelector('[data-testid="message-avatar"]')).toBe(avatarBefore);
    expect(view.container.textContent).not.toContain('第一轮答案');
  });

  it('流式思考只显示中性等待态，绝不把供应商原始推理暴露给用户', () => {
    const rawThinking = 'We need inspect private chain-of-thought before answering.';
    const view = render(
      <AssistantBlock state="streaming" content="" thinkingContent={rawThinking} toolCalls={[]} identity={identity} />,
    );

    expect(view.container.textContent).not.toContain(rawThinking);
    expect(view.container.querySelector('[data-testid="thinking-indicator"]')).not.toBeNull();
  });

  it('定稿消息也不显示已经保存的原始推理', () => {
    const rawThinking = 'Hidden provider reasoning must stay hidden.';
    const view = render(
      <AssistantBlock
        state="finalized"
        message={buildMessage({ content: '给用户的答案', thinkingContent: rawThinking })}
        identity={identity}
      />,
    );

    expect(view.container.textContent).toContain('给用户的答案');
    expect(view.container.textContent).not.toContain(rawThinking);
  });
});
