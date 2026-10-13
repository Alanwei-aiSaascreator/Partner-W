// @vitest-environment jsdom
//
// BUG-075（2026-10-13 性能战役）：思考流高频更新（实测 20–26 次/秒）驱动的
// 「整条时间线重渲」回归钉子。三层：
//   A 源合同：MainArea 不得再内联 `onRetry={() => …}`（每次渲染新引用 = 击穿子组件 memo 的源头），
//     必须直传稳定的 `retryLastTurn`；
//   B 契约行为：重试按钮把 **message.id** 交给 onRetry（稳定引用直传得以成立的前提）；
//   C memo 生效：props 值相等（含同一 onRetry 引用）时子树零提交（React.Profiler 计数 + 反例对照）。

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@clawwork/shared';
import i18n from '../src/renderer/i18n';

// 与 `assistant-block-stability.test.tsx` 同款：framer-motion 原样渲染（去动效保留树形）。
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

// 产物水合（真源在 fileStore，jsdom 里没有）—— 显式给"已回、空结果"，
// 让「无可见答复」分支按产品语义现身；其余导出保持真实。
vi.mock('@/hooks/useTaskArtifacts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/hooks/useTaskArtifacts')>();
  return { ...actual, useTaskArtifacts: () => ({ artifacts: [], pending: false }) };
});

import AssistantBlock from '../src/renderer/components/AssistantBlock';
import ChatMessage from '../src/renderer/components/ChatMessage';
import ThinkingCollapse from '../src/renderer/components/ThinkingCollapse';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

void i18n;

function buildMessage(partial: Partial<Message>): Message {
  return {
    id: 'msg-1',
    taskId: 'task-1',
    role: 'assistant',
    content: '',
    artifacts: [],
    toolCalls: [],
    timestamp: '2026-10-13T00:00:00.000Z',
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
  const api = {
    container,
    rerender: (next: ReactElement) => act(() => root.render(next)),
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
  cleanups.push(api.unmount);
  return api;
}

describe('BUG-075 · 思考流高频更新不做无用重渲', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
    vi.restoreAllMocks();
  });

  it('A 源合同：MainArea 直传稳定引用，不再内联 onRetry 箭头', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/renderer/layouts/MainArea/index.tsx'), 'utf8');
    // 内联箭头 = 每次渲染新函数引用 ⇒ 浅比较的 memo 全部击穿（BUG-075 主因之一）。
    expect(src).not.toMatch(/onRetry=\{\(\)\s*=>/);
    expect(src).toMatch(/onRetry=\{retryLastTurn\}/);
  });

  it('B1 ChatMessage：重试按钮把 message.id 交给 onRetry', () => {
    const onRetry = vi.fn();
    const { container } = render(
      <ChatMessage
        message={buildMessage({ id: 'msg-7', role: 'system', content: 'stream: 请求过于频繁' })}
        retryable
        onRetry={onRetry}
      />,
    );
    const button = container.querySelector('[data-testid="chat-message-retry"]') as HTMLButtonElement | null;
    expect(button, '可重试错误必须给按钮').not.toBeNull();
    act(() => button?.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith('msg-7');
  });

  it('B2 AssistantBlock：空答复重试按钮把 message.id 交给 onRetry', () => {
    const onRetry = vi.fn();
    const { container } = render(
      <AssistantBlock
        state="finalized"
        message={buildMessage({ id: 'msg-9', content: '' })}
        identity={identity}
        onRetry={onRetry}
      />,
    );
    const button = container.querySelector('[data-testid="assistant-empty-retry"]') as HTMLButtonElement | null;
    expect(button, '无可见答复时必须给重试入口').not.toBeNull();
    act(() => button?.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith('msg-9');
  });

  it('C1 AssistantBlock：memo 包装在（浅比较的前提被守住）', () => {
    // 注意：不要用 React.Profiler 计提交——子树 bailout 时 Profiler 自身仍随父提交回调，
    // 会把"没重渲"数成"重渲"（本测试初版实测踩过）。memo 包装 + A 的源合同 + B 的契约
    // 三者合力才完整覆盖这条不变量。
    expect((AssistantBlock as unknown as { $$typeof?: symbol }).$$typeof).toBe(Symbol.for('react.memo'));
  });

  it('C2 ChatMessage：memo 包装在（浅比较的前提被守住）', () => {
    expect((ChatMessage as unknown as { $$typeof?: symbol }).$$typeof).toBe(Symbol.for('react.memo'));
  });

  it('C3 ThinkingCollapse：必须是 memo（思考流每快照重渲的最后一环）', () => {
    expect((ThinkingCollapse as unknown as { $$typeof?: symbol }).$$typeof).toBe(Symbol.for('react.memo'));
  });
});
