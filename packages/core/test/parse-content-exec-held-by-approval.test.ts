import { describe, expect, it } from 'vitest';
import { EXEC_APPROVAL_HELD_STATUSES, isExecHeldByApproval } from '../src/protocol/parse-content';

/**
 * `isExecHeldByApproval` —— 判「**这一帧不代表跑完了**（被审批按住了）」。
 *
 * ⚠️ 为什么非要单独判一件事：运行时的 `ExecToolDetails.status` 是个闭集，
 *    而**两个**"没跑完"的取值在工具流那一帧上**都带 `isError: false`**：
 *
 *    - `approval-pending` **不在** `isToolResultError` 的失败清单里、
 *      且那个分支**没有 `exitCode` 字段** ⇒ 判断一路兜底 `return false`；
 *    - `approval-unavailable` **在**失败清单里，但被 `approvalUnavailable` 压掉。
 *
 *    照 `isError` 直接落地 ⇒ **一条一步都没跑的命令，卡片显示「已完成」**。
 *
 * ⚠️ **2026-09-19 扩到两个值**（用户拍板"不让它先闪"）：原先只认 `pending`，
 *    理由是 `unavailable` 随后会被 `approval` 流压成 `error` —— **最终**态是对的，
 *    但中间会**先闪一下「已完成」**再被纠正。现在两个**同一条待遇**。
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

describe('isExecHeldByApproval —— 认出「被审批按住」', () => {
  it('⭐ 真实帧（`approval-pending`）⇒ true', () => {
    expect(isExecHeldByApproval(REAL_FRAME)).toBe(true);
  });

  it('⭐⭐ 「审批不可用」（`approval-unavailable`）**也** ⇒ true（不再先闪「已完成」）', () => {
    expect(
      isExecHeldByApproval({
        content: [{ type: 'text', text: 'blocked' }],
        details: { status: 'approval-unavailable', reason: 'no-approval-channel' },
      }),
    ).toBe(true);
  });

  it.each(['completed', 'failed', 'running'])('对照：`status:"%s"` ⇒ false', (status) => {
    expect(isExecHeldByApproval({ details: { status } })).toBe(false);
  });

  it('形状不认识时一律 false（**宁可说"不是"**：说错了会把真结果压成"还在跑"）', () => {
    expect(isExecHeldByApproval(undefined)).toBe(false);
    expect(isExecHeldByApproval(null)).toBe(false);
    expect(isExecHeldByApproval('一段字符串结果')).toBe(false);
    expect(isExecHeldByApproval(42)).toBe(false);
    expect(isExecHeldByApproval({})).toBe(false);
    expect(isExecHeldByApproval({ content: [{ type: 'text', text: 'hi' }] })).toBe(false);
    expect(isExecHeldByApproval({ details: null })).toBe(false);
    expect(isExecHeldByApproval({ details: 'not-an-object' })).toBe(false);
    expect(isExecHeldByApproval({ details: {} })).toBe(false);
  });

  it('`details` 在别处时不算（只认工具结果自己的那一层）', () => {
    expect(
      isExecHeldByApproval({ content: [{ type: 'text', text: 'x' }], detail: { status: 'approval-pending' } }),
    ).toBe(false);
  });

  it('⭐ 冻结名单：`ExecToolDetails.status` 里"没跑完"的**就这两个**（多一个就红）', () => {
    // 权威来源：`src/agents/bash-tools.exec-types.ts` 的 `ExecToolDetails` 联合（闭集，四个）：
    // `running` / `completed|failed` / `approval-pending` / `approval-unavailable`。
    // ⇒ 除了这两个，"跑完了"的那些一个都不许进来。
    expect(EXEC_APPROVAL_HELD_STATUSES).toEqual(['approval-pending', 'approval-unavailable']);
    for (const ran of ['completed', 'failed', 'running']) {
      expect(EXEC_APPROVAL_HELD_STATUSES, `"${ran}" 是跑完/在跑，不许当成被按住`).not.toContain(ran);
    }
  });
});
