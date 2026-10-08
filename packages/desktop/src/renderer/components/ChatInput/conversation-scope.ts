import { useEffect, useRef } from 'react';

/**
 * 会话级临时状态的归属（BUG-028，2026-10-06 真机反馈 D 组）。
 *
 * 输入框**不随会话重挂载**（见 `MainArea` 里"不能挂 `key={activeTaskId}`"的注释：
 * 一挂 key，发送时的那次 pending→真任务就会把整列（含正在打字的输入框）卸载重建）。
 * 于是输入框里的组件内 state 天然是"跨会话活着"的 —— 上一段对话暂存的附件、打了一半的
 * 草稿、选了一半的引用，都会跟着用户走进新对话。这一条规则就是给它们划边界：
 *
 *   **离开一段已经存在的对话 ⇒ 这段对话的临时状态到此为止。**
 *
 * 两个边界都是踩过的坑，别"顺手简化"：
 *
 * 1. `null → task-B`（**发送把待发任务提交成真任务**）不算切换。
 *    那一刻并不是"换了一段对话"，而是"这段对话刚开始"：`startNewTask` 先置
 *    `activeTaskId = null`，用户按下发送时才由 `commitPendingTask()` 落成真任务。
 *    把它当成切换的话，刚发出去、还在飞的那条消息的暂存附件与草稿会被当场清掉 ——
 *    发送失败时用户得重新贴一遍文件、重打一遍字。
 * 2. `A → A`（挂载、原地重渲染）不算切换，否则输入框一渲染就被清空。
 *
 * 反过来 `A → null`（用户点了「新建对话」/切回欢迎屏）**必须**清：那正是"新对话"
 * 的起点，也是本 bug 的原始场景。
 *
 * ⚠️ 但要注意 `null → task-B` 也可能来自"用户在待发状态点了列表里**另一段已有对话**"。
 *    这一支**不清**是有意的：那时待发状态里根本没有"上一段对话"可漏，而用户在此期间
 *    暂存的附件/草稿是他**现在**正在写的东西 —— 清了才是丢用户的数据。
 */
export function shouldResetComposerOnConversationChange(
  previousTaskId: string | null,
  nextTaskId: string | null,
): boolean {
  if (previousTaskId === nextTaskId) return false;
  return previousTaskId !== null;
}

/**
 * 在"离开一段对话"时执行一次 `reset`（会话级临时状态的清理动作）。
 *
 * `reset` 允许每次渲染都是新函数（内部用 ref 取最新那一个）：清理动作本身不该
 * 影响"什么时候清"的判定，否则调用方每次传个内联箭头函数就会把 effect 变成
 * "每次渲染都跑"。
 */
export function useConversationLeaveReset(currentTaskId: string | null, reset: () => void): void {
  const previousTaskIdRef = useRef<string | null>(currentTaskId);
  const resetRef = useRef(reset);
  useEffect(() => {
    resetRef.current = reset;
  }, [reset]);
  useEffect(() => {
    const previousTaskId = previousTaskIdRef.current;
    previousTaskIdRef.current = currentTaskId;
    if (!shouldResetComposerOnConversationChange(previousTaskId, currentTaskId)) return;
    resetRef.current();
  }, [currentTaskId]);
}
