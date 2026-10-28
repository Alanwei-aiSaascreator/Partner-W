// @vitest-environment jsdom

/**
 * BUG-028 的规则本身：**什么时候该把"这段对话的临时状态"清掉**。
 *
 * 规则只有一条（`shouldResetComposerOnConversationChange`），但它的两个边界
 * 都是踩过的坑：
 *   - 「发送把待发任务提交成真任务」（`null → task-B`）**不是切换** —— 那一刻清掉，
 *     刚发出去、还在飞的那条消息的暂存附件/草稿就没了（发送失败时用户要重打一遍）；
 *   - 挂载/原地重渲染**不是切换** —— 否则输入框一渲染就被清空。
 */

import { act, useCallback } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import {
  shouldResetComposerOnConversationChange,
  useConversationLeaveReset,
} from '../src/renderer/components/ChatInput/conversation-scope';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render(ui: React.ReactElement): { rerender: (next: React.ReactElement) => void; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => root.render(ui));
  return {
    rerender: (next) => act(() => root.render(next)),
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe('shouldResetComposerOnConversationChange', () => {
  it('离开一段已有对话 ⇒ 清（新建、切到别的对话、切回欢迎屏都算）', () => {
    expect(shouldResetComposerOnConversationChange('task-A', null)).toBe(true);
    expect(shouldResetComposerOnConversationChange('task-A', 'task-B')).toBe(true);
  });

  it('待发任务被提交 / 原地重渲染 ⇒ 不清', () => {
    expect(shouldResetComposerOnConversationChange(null, 'task-B'), '提交那一刻是同一段对话的开始').toBe(false);
    expect(shouldResetComposerOnConversationChange(null, null)).toBe(false);
    expect(shouldResetComposerOnConversationChange('task-A', 'task-A')).toBe(false);
  });
});

describe('useConversationLeaveReset', () => {
  function Harness({ taskId, onLeave }: { taskId: string | null; onLeave: () => void }) {
    // ⚠️ 回调必须是稳定引用（真身里是 useCallback）：每次渲染换一个新函数
    //    不许让 effect 重跑 —— 那会让"原地重渲染"被误判成切换。
    const stable = useCallback(onLeave, [onLeave]);
    useConversationLeaveReset(taskId, stable);
    return <div data-testid="task">{taskId ?? 'none'}</div>;
  }

  it('挂载时不清，只有真的离开一段对话才清', () => {
    const onLeave = vi.fn();
    const view = render(<Harness taskId="task-A" onLeave={onLeave} />);
    expect(onLeave, '挂载 = 不是切换').not.toHaveBeenCalled();

    view.rerender(<Harness taskId="task-A" onLeave={onLeave} />);
    expect(onLeave, '原地重渲染不清').not.toHaveBeenCalled();

    view.rerender(<Harness taskId={null} onLeave={onLeave} />);
    expect(onLeave).toHaveBeenCalledTimes(1);

    view.rerender(<Harness taskId="task-B" onLeave={onLeave} />);
    expect(onLeave, 'null → 真任务（发送提交）不清').toHaveBeenCalledTimes(1);

    view.rerender(<Harness taskId="task-C" onLeave={onLeave} />);
    expect(onLeave, 'B → C 是切换，要清').toHaveBeenCalledTimes(2);
    view.unmount();
  });
});
