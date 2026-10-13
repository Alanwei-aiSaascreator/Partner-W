import { randomUUID } from 'node:crypto';
import type { ArtifactDeliveryTerminalStatus } from '@clawwork/shared';
import { getWorkspaceScope } from '../workspace/scope.js';
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
 *  - 事件经 `execution-events` 广播回渲染层折入 V3 投影；身份不足（无 runId）时**不发**，
 *    不让投影把无归属的事件归到前台。
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
}): { operationId: string; phase: ArtifactActivityCallback; finish: (status: ArtifactDeliveryTerminalStatus) => void } {
  const owner = getWorkspaceScope();
  const captured = { ...identity };
  const eventIdentity = {
    taskId: captured.taskId,
    sessionKey: captured.sessionKey,
    runId: captured.runId,
    gatewayId: captured.gatewayId,
  };
  const operationId = randomUUID();
  let operation: ReturnType<typeof beginArtifactDeliveryActivity>;
  let ended = false;
  emitMainExecutionEvents(eventIdentity, [{ type: 'delivery.started', payload: { operationId } }]);
  return {
    operationId,
    phase: (phase, progress) => {
      if (ended) return;
      if (operation) operation.phase(phase, progress);
      else {
        operation = beginArtifactDeliveryActivity({ ...captured, owner, operationId }, phase, progress);
        if (operation)
          emitMainExecutionEvents(eventIdentity, [{ type: 'delivery.phase', payload: { operationId, phase } }]);
      }
    },
    finish: (status) => {
      if (ended) return;
      ended = true;
      operation?.finish(status);
      emitMainExecutionEvents(eventIdentity, [
        { type: 'delivery.settled', payload: { operationId, outcome: settlementOutcome(status) } },
      ]);
    },
  };
}
