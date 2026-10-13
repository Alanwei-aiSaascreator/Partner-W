import { useEffect } from 'react';
import type { ExecutionEvent } from '@clawwork/core';
import { useTaskStore } from '../stores/taskStore';
import { useMessageStore } from '../stores/messageStore';

/**
 * ⭐ V4（I 接线）：从本地执行历史恢复一个会话的投影。
 *
 * 边界（同 V4 口径，直接写进实现，别在心里记）：**只还原本地已写证据** —— 读不到就
 * 空手回来（不补造 done/审批通过）；归约层只接受一个 runId ⇒ 最新 run 先落、其余被拒
 * （同 ID 重放由 writer 读侧去重，重放不重复计）。有界：至多读 8 个 run。
 */
export async function recoverExecutionHistoryForSession(sessionKey: string): Promise<void> {
  const api = window.clawwork;
  if (!api?.executionHistoryListRuns || !api?.executionHistoryReadRun) return;
  const runIds = await api.executionHistoryListRuns(sessionKey);
  if (!Array.isArray(runIds) || runIds.length === 0) return;
  const reads = await Promise.all(
    runIds.slice(0, 8).map(async (runId) => {
      try {
        return await api.executionHistoryReadRun(sessionKey, runId);
      } catch {
        return null;
      }
    }),
  );
  const ordered = reads
    .filter(
      (read): read is NonNullable<typeof read> => !!read && Array.isArray(read.records) && read.records.length > 0,
    )
    .sort((a, b) => (b.records[0]?.receivedAt ?? 0) - (a.records[0]?.receivedAt ?? 0));
  for (const read of ordered) {
    useMessageStore.getState().applyExecutionEvents(sessionKey, read.records);
  }
}

/** 激活任务变化时，从本地历史恢复该会话（受 workspaceEpoch 归属校验）。 */
export function useExecutionHistoryRecovery(): void {
  const epoch = useTaskStore((state) => state.workspaceEpoch);
  const activeTaskId = useTaskStore((state) => state.activeTaskId);
  const sessionKey = useTaskStore(
    (state) => state.tasks.find((task) => task.id === state.activeTaskId)?.sessionKey ?? null,
  );
  useEffect(() => {
    if (!sessionKey) return;
    if (useTaskStore.getState().workspaceEpoch !== epoch) return;
    void recoverExecutionHistoryForSession(sessionKey);
  }, [epoch, activeTaskId, sessionKey]);
}

/**
 * ⭐ V3-artifact（2026-10-13/14，I 接线）：主进程执行事件（交付/取消两族）→ 执行投影。
 *
 * 与 `useDeliveryActivitySubscription` 同纪律：按 workspaceEpoch 归属校验、卸载即退订。
 * 边界（沿用主进程出口的文件头口径）：渲染层缺席/关闭时事件丢失是已知边界——
 * 投影终态不依赖单帧到达（终态不回退 + 结算事件各自幂等），这里**不重放、不补造**。
 */
export function useExecutionEventsSubscription(): void {
  const epoch = useTaskStore((state) => state.workspaceEpoch);
  useEffect(() => {
    const ownsEpoch = () => useTaskStore.getState().workspaceEpoch === epoch;
    const unsubscribe = window.clawwork.onExecutionEvents?.(({ sessionKey, events }) => {
      if (!ownsEpoch()) return;
      if (!sessionKey || !Array.isArray(events) || events.length === 0) return;
      useMessageStore.getState().applyExecutionEvents(sessionKey, events as ExecutionEvent[]);
    });
    return () => unsubscribe?.();
  }, [epoch]);
}
