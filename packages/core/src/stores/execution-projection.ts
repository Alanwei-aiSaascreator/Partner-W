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
  /** 已接收的最大本地回合序号（晚到低 seq 不回拨）。 */
  lastSeq: number;
}

export function createExecutionProjection(runId = ''): ExecutionProjection {
  return { runId, modelPhase: 'idle', steps: {}, lastSeq: -1 };
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
  // 模型结束 ⇒ 仍未收尾的步骤投影为 unreported（真实结果到达仍可补正）。
  const steps = modelPhase === 'ended' || modelPhase === 'failed' ? projectUnreported(folded.steps) : folded.steps;
  const lastSeq = event.seq > base.lastSeq ? event.seq : base.lastSeq;

  if (!folded.changed && modelPhase === base.modelPhase && steps === base.steps && lastSeq === base.lastSeq) {
    return previous;
  }
  return { runId, modelPhase, steps, lastSeq };
}
