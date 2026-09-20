// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

// `ThinkingIndicator` 用 `useReducedMotion`，所以桩里必须有它（只给 motion/AnimatePresence 会崩）。
vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: ReactElement }) => children,
  motion: { div: 'div', span: 'span' },
  useReducedMotion: () => false,
}));

import StreamingMessage from '../src/renderer/components/StreamingMessage';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 2026-09-20 实机报障：「我发完要求，那个对话头像会消失一下，然后再给我反馈」。
 *
 * `chat-send-stability.test.tsx` 里 `StreamingMessage` 是**桩**，它只能证明"交给 React 的是同一个
 * 元素"；真正**带着头像**的是这个组件本身（`MessageAvatar` 在 `motion.div` 的第一个孩子位）。
 * ⚠️ 桩绿了不等于真身对（IPC 那次就是桩与真身各写一遍 → 假绿）—— 所以这里用**真身**再钉一遍：
 * 「等待 → 有内容」之间，整块与头像都必须是**同一个 DOM 节点**，跳动点该消失。
 */
describe('StreamingMessage：等待 → 内容，头像不能被卸载重建', () => {
  it('⭐ content 从空到有：块与头像都是同一个 DOM 节点，跳动点消失', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);

    act(() => root.render(<StreamingMessage content="" toolCalls={[]} />));

    const blockBefore = container.firstElementChild;
    const avatarBefore = blockBefore?.firstElementChild;
    expect(avatarBefore, '等待态也该有头像（它就是"从头到尾那一个"）').toBeTruthy();
    expect(container.querySelector('[data-testid="thinking-indicator"]'), '什么都没到 ⇒ 显示跳动点').not.toBeNull();

    act(() => root.render(<StreamingMessage content="你好" toolCalls={[]} />));

    expect(container.firstElementChild, '整块必须是同一个节点').toBe(blockBefore);
    expect(
      container.firstElementChild?.firstElementChild,
      '头像必须是同一个节点 —— 换了就等于被卸载重建，用户看到的就是"闪一下"',
    ).toBe(avatarBefore);
    expect(container.querySelector('[data-testid="thinking-indicator"]'), '内容到了跳动点就该没了').toBeNull();
    expect(container.textContent).toContain('你好');

    act(() => root.unmount());
  });
});
