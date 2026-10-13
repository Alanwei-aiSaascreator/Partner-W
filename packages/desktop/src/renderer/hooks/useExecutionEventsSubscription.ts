import { useEffect } from 'react';
import type { ExecutionEvent } from '@clawwork/core';
import { useTaskStore } from '../stores/taskStore';
import { useMessageStore } from '../stores/messageStore';
import { useDeliveryActivityStore } from '../stores/deliveryActivityStore';
import { markRunHydrated } from '../lib/execution-hydration-registry';
import { noteTurnRegistration } from '../lib/turn-registration';

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
 *  - 应用前过 `canHydrateExecution`：现场已有**别的 run**（新轮 activeTurn 或投影
 *    ⇒ 含**身份屏障**，第二轮 R2-1）⇒ 旧历史整条跳过，不灌入新轮；
 *  - 重复恢复幂等（hydrate 重放由归约的等值判据吸收，不翻新投影引用）。
 *
 * ⭐ 第二轮（R2-8）：静默标记只在**确实应用了旧证据**（接受数 > 0）时登记 ——
 *   零应用不登记，避免把后续真正的 live 完成误静默（通知出口按一次性消费处理）。
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
    const applied = store.applyExecutionEvents(sessionKey, read.records, { mode: 'hydrate' });
    // R2-8：只有真正应用了旧证据才登记静默（该次状态变化由恢复引起）；零应用不登记。
    if (applied > 0) markRunHydrated(sessionKey, runId);
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

/** 初始化屏障的暂存上限（帧数；溢出如实丢弃并告警，不无界排队）。 */
const OWNER_INIT_STAGE_LIMIT = 64;

/**
 * ⭐ V3-artifact（2026-10-13/14，I 接线）：主进程执行事件（交付/取消两族）→ 执行投影。
 *
 * 与 `useDeliveryActivitySubscription` 同纪律：按 workspaceEpoch 归属校验、卸载即退订。
 * 边界（沿用主进程出口的文件头口径）：渲染层缺席/关闭时事件丢失是已知边界——
 * 投影终态不依赖单帧到达（终态不回退 + 结算事件各自幂等），这里**不重放、不补造**。
 *
 * ⭐ 第二轮（R2-4）· owner 初始化屏障前的有界暂存：
 *  - delivery-activity store 的权威 owner 由 scope-changed 事件/活动快照异步建立；
 *    在此之前（初始哨兵 `{scope:null,revision:-1}`），合法的当前代帧会被来源校验
 *    整条拒掉且 main 无 journal 可补。凡在**权威 owner 就绪前**到达的帧，进入
 *    本 epoch 实例的**有界暂存**（≤64 帧，溢出如实告警丢弃）；
 *  - 权威 owner 就绪（`ownerReady`）后，按**原始 scope/revision** 逐条过滤、按接收
 *    顺序折入（不匹配 ⇒ 丢弃；每条至多折一次）；
 *  - **不把第一帧当权威 owner**（暂存帧自带的 scope 永远不被采纳为 owner）；
 *  - 旧 epoch 实例卸载即销毁暂存；快照为空/失败 ⇒ ownerReady 永远不置位 ⇒ 暂存
 *    不折入（fail-closed），只是如实丢弃。
 *
 * ⭐ 第二轮（R5 P1）：同通道接收 main 的**轮次登记回执**（turn-registration）——
 * 完成资格不再由"投影里恰好没有 operation"反推；本 hook 只做归属校验与落表。
 */
export function useExecutionEventsSubscription(): void {
  const epoch = useTaskStore((state) => state.workspaceEpoch);
  useEffect(() => {
    const ownsEpoch = () => useTaskStore.getState().workspaceEpoch === epoch;
    const ownerMatches = (scope: string, revision: number): boolean => {
      const owner = useDeliveryActivityStore.getState().owner;
      return owner.scope === scope && owner.revision === revision;
    };
    const applyFrame = (payload: {
      sessionKey: string;
      events: ExecutionEvent[];
      workspaceScope: string | null;
      workspaceRevision: number;
    }): boolean => {
      if (!payload.workspaceScope || !ownerMatches(payload.workspaceScope, payload.workspaceRevision)) return false;
      if (!payload.sessionKey || !Array.isArray(payload.events) || payload.events.length === 0) return true;
      useMessageStore.getState().applyExecutionEvents(payload.sessionKey, payload.events);
      return true;
    };
    // 本 epoch 实例的初始化屏障暂存（卸载即销毁；溢出如实丢弃）。
    let stage: Array<{
      sessionKey: string;
      events: ExecutionEvent[];
      workspaceScope: string | null;
      workspaceRevision: number;
    }> = [];
    let overflowed = 0;
    const flushStage = (): void => {
      if (stage.length === 0) return;
      if (!useDeliveryActivityStore.getState().ownerReady) return;
      for (const frame of stage) applyFrame(frame);
      stage = [];
    };
    const unsubscribeStore = useDeliveryActivityStore.subscribe(() => {
      if (!ownsEpoch()) return;
      flushStage();
    });
    const unsubscribeEvents = window.clawwork.onExecutionEvents?.((payload) => {
      if (!ownsEpoch()) return;
      // ⭐ 五小时窗（IPC 在途来源校验）：帧必须自带**捕获时**的 scope/revision，且与
      //    渲染层当前权威 owner（delivery-activity 同源快照）同代才收。"主进程校验
      //    通过后发出、到达前用户换区"的在途帧在此被拒；无 scope 帧一律拒
      //    （fail-closed）——不从当前 workspace 补 owner。
      if (!payload.workspaceScope || !Array.isArray(payload.events) || payload.events.length === 0) return;
      if (applyFrame(payload)) return;
      // R2-4：权威 owner 未就绪 ⇒ 初始化屏障内有界暂存；已就绪而不同代 ⇒ 在途旧帧，拒。
      if (useDeliveryActivityStore.getState().ownerReady) return;
      if (stage.length >= OWNER_INIT_STAGE_LIMIT) {
        overflowed += 1;
        if (overflowed === 1 || overflowed % 16 === 0) {
          console.warn(
            `[execution-events] owner-before-init stage overflow, dropping frame(s) (overflowed=${overflowed})`,
          );
        }
        return;
      }
      stage.push(payload);
    });
    const unsubscribeRegistration = window.clawwork.onTurnRegistration?.((payload) => {
      if (!ownsEpoch()) return;
      // 登记回执与执行事件同款归属纪律：无 scope / 不同代 ⇒ 拒（回执按 session|run 落表，
      // 不补 owner、不暂存——初始化窗口后的首轮远晚于快照，丢失只是 fail-closed 不通知）。
      if (!payload?.workspaceScope || !ownerMatches(payload.workspaceScope, payload.workspaceRevision)) return;
      if (!payload.sessionKey || !payload.runId) return;
      if (payload.status !== 'registered' && payload.status !== 'needs-review' && payload.status !== 'none-expected')
        return;
      noteTurnRegistration({
        taskId: payload.taskId,
        sessionKey: payload.sessionKey,
        runId: payload.runId,
        status: payload.status,
        expectedKinds: Array.isArray(payload.expectedKinds) ? payload.expectedKinds : [],
      });
    });
    return () => {
      unsubscribeStore?.();
      unsubscribeEvents?.();
      unsubscribeRegistration?.();
    };
  }, [epoch]);
}
