import type { ToolCall } from '@clawwork/shared';
import { describe, expect, it } from 'vitest';
import { latestAwaitingApproval, latestRunningCall, summarizeToolActivity } from '../src/renderer/lib/tool-activity';

/**
 * ⭐ A2 的**显示层**（2026-09-19 拍板）：审批等待期要**单独说一句**「等待批准」。
 *
 * 这一段管的是"状态怎么被**读出来**"：
 * - 活动条要能挑出"在等人的那条"（`latestAwaitingApproval`）——**不能**复用
 *   `latestRunningCall`，否则文案会变成「执行中：X」，而它**根本没在执行**；
 * - 汇总里它必须**算"没结束"** —— 少了这一步，`ToolCallSummary` 会据此
 *   把"等着人批准"渲染成 **`done`**（那就是撒谎，和这一条线一直在修的是同一类错）。
 */

function call(id: string, name: string, status: ToolCall['status']): ToolCall {
  return {
    id,
    name,
    status,
    startedAt: '2026-09-15T00:00:00.000Z',
    ...(status === 'running' || status === 'awaitingApproval' ? {} : { completedAt: '2026-09-15T00:00:01.000Z' }),
  };
}

describe('A2 · latestAwaitingApproval', () => {
  it('⭐ 挑得出"在等人批准"的那条', () => {
    const calls = [call('1', 'exec', 'done'), call('2', 'exec', 'awaitingApproval')];

    expect(latestAwaitingApproval(calls)?.id).toBe('2');
  });

  it('⭐ 多条时取**最新**那条（与 `latestRunningCall` 同一条规矩）', () => {
    const calls = [
      call('1', 'exec', 'awaitingApproval'),
      call('2', 'exec', 'done'),
      call('3', 'exec', 'awaitingApproval'),
    ];

    expect(latestAwaitingApproval(calls)?.id).toBe('3');
  });

  it('⭐⭐ **不复用** `running`：等批准的那条**不会**被 `latestRunningCall` 挑走', () => {
    // 这条是 A2 口径的核心："不要复用进行中"。
    // 如果这里返回了它，活动条就会说「执行中：X」—— 而它根本没在执行。
    const calls = [call('1', 'exec', 'awaitingApproval')];

    expect(latestRunningCall(calls)).toBeNull();
    expect(latestAwaitingApproval(calls)?.id).toBe('1');
  });

  it('对照：没有等批准的 ⇒ null', () => {
    expect(latestAwaitingApproval([call('1', 'exec', 'running'), call('2', 'exec', 'done')])).toBeNull();
    expect(latestAwaitingApproval([])).toBeNull();
    expect(latestAwaitingApproval([call('1', 'exec', 'error')])).toBeNull();
  });
});

describe('A2 · 汇总里它算"没结束"', () => {
  it('⭐⭐ 只有一条"等批准"时，`runningCount` **不能**是 0（否则会被渲染成 done）', () => {
    const summary = summarizeToolActivity([call('1', 'exec', 'awaitingApproval')]);

    expect(summary.runningCount, '0 的话 ToolCallSummary 会说"已完成"').toBe(1);
    expect(summary.completedCount).toBe(0);
    expect(summary.errorCount, '它也不是失败').toBe(0);
  });

  it('⭐ 它**不**被算成完成/失败，也不进 `groups` 的收尾', () => {
    const summary = summarizeToolActivity([call('1', 'exec', 'done'), call('2', 'exec', 'awaitingApproval')]);

    expect(summary.totalCount).toBe(2);
    expect(summary.completedCount).toBe(1);
    expect(summary.runningCount).toBe(1);
  });
});
