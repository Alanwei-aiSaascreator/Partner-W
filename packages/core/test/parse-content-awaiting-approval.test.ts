import { describe, expect, it } from 'vitest';
import { isAwaitingApproval } from '../src/protocol/parse-content';

/**
 * `isAwaitingApproval` —— 判「**命令还没跑，正等着人批准**」。
 *
 * ⚠️ 为什么非要单独判一件事：运行时的 `ExecToolDetails.status` 是个闭集，
 *    其中 **`approval-pending`**（命令挂起等审批）**不在** `isToolResultError`
 *    的失败清单里、而且那个分支**没有 `exitCode` 字段** ⇒ 判断一路兜底
 *    `return false` ⇒ 工具流那一帧带的是 **`isError: false`**。
 *
 *    照 `isError` 直接落地 ⇒ **一条一步都没跑的命令，卡片显示「已完成」**；
 *    而且**没有任何后续帧会纠正它**（`approval` 流的 `pending` 我们刻意不接）。
 *
 * ⚠️ 同族的 `approval-unavailable` **在**失败清单里，但它被 `approvalUnavailable`
 *    压掉 ⇒ 那一帧**同样**是 `isError: false`。**那条路不归这里管**：它由
 *    `approval` 流兜住，且已有回归用例钉着 ⇒ 这个函数**只**认 `approval-pending`。
 *    （收窄是刻意的：把它一起收进来是对既有行为的改动，属另一个决定。）
 */

/** 真实帧（2026-09-09 `~/git/openclaw` 的 fixture，字段逐个照抄）。 */
const REAL_FRAME = {
  content: [{ type: 'text', text: 'Command requires approval.' }],
  details: {
    status: 'approval-pending',
    approvalId: '12345678-1234-1234-1234-123456789012',
    approvalSlug: '12345678',
    expiresAtMs: 1_800_000_000_000,
    host: 'gateway',
    command: 'npm view diver name version description',
    cwd: '/tmp/work',
    warningText: 'Warning: heredoc execution requires explicit approval in allowlist mode.',
  },
};

describe('isAwaitingApproval —— 认出「挂起等审批」', () => {
  it('⭐ 真实帧 ⇒ true', () => {
    expect(isAwaitingApproval(REAL_FRAME)).toBe(true);
  });

  it('⭐ 「审批不可用」**不**归它管（那条路由 approval 流兜，行为照旧）', () => {
    expect(
      isAwaitingApproval({
        content: [{ type: 'text', text: 'blocked' }],
        details: { status: 'approval-unavailable', reason: 'no-approval-channel' },
      }),
    ).toBe(false);
  });

  it.each(['completed', 'failed', 'running'])('对照：`status:"%s"` ⇒ false', (status) => {
    expect(isAwaitingApproval({ details: { status } })).toBe(false);
  });

  it('形状不认识时一律 false（**宁可说"不是"**：说错了会把真结果压成"还在跑"）', () => {
    expect(isAwaitingApproval(undefined)).toBe(false);
    expect(isAwaitingApproval(null)).toBe(false);
    expect(isAwaitingApproval('一段字符串结果')).toBe(false);
    expect(isAwaitingApproval(42)).toBe(false);
    expect(isAwaitingApproval({})).toBe(false);
    expect(isAwaitingApproval({ content: [{ type: 'text', text: 'hi' }] })).toBe(false);
    expect(isAwaitingApproval({ details: null })).toBe(false);
    expect(isAwaitingApproval({ details: 'not-an-object' })).toBe(false);
    expect(isAwaitingApproval({ details: {} })).toBe(false);
  });

  it('`details` 在别处时不算（只认工具结果自己的那一层）', () => {
    expect(isAwaitingApproval({ content: [{ type: 'text', text: 'x' }], detail: { status: 'approval-pending' } })).toBe(
      false,
    );
  });
});
