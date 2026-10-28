import { randomUUID } from 'node:crypto';
import type { ArtifactDeliveryTerminalStatus } from '@clawwork/shared';
import { getWorkspaceScope } from '../workspace/scope.js';
import { captureDeliveryActivityOwner, isDeliveryActivityOwnerCurrent } from '../db/delivery-activities.js';
import { beginArtifactDeliveryActivity } from './delivery-activity.js';
import type { ArtifactActivityCallback } from './activity-callback.js';
import { emitMainExecutionEvents } from './execution-events.js';

/**
 * ⭐ V3-artifact（2026-10-13/14）：终态 → 交付结算 outcome。
 *
 * 只把**完整**算 complete（V3 投影的同一条口径）：`needs-review`（有成品但未过复核/
 * 同批有成有败）与 `canceled`（被用户停掉）都不判完整 —— 如实"未确认"。
 */
function settlementOutcome(status: ArtifactDeliveryTerminalStatus): 'complete' | 'failed' | 'unconfirmed' {
  if (status === 'succeeded') return 'complete';
  if (status === 'failed') return 'failed';
  return 'unconfirmed';
}

/**
 * 捕获一次**可信生成请求登记**并返回该操作的交付句柄。
 *
 * 语义（V3-artifact，计划 §V3 交付实现）：
 *  - 调用点 = "这一轮确实被要求产出文件"的登记处（`data-handlers.finalizeAssistantArtifacts`
 *    已在 `claimArtifactRun` 拿到 run admission 之后；`videogen/start` 在解析出真实请求之后）
 *    —— **不是**从已出现的 artifact / activity / 助手文本倒推。
 *  - `delivery.started` 在登记这一刻发出（operationId 当场定号）：投影据此把 operation
 *    计入"本轮必需集合"——**两项请求只一项真正启动/另一项启动失败时，整轮仍知道缺一项**。
 *  - `delivery.phase` 在作业真正启动（第一次 `phase()`）时发；`delivery.settled` 在生产者
 *    走完 生成→写盘→校验→登记 之后的 `finish()` 发出（指纹绑定由生产者自己的时点承担）。
 *  - 事件经 `execution-events` 广播回渲染层折入 V3 投影；身份不足（无 runId）或
 *    **无有效 workspace scope/revision**（P-2，2026-10-14）时**不发** —— 不让投影把
 *    无归属的事件归到前台，也不让旧工作区的生产者向新代渲染层漏广播。
 *
 * ⚠️ 活动帧（`artifact:delivery-activity`）与执行事件共用**同一个 operationId**：两条通道
 * 说的是同一件事，界面引用哪条都不会串台。
 */
export function captureArtifactDeliveryOperation(identity: {
  taskId: string;
  sessionKey: string;
  messageId: string;
  runId?: string;
  gatewayId?: string;
}): {
  operationId: string;
  phase: ArtifactActivityCallback;
  finish: (status: ArtifactDeliveryTerminalStatus, artifactId?: string) => void;
} {
  const owner = getWorkspaceScope();
  const captured = { ...identity };
  // ⭐ P-3（2026-10-14）：帧身份里的 scope/revision = **捕获时**快照（不是发射时现取）——
  //    接收侧据此拒"发出后到达前换区"的在途帧。
  const eventIdentity = {
    taskId: captured.taskId,
    sessionKey: captured.sessionKey,
    runId: captured.runId,
    gatewayId: captured.gatewayId,
    workspaceScope: owner.scope,
    workspaceRevision: owner.revision,
  };
  // ⭐ 归属门（2026-10-14 集成修正，语义与 delivery-activity 兄弟通道对齐）：owner 替换
  //    （换库/换盘/换账号/换授权代次）后，旧流水线无论如何都不再向渲染层广播执行事件。
  //    判据 = scope+revision 快照等值（捕获后未被替换） + database 身份/licenseGeneration/binding。
  // ⭐ P-2 合同收口（2026-10-14 五小时窗）：**无有效 workspace scope ⇒ 一律不发** ——
  //    旧注释里"不要求 scope 非空（无库单测照常广播）"的豁免已撤销：那正是越界广播
  //    （旧工作区生产者向新代渲染层发帧）的来源；判据与 delivery-activity 句柄
  //    （`owner.scope !== null` + owner 当前）逐条对齐。
  const activityOwner = captureDeliveryActivityOwner();
  const ownsWorkspace = (): boolean => {
    const current = getWorkspaceScope();
    return (
      owner.scope !== null &&
      current.scope === owner.scope &&
      current.revision === owner.revision &&
      isDeliveryActivityOwnerCurrent(activityOwner)
    );
  };
  const operationId = randomUUID();
  let operation: ReturnType<typeof beginArtifactDeliveryActivity>;
  let ended = false;
  if (ownsWorkspace()) emitMainExecutionEvents(eventIdentity, [{ type: 'delivery.started', payload: { operationId } }]);
  return {
    operationId,
    phase: (phase, progress) => {
      if (ended) return;
      if (operation) operation.phase(phase, progress);
      else {
        operation = beginArtifactDeliveryActivity({ ...captured, owner, operationId }, phase, progress);
        if (operation && ownsWorkspace())
          emitMainExecutionEvents(eventIdentity, [{ type: 'delivery.phase', payload: { operationId, phase } }]);
      }
    },
    finish: (status, artifactId) => {
      if (ended) return;
      ended = true;
      if (artifactId) operation?.finish(status, artifactId);
      else operation?.finish(status);
      if (ownsWorkspace())
        emitMainExecutionEvents(eventIdentity, [
          { type: 'delivery.settled', payload: { operationId, outcome: settlementOutcome(status) } },
        ]);
    },
  };
}
