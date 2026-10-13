import { useEffect } from 'react';
import type { ExecutionEvent } from '@clawwork/core';
import { useTaskStore } from '../stores/taskStore';
import { useMessageStore } from '../stores/messageStore';
import { useDeliveryActivityStore } from '../stores/deliveryActivityStore';
import { markRunHydrated } from '../lib/execution-hydration-registry';

/**
 * ⭐ V4（I 接线）：从本地执行历史恢复一个会话的投影。
 *
 * 边界（同 V4 口径，直接写进实现，别在心里记）：**只还原本地已写证据** —— 读不到就
 * 空手回来（不补造 done/审批通过）；归约层只接受一个 runId ⇒ 最新 run 先落、其余被拒
 * （同 ID 重放由 writer 读侧去重，重放不重复计）。有界：至多读 8 个 run
 * （R4 后 `listRuns` 已保证**最新在前**，限额前排序问题在 main 侧解决）。
 *
 * ⭐ R2（2026-10-14 集中修复）· 异步归属纪律：
 *  - **每个 await 边界后复核** epoch / 取消位（切工作区、切账号、卸载 ⇒ 旧结果零应用）；
 *  - 应用走 **hydrate 模式**：恢复不重新 persist、不发完成通知（配
 *    `execution-hydration-registry` 对通知出口静默）、不触发业务操作；
 *  - 应用前过 `canHydrateExecution`：现场已有**别的 run**（新轮 activeTurn 或投影）
 *    ⇒ 旧历史整条跳过，不灌入新轮；
 *  - 重复恢复幂等（hydrate 重放由归约的等值判据吸收，不翻新投影引用）。
 */
export async function recoverExecutionHistoryForSession(
  sessionKey: string,
  options?: { isCancelled?: () => boolean; epoch?: number },
): Promise<void> {
  const api = window.clawwork;
  if (!api?.executionHistoryListRuns || !api?.executionHistoryReadRun) return;
  const cancelled = options?.isCancelled ?? (() => false);
  const epoch = options?.epoch;
  const stillCurrent = () => !cancelled() && (epoch === undefined || useTaskStore.getState().workspaceEpoch === epoch);
  const runIds = await api.executionHistoryListRuns(sessionKey);
  if (!stillCurrent()) return; // await 返回后复核（R2）
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
  if (!stillCurrent()) return; // 批量读回来再复核（R2）
  const ordered = reads
    .filter(
      (read): read is NonNullable<typeof read> => !!read && Array.isArray(read.records) && read.records.length > 0,
    )
    .sort((a, b) => (b.records[0]?.receivedAt ?? 0) - (a.records[0]?.receivedAt ?? 0));
  for (const read of ordered) {
    if (!stillCurrent()) return; // 逐条应用前复核（批次中途切区 ⇒ 余下零应用）
    const runId = read.records[0]?.runId;
    if (!runId) continue;
    const store = useMessageStore.getState();
    if (!store.canHydrateExecution(sessionKey, runId)) continue; // 现场已有别的 run ⇒ 旧历史不灌入
    markRunHydrated(sessionKey, runId); // 通知出口静默（R5 旁路三半）
    store.applyExecutionEvents(sessionKey, read.records, { mode: 'hydrate' });
  }
}

/** 激活任务变化时，从本地历史恢复该会话（受 workspaceEpoch 归属校验；卸载即取消）。 */
export function useExecutionHistoryRecovery(): void {
  const epoch = useTaskStore((state) => state.workspaceEpoch);
  const activeTaskId = useTaskStore((state) => state.activeTaskId);
  const sessionKey = useTaskStore(
    (state) => state.tasks.find((task) => task.id === state.activeTaskId)?.sessionKey ?? null,
  );
  useEffect(() => {
    if (!sessionKey) return;
    if (useTaskStore.getState().workspaceEpoch !== epoch) return;
    let cancelled = false;
    void recoverExecutionHistoryForSession(sessionKey, { isCancelled: () => cancelled, epoch });
    return () => {
      cancelled = true;
    };
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
    const unsubscribe = window.clawwork.onExecutionEvents?.(
      ({ sessionKey, events, workspaceScope, workspaceRevision }) => {
        if (!ownsEpoch()) return;
        // ⭐ 2026-10-14 五小时窗（IPC 在途来源校验，镜像 delivery-activity 兄弟通道）：
        //    帧必须自带**捕获时**的 scope/revision，且与渲染层当前权威 owner（由
        //    delivery-activity 快照维护的同一份 ArtifactWorkspaceScope）同代才收。
        //    "主进程校验通过后发出、到达前用户换区"的在途帧在此被拒；无 scope 帧
        //    一律拒（fail-closed）——不从当前 workspace 补 owner。
        const owner = useDeliveryActivityStore.getState().owner;
        if (!workspaceScope || owner.scope !== workspaceScope || owner.revision !== workspaceRevision) return;
        if (!sessionKey || !Array.isArray(events) || events.length === 0) return;
        useMessageStore.getState().applyExecutionEvents(sessionKey, events as ExecutionEvent[]);
      },
    );
    return () => unsubscribe?.();
  }, [epoch]);
}
