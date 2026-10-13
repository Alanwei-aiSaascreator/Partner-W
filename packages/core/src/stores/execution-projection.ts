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
    existing.name === name &&
    existing.occurredAt === occurredAt &&
    event.seq <= base.lastSeq
  ) {
    // 等值重复 ⇒ 引用不变（与 store 写入器同纪律）。2026-10-14（R2 幂等）：
    // 判据从 `base.lastSeq === event.seq` 放宽到 `event.seq <= base.lastSeq` ——
    // 恢复重放（hydrate）会整批重发**已观察过**的事件，只认"恰好等于最大 seq"会让
    // 批次里每个更早的等值事件都翻新一次投影（引用变、界面白提交）。语义不变：
    // 状态/名称/源时间全等且序号不比已观察的新 ⇒ 这不是新事实。
    return { steps, changed: false };
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
    const incoming = event.type === 'cancel.confirmed' ? 'confirmed' : 'unconfirmed';
    // 同状态重复回执幂等；confirmed 后迟到的 unconfirmed 拒收（终态不回退）。
    // ⭐ V4 修正（P 第二轮）：允许 unconfirmed → confirmed（ticket 匹配）升级 ——
    // 重连补发的"确认真成功"必须能把超时/拒绝的临时态拨回已停止。
    if (stop.state === incoming) return { stop, changed: false };
    const allowed = stop.state === 'requested' || (stop.state === 'unconfirmed' && incoming === 'confirmed');
    if (!allowed) return { stop, changed: false };
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
    // ⭐ V4 修正（P 第二轮）：settled 之后同 run 后到的第二个 operation 登记 ⇒ phase 必须
    // 拨回 pending —— 新作业未结算期间整轮仍在交付中（否则被当成已交付）。
    // outcome 保留最后值，待全部结算时重算。
    return {
      delivery: {
        phase: 'pending',
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

/**
 * R5（2026-10-14 集中修复）· **完成资格的唯一真源**。
 *
 * 复审旁路（preflight R5）：① 同 run 已 settled/failed/unconfirmed/partial 时 chat.final
 * 仍能走"任务完成"；② 可信交付登记的到达是异步的 —— final 当场看到 `none` 不能证明
 * 这是普通聊天；③ 已登记 A 完成即算 settled、模型还能继续生成 B —— 缺"需求封口"条件。
 * 这里把判据收成一处，dispatcher（core）与 renderer 交付出口/通知**共用同一个结论**，
 * 各自不得再写一份；`idempotencyKey` 提供 run 级幂等依据（同一 run 同一资格只通知一次）。
 *
 * 判据（fail-closed，宁可不说完成）：
 *  - 需求未封口 ⇒ `'not-complete'`（还有需求可能登记进来）；
 *  - 投影无 run 归属 ⇒ `'not-complete'`（没有幂等依据，不归属就不报告）；
 *  - 模型相位 `failed` ⇒ `'failed'`（失败轮不得报"任务完成"；交付证据保留供展示）；
 *  - **明确普通聊天**（需求集合为空且已封口）：模型 `ended` ⇒ `complete`，否则 not-complete；
 *  - 有交付需求：任何需求未结算（或登记了但投影中无证据）⇒ `not-complete`；
 *    全部结算后：全 complete ⇒ `complete`；部分 complete ⇒ `partial`；
 *    无 complete、有 failed ⇒ `failed`；其余（全 unconfirmed）⇒ `unconfirmed`。
 */
export type RunCompletionStatus = 'complete' | 'partial' | 'failed' | 'unconfirmed' | 'not-complete';

/**
 * ⭐ 第二轮（R5 P1 收口）：**登记回执状态** —— 需求集合的可信来源，不再由
 * "operations 恰好为空"反推普通聊天（promote 清 activeTurn 时持久化/登记尚未
 * 返回，空 operations 只代表"登记证据未到"，不代表无需求）。
 *
 *  - `'unknown'`：尚无本 run 的登记回执（待登记/回执未达）⇒ 一律不得判 complete；
 *  - `'registered'`：本轮交付登记已完成（operationId 已定号/作业已入交付通道）
 *    ⇒ 需求 = 投影中已到达的 operations；它们全部结算前不得 complete；
 *  - `'needs-review'`：已知文件需求存在但登记失败/上下文未确认（需求保留）
 *    ⇒ 永远不得回退成"明确零需求"；已登记 operations 照常分档但 complete 降级 partial；
 *  - `'none-expected'`：可信请求事实确认零需求（普通聊天）⇒ 模型 ended 即 complete。
 */
export type TurnRegistrationStatus = 'unknown' | 'registered' | 'needs-review' | 'none-expected';

export interface RunCompletionRequirementSet {
  /**
   * 可信交付需求（operationKey = `gatewayId|operationId`，与投影 `delivery.operations`
   * 的键同形）。空数组单独看**不能**推"明确普通聊天" —— 必须配 `registration`。
   */
  operationKeys: readonly string[];
  /**
   * 需求集合是否**已封口**（不会再登记新需求进入本 run）。
   * 触发时机由可信边界给出（例如回合结束时的登记确认窗口）；未封口一律 not-complete。
   */
  sealed: boolean;
  /**
   * 登记回执（第二轮 R5 P1）。缺省 = `'unknown'`（保守：未拿到可信回执不得判 complete）。
   */
  registration?: TurnRegistrationStatus;
}

export interface RunCompletionVerdict {
  runId: string;
  status: RunCompletionStatus;
  /** run 级幂等键（`runId|status`）：消费方按此去重，同一 run 同一资格只通知一次。 */
  idempotencyKey: string;
}

/**
 * 便捷构造：需求集合 = 投影里**经可信登记**（delivery.started）的全部 operation，
 * 配 `registration`（第二轮：由 main 登记回执提供，缺省 'unknown' 保守）。
 */
export function deliveryRequirementsOf(
  projection: ExecutionProjection,
  sealed: boolean,
  registration: TurnRegistrationStatus = 'unknown',
): RunCompletionRequirementSet {
  return { operationKeys: Object.keys(projection.delivery.operations), sealed, registration };
}

export function evaluateRunCompletion(
  projection: ExecutionProjection,
  requirements: RunCompletionRequirementSet,
): RunCompletionVerdict {
  const runId = projection.runId;
  const status = (value: RunCompletionStatus): RunCompletionVerdict => ({
    runId,
    status: value,
    idempotencyKey: `${runId}|${value}`,
  });

  if (!runId) return status('not-complete');
  if (!requirements.sealed) return status('not-complete');
  if (projection.modelPhase === 'failed') return status('failed');

  // ⭐ 第二轮（R5 P1）：登记回执是封口的**必要组成** —— activeTurn 被清（promote）只
  //    代表"轮次关闭"，登记（finalizeAssistantArtifacts / 交付捕获）还可能在路上；
  //    空 operations 在回执到达前不能当"普通聊天"。
  const registration = requirements.registration ?? 'unknown';
  if (registration === 'unknown') return status('not-complete');

  if (requirements.operationKeys.length === 0) {
    // 已知文件需求登记失败（需求保留）⇒ unconfirmed —— 不得回退成"明确零需求"。
    if (registration === 'needs-review') return status('unconfirmed');
    // 只有"确认零需求"才允许普通聊天完成；'registered' 而 ops 尚未到达 = 等登记证据。
    return status(registration === 'none-expected' && projection.modelPhase === 'ended' ? 'complete' : 'not-complete');
  }

  const operations = requirements.operationKeys.map((key) => projection.delivery.operations[key]);
  if (operations.some((operation) => !operation || operation.outcome === undefined)) {
    // 需求登记了但证据未达、或作业未结算 ⇒ 不能证明整轮完成（旁路二/三）。
    return status('not-complete');
  }
  const outcomes = operations.map((operation) => operation!.outcome!);
  if (outcomes.every((outcome) => outcome === 'complete')) {
    // needs-review = 还有"已知需求未见登记证据" ⇒ 不得整轮 complete（降级 partial）。
    return status(registration === 'needs-review' ? 'partial' : 'complete');
  }
  if (outcomes.some((outcome) => outcome === 'complete')) return status('partial');
  if (outcomes.some((outcome) => outcome === 'failed')) return status('failed');
  return status('unconfirmed');
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
