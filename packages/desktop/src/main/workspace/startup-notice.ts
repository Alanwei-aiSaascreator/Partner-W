import type { WorkspaceStartupDecision } from './portable.js';

/**
 * 「这次启动把工作区**重建**过」这条结论的**可读记录**（渲染层用它做非阻断告知）。
 *
 * ## 边界（教义照抄 `portable.ts`，别扩大）
 *
 * - 只有 `recreated`（本机目录被删、卷还在）出通知；`healed` 是"找回了原工作区"
 *   （数据完好，刻意静默）、`ask-user` 自己会弹框、`auto-portable`/`default` 是首启
 *   ——一律 `null`。
 * - **不改行为**：重建照旧、不阻断、绝不改成选盘对话框。
 * - 生命周期 = 一次启动：条件天然只存活这一轮（重建后的目录下次启动就"存在"了）；
 *   用户在设置里切换工作区 ⇒ `clear`（`workspace:setup` / `workspace:change` 两处）。
 */
export interface WorkspaceStartupNotice {
  kind: 'recreated';
  path: string;
  at: number;
}

let current: WorkspaceStartupNotice | null = null;

export function recordWorkspaceStartupDecision(decision: WorkspaceStartupDecision, now = Date.now()): void {
  current = decision.kind === 'recreated' ? { kind: 'recreated', path: decision.path, at: now } : null;
}

export function readWorkspaceStartupNotice(): WorkspaceStartupNotice | null {
  return current;
}

export function clearWorkspaceStartupNotice(): void {
  current = null;
}
