import type { ExecutionEvent } from '../protocol/execution-events.js';

/**
 * V2（2026-10-13 集中整改 step 2）：执行投影的**纯归约**（05 §4 状态归约规则）。
 *
 * 挂在现有 store 生命周期上（`message-store` 的 `executionBySession` 字段 + 一个
 * `applyExecutionEvents` 动作），**不创建并行执行 store**、无执行副作用。
 *
 * ## 归约规则
 *
 * - **旧 run 晚包不写新 run**：`runId` 不匹配的事件整条拒收（主守卫在 dispatcher 的
 *   `acceptsRun`；这里是归约层防线）。无 run 归属（''）的事件同样拒收 ——
 *   cron 无任务归属不归到前台。
 * - **终态不回退**：done/error 之后迟到的 declared/dispatched/旧 progress 不改状态；
 *   unreported **不是**事实终态 —— 同 run 真实结果到达可补正。
 * - **unreported 投影**：model.ended/failed 时仍未收尾的步骤（declared/dispatched/
 *   awaitingApproval）投影为 unreported（与展示层 `markUnreportedCalls` 同语义）。
 * - **stepKey** = gateway|nativeSession|nativeRun|toolCallId —— 双 child 相同 toolCallId
 *   不串台；**不按文本去重**（同文两次合法结果是两个事实）。
 * - 源时间（occurredAt）与首次观察时间（firstObservedAt = receivedAt）**分开**。
 */

export type ExecutionStepState = 'declared' | 'dispatched' | 'awaitingApproval' | 'done' | 'error' | 'unreported';

export interface ExecutionStep {
  stepKey: string;
  stepId: string;
  name: string;
  state: ExecutionStepState;
  /** 源时间（ms）；没有则留空 —— 不冒充首次观察时间。 */
  occurredAt?: number;
  firstObservedAt: number;
  lastObservedAt: number;
}

export type ExecutionModelPhase = 'idle' | 'started' | 'ended' | 'failed';

export interface ExecutionProjection {
  /** 本地逻辑用户回合；'' = 尚未归属。 */
  runId: string;
  modelPhase: ExecutionModelPhase;
  steps: Record<string, ExecutionStep>;
  /** V3：审批投影（按 gatewayId|approvalId 独立归并；多审批并行互不清）。 */
  approvals: Record<string, ExecutionApproval>;
  /** V3：停止 ticket 投影（requested → confirmed/unconfirmed；无 ticket 不造停止态）。 */
  stop: ExecutionStop;
  /** V3：交付投影（operation 来自可信生成请求登记；活动作业未结算保持交付中）。 */
  delivery: ExecutionDelivery;
  /** 已接收的最大本地回合序号（晚到低 seq 不回拨）。 */
  lastSeq: number;
}

export type ExecutionApprovalState = 'requested' | 'resolved' | 'denied' | 'failed' | 'expired';

export interface ExecutionApproval {
  /** gatewayId|approvalId —— 相同 approvalId 来自不同 gateway 不串。 */
  approvalKey: string;
  approvalId: string;
  state: ExecutionApprovalState;
  toolCallId?: string;
  name?: string;
  decision?: string;
  firstObservedAt: number;
  lastObservedAt: number;
}

export type ExecutionStopState = 'none' | 'requested' | 'confirmed' | 'unconfirmed';

export interface ExecutionStop {
  state: ExecutionStopState;
  stopTicketId?: string;
  reason?: string;
  lastObservedAt: number;
}

export type DeliveryOperationOutcome = 'complete' | 'failed' | 'unconfirmed';

export interface DeliveryOperation {
  /** gatewayId|operationId —— 跨 gateway 同名 operation 不串。 */
  operationKey: string;
  operationId: string;
  kind?: string;
  requested: boolean;
  started: boolean;
  outcome?: DeliveryOperationOutcome;
  firstObservedAt: number;
  lastObservedAt: number;
}

export type ExecutionDeliveryOutcome = 'complete' | 'partial' | 'failed' | 'unconfirmed';

export interface ExecutionDelivery {
  phase: 'none' | 'pending' | 'settled';
  outcome?: ExecutionDeliveryOutcome;
  operations: Record<string, DeliveryOperation>;
}

export function createExecutionProjection(runId = ''): ExecutionProjection {
  return {
    runId,
    modelPhase: 'idle',
    steps: {},
    approvals: {},
    stop: { state: 'none', lastObservedAt: -1 },
    delivery: { phase: 'none', operations: {} },
    lastSeq: -1,
  };
}

/**
 * 状态权重（与 `message-store` 的 `toolStatusRank` 同族口径）：
 * declared < dispatched < unreported < awaitingApproval < done < error。
 * `unreported` 高于 dispatched/declared：晚到的旧声明/start 不得把它盖回"处理中"，
 * 只有**真实结果**（awaitingApproval/done/error）能补正它。
 */
const STEP_STATE_RANK: Readonly<Record<ExecutionStepState, number>> = {
  declared: 0,
  dispatched: 1,
  unreported: 2,
  awaitingApproval: 3,
  done: 4,
  error: 5,
};

export function stepKeyOf(
  gatewayId: string,
  nativeSessionKey: string | undefined,
  nativeRunId: string | undefined,
  toolCallId: string,
): string {
  return [gatewayId, nativeSessionKey ?? '', nativeRunId ?? '', toolCallId].join('|');
}

function stepStateForEvent(event: ExecutionEvent): ExecutionStepState | null {
  switch (event.type) {
    case 'step.declared':
      return 'declared';
    case 'step.dispatched':
      return 'dispatched';
    case 'step.result':
      if (event.payload.heldByApproval) return 'awaitingApproval';
      return event.payload.isError ? 'error' : 'done';
    default:
      return null;
  }
}

function foldStep(
  steps: Record<string, ExecutionStep>,
  event: ExecutionEvent,
  base: ExecutionProjection,
): { steps: Record<string, ExecutionStep>; changed: boolean } {
  if (event.type !== 'step.declared' && event.type !== 'step.dispatched' && event.type !== 'step.result') {
    return { steps, changed: false };
  }
  const { toolCallId, name } = event.payload;
  const stepKey = stepKeyOf(
    event.source.gatewayId,
    event.source.nativeSessionKey,
    event.source.nativeRunId,
    toolCallId,
  );
  const incomingState = stepStateForEvent(event);
  if (!incomingState) return { steps, changed: false };
  const incomingRank = STEP_STATE_RANK[incomingState];
  const existing = steps[stepKey];
  if (existing && STEP_STATE_RANK[existing.state] > incomingRank) {
    // 终态不被旧 progress 回退；旧声明/start 不盖回处理中。
    return { steps, changed: false };
  }
  const occurredAt = event.occurredAt;
  if (
    existing &&
    existing.state === incomingState &&
    existing.occurredAt === occurredAt &&
    base.lastSeq === event.seq
  ) {
    return { steps, changed: false }; // 等值重复 ⇒ 引用不变（与 store 写入器同纪律）
  }
  return {
    steps: {
      ...steps,
      [stepKey]: {
        stepKey,
        stepId: toolCallId,
        name,
        state: incomingState,
        ...(occurredAt !== undefined
          ? { occurredAt }
          : existing?.occurredAt !== undefined
            ? { occurredAt: existing.occurredAt }
            : {}),
        firstObservedAt: existing?.firstObservedAt ?? event.receivedAt,
        lastObservedAt: event.receivedAt,
      },
    },
    changed: true,
  };
}

function projectUnreported(steps: Record<string, ExecutionStep>): Record<string, ExecutionStep> {
  const entries = Object.values(steps);
  if (!entries.some((step) => STEP_STATE_RANK[step.state] < STEP_STATE_RANK.unreported)) return steps;
  const next: Record<string, ExecutionStep> = {};
  for (const step of entries) {
    next[step.stepKey] =
      STEP_STATE_RANK[step.state] < STEP_STATE_RANK.unreported ? { ...step, state: 'unreported' } : step;
  }
  return next;
}

const APPROVAL_TERMINAL_STATES: ReadonlySet<ExecutionApprovalState> = new Set([
  'resolved',
  'denied',
  'failed',
  'expired',
]);

function foldApproval(
  approvals: Record<string, ExecutionApproval>,
  event: ExecutionEvent,
): { approvals: Record<string, ExecutionApproval>; changed: boolean } {
  if (event.type !== 'approval.requested' && event.type !== 'approval.resolved') {
    return { approvals, changed: false };
  }
  const approvalKey = `${event.source.gatewayId}|${event.payload.approvalId}`;
  const existing = approvals[approvalKey];

  if (event.type === 'approval.requested') {
    if (existing) return { approvals, changed: false }; // 重复 requested 幂等（保留首见时间）
    return {
      approvals: {
        ...approvals,
        [approvalKey]: {
          approvalKey,
          approvalId: event.payload.approvalId,
          state: 'requested',
          ...(event.payload.toolCallId !== undefined ? { toolCallId: event.payload.toolCallId } : {}),
          ...(event.payload.name !== undefined ? { name: event.payload.name } : {}),
          firstObservedAt: event.receivedAt,
          lastObservedAt: event.receivedAt,
        },
      },
      changed: true,
    };
  }

  // approval.resolved：RPC 失败/过期/重复 resolved 都有明确投影。
  // ⚠️ 两个来源的拒绝词表不同：agent approval 流 status 用 `denied`/`failed`，
  //    顶层 exec.approval.resolved 的 decision 用 `deny` —— 都映射到对应终态。
  const terminal: ExecutionApprovalState = event.payload.rpcError
    ? 'failed'
    : event.payload.expired
      ? 'expired'
      : event.payload.decision === 'deny' || event.payload.decision === 'denied'
        ? 'denied'
        : event.payload.decision === 'failed'
          ? 'failed'
          : 'resolved';
  if (existing && APPROVAL_TERMINAL_STATES.has(existing.state)) {
    // 终态后重复 resolved 不回退（证据终态不被旧/重复回执回退）。
    return { approvals, changed: false };
  }
  return {
    approvals: {
      ...approvals,
      [approvalKey]: {
        approvalKey,
        approvalId: event.payload.approvalId,
        state: terminal,
        ...(existing?.toolCallId !== undefined || event.payload.toolCallId !== undefined
          ? { toolCallId: event.payload.toolCallId ?? existing?.toolCallId }
          : {}),
        ...(existing?.name !== undefined ? { name: existing.name } : {}),
        ...(event.payload.decision !== undefined ? { decision: event.payload.decision } : {}),
        firstObservedAt: existing?.firstObservedAt ?? event.receivedAt,
        lastObservedAt: event.receivedAt,
      },
    },
    changed: true,
  };
}

function foldStop(stop: ExecutionStop, event: ExecutionEvent): { stop: ExecutionStop; changed: boolean } {
  if (event.type === 'cancel.requested') {
    if (stop.state !== 'none') return { stop, changed: false };
    return {
      stop: {
        state: 'requested',
        ...(event.payload.stopTicketId !== undefined ? { stopTicketId: event.payload.stopTicketId } : {}),
        ...(event.payload.reason !== undefined ? { reason: event.payload.reason } : {}),
        lastObservedAt: event.receivedAt,
      },
      changed: true,
    };
  }
  if (event.type === 'cancel.confirmed' || event.type === 'cancel.unconfirmed') {
    // 没有 requested 的回执是噪音；ticket 不匹配的旧回执不清新请求。
    if (stop.state !== 'requested') return { stop, changed: false };
    if (
      event.payload.stopTicketId !== undefined &&
      stop.stopTicketId !== undefined &&
      event.payload.stopTicketId !== stop.stopTicketId
    ) {
      return { stop, changed: false };
    }
    return {
      stop: {
        state: event.type === 'cancel.confirmed' ? 'confirmed' : 'unconfirmed',
        ...(stop.stopTicketId !== undefined ? { stopTicketId: stop.stopTicketId } : {}),
        ...(event.type === 'cancel.unconfirmed' && event.payload.reason !== undefined
          ? { reason: event.payload.reason }
          : {}),
        lastObservedAt: event.receivedAt,
      },
      changed: true,
    };
  }
  return { stop, changed: false };
}

function aggregateDeliveryOutcome(operations: DeliveryOperation[]): ExecutionDeliveryOutcome | undefined {
  if (operations.length === 0) return undefined;
  const outcomes = operations.map((op) => op.outcome);
  if (outcomes.every((o) => o === 'complete')) return 'complete';
  if (outcomes.some((o) => o === 'complete')) return 'partial';
  if (outcomes.some((o) => o === 'failed')) return 'failed';
  return 'unconfirmed';
}

function foldDelivery(
  delivery: ExecutionDelivery,
  event: ExecutionEvent,
): { delivery: ExecutionDelivery; changed: boolean } {
  if (event.type !== 'delivery.started' && event.type !== 'delivery.phase' && event.type !== 'delivery.settled') {
    return { delivery, changed: false };
  }
  const operationKey = `${event.source.gatewayId}|${event.payload.operationId}`;
  const existing = delivery.operations[operationKey];

  if (event.type === 'delivery.started') {
    if (existing) return { delivery, changed: false };
    const operations = {
      ...delivery.operations,
      [operationKey]: {
        operationKey,
        operationId: event.payload.operationId,
        ...(event.payload.kind !== undefined ? { kind: event.payload.kind } : {}),
        requested: true,
        started: false,
        firstObservedAt: event.receivedAt,
        lastObservedAt: event.receivedAt,
      },
    };
    return {
      delivery: {
        phase: delivery.phase === 'none' ? 'pending' : delivery.phase,
        operations,
        ...(delivery.outcome !== undefined ? { outcome: delivery.outcome } : {}),
      },
      changed: true,
    };
  }

  if (!existing) return { delivery, changed: false }; // 未登记过的 operation 结算：不凭空造

  if (event.type === 'delivery.phase') {
    if (existing.started) return { delivery, changed: false };
    return {
      delivery: {
        ...delivery,
        operations: {
          ...delivery.operations,
          [operationKey]: { ...existing, started: true, lastObservedAt: event.receivedAt },
        },
      },
      changed: true,
    };
  }

  // delivery.settled：终态不回退；全部已请求 operation 结算后才判整轮交付。
  if (existing.outcome !== undefined) return { delivery, changed: false };
  const operations = {
    ...delivery.operations,
    [operationKey]: { ...existing, outcome: event.payload.outcome, lastObservedAt: event.receivedAt },
  };
  const all = Object.values(operations);
  const settled = all.every((op) => op.outcome !== undefined);
  return {
    delivery: {
      phase: settled ? 'settled' : delivery.phase,
      operations,
      ...(settled
        ? { outcome: aggregateDeliveryOutcome(all) }
        : delivery.outcome !== undefined
          ? { outcome: delivery.outcome }
          : {}),
    },
    changed: true,
  };
}

export function reduceExecutionProjection(previous: ExecutionProjection, event: ExecutionEvent): ExecutionProjection {
  // 旧 run 晚包 / 无归属：整条拒收（不写新 run、不归到前台）。
  if (event.runId === '') return previous;
  if (previous.runId && previous.runId !== event.runId) return previous;

  const runId = previous.runId || event.runId;
  const base: ExecutionProjection = { ...previous, runId };

  // model 相位：ended/failed 之后不回退（终态不被旧 progress 回退）。
  let modelPhase = base.modelPhase;
  if (event.type === 'model.started' && modelPhase === 'idle') modelPhase = 'started';
  else if (event.type === 'model.ended' && (modelPhase === 'idle' || modelPhase === 'started')) modelPhase = 'ended';
  else if (event.type === 'model.failed' && (modelPhase === 'idle' || modelPhase === 'started')) modelPhase = 'failed';

  const folded = foldStep(base.steps, event, base);
  const foldedApproval = foldApproval(base.approvals, event);
  const foldedStop = foldStop(base.stop, event);
  const foldedDelivery = foldDelivery(base.delivery, event);
  // 模型结束 ⇒ 仍未收尾的步骤投影为 unreported（真实结果到达仍可补正）。
  const steps = modelPhase === 'ended' || modelPhase === 'failed' ? projectUnreported(folded.steps) : folded.steps;
  const lastSeq = event.seq > base.lastSeq ? event.seq : base.lastSeq;

  if (
    !folded.changed &&
    !foldedApproval.changed &&
    !foldedStop.changed &&
    !foldedDelivery.changed &&
    modelPhase === base.modelPhase &&
    steps === base.steps &&
    lastSeq === base.lastSeq
  ) {
    return previous;
  }
  return {
    runId,
    modelPhase,
    steps,
    approvals: foldedApproval.approvals,
    stop: foldedStop.stop,
    delivery: foldedDelivery.delivery,
    lastSeq,
  };
}
