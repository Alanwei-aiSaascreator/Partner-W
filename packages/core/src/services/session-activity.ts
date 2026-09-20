import type { ActiveTurn } from '../stores/message-store.js';
import type { Task, TaskRoom } from '@clawwork/shared';

export type SessionActivity = 'idle' | 'waiting' | 'responding' | 'tooling';

export function getTaskSessionKeys(task: Pick<Task, 'sessionKey'>, room?: Pick<TaskRoom, 'performers'>): string[] {
  return [task.sessionKey, ...(room?.performers.map((performer) => performer.sessionKey) ?? [])];
}

export function deriveSessionActivity(
  sessionKeys: string[],
  activeTurnBySession: Record<string, ActiveTurn | undefined>,
  processingBySession: ReadonlySet<string>,
): SessionActivity {
  let waiting = false;
  let tooling = false;

  for (const sessionKey of sessionKeys) {
    if (processingBySession.has(sessionKey)) waiting = true;

    const turn = activeTurnBySession[sessionKey];
    if (!turn || turn.finalized) continue;

    if (turn.streamingText || turn.streamingThinking) return 'responding';
    if (turn.toolCalls.length > 0) tooling = true;
  }

  if (tooling) return 'tooling';
  if (waiting) return 'waiting';
  return 'idle';
}

/** 一个 turn 现在**有没有东西可渲染**（与 `MainArea` 渲染流式块的条件同一套判据）。 */
function isRenderableTurn(turn: ActiveTurn | undefined): boolean {
  return Boolean(turn && (turn.finalized || turn.streamingText || turn.streamingThinking || turn.toolCalls.length > 0));
}

/**
 * `activity === 'waiting'` 时，界面要给**哪一个会话**渲染"等待中"的助手块。
 *
 * ## 为什么需要这个函数（2026-09-20 实机报障）
 *
 * 用户：「我发完要求，那个对话头像会消失一下，然后再给我反馈」。
 * 根因：等待态渲染的是**另一个组件**（`ThinkingIndicator`，它自带一个头像），
 * 内容一到就换成 `StreamingMessage`（另一个头像）——
 * 两个块各自淡入淡出、**同一帧里两个头像并存**（MutationObserver 实测抓到），
 * 看起来就是"头像闪一下"。
 *
 * 修法是让等待态也走 `StreamingMessage`、**用同一个 key**，React 复用同一个节点，
 * 头像从头到尾是同一个。这个函数就是"该给哪个会话渲染它"。
 *
 * ⚠️ 取**第一个**匹配的（`sessionKeys` 的顺序是「主会话在前、performers 在后」）——
 *    与修之前"整屏只有一个等待指示器"的行为保持一致。
 */
export function pickWaitingSessionKey(
  sessionKeys: string[],
  activeTurnBySession: Record<string, ActiveTurn | undefined>,
  processingBySession: ReadonlySet<string>,
): string | undefined {
  return sessionKeys.find(
    (sessionKey) => processingBySession.has(sessionKey) && !isRenderableTurn(activeTurnBySession[sessionKey]),
  );
}
