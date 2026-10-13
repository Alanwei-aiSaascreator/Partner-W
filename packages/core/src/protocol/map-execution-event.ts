import type { GatewayEvent } from '../ports/gateway-transport.js';
import { extractToolResultText, isExecHeldByApproval } from './parse-content.js';
import type { ExecutionChannel, ExecutionEvent, ExecutionEventSource, ExecutionEvidence } from './execution-events.js';

/**
 * V2（2026-10-13 集中整改 step 2）：原生帧 → 规范执行事件的**纯映射**。
 *
 * ## 为什么是纯函数、上下文从边界来
 *
 * 事件 ID（localFrameId）、接收时间（receivedAt）、本地回合序号（seq）、归属结论
 * （taskId/logicalRunId/nativeSessionKey）都是**边界状态** —— 计数器、时钟、归属守卫
 * 在 dispatcher（映射调用方），不在这里：本函数不调时钟、不生成 UUID、不读 store、
 * 不写日志。`derivedIndex` 只在本帧内按 content blocks 顺序编号（纯）。
 *
 * ## 只映射什么
 *
 * - chat：toolCall 块 ⇒ `step.declared`（模型声明，05 F1：不得推断实际执行）；
 *   final/aborted/error ⇒ model 终态事件。
 * - agent.tool：start/update ⇒ `step.dispatched`（调用进入处理，**不是**执行证据）；
 *   result ⇒ `step.result`（heldByApproval 如实分栏）。
 * - agent.item（kind:tool）：start/update ⇒ dispatched（带源 startedAt 毫秒）；
 *   end ⇒ result（带 endedAt 毫秒）。
 * - agent.lifecycle：start/end/error ⇒ model 事件。
 * - **thinking/text 不映射**（正文/思考仍走原逐块 helper，05 R17：不得重排 content blocks）。
 * - 认不出的流/相位 ⇒ 空数组（丢弃判定仍由原 handler 的日志护栏负责，不在这里重复记日志）。
 */
export interface ExecutionMapContext {
  /** 首次接收时分配一次；落盘/重放沿用（事件 ID 的一半）。 */
  localFrameId: string;
  /** 本地首次收到时刻（ms）。 */
  receivedAt: number;
  /** 本地同逻辑回合接收顺序（边界分配）。 */
  seq: number;
  taskId: string;
  /** 逻辑用户回合（UI turn）；'' = 未归属。 */
  logicalRunId: string;
  actorId?: string;
  channel: ExecutionChannel;
  connectionEpoch?: string;
  nativeSessionKey?: string;
  evidence: ExecutionEvidence;
}

const ITEM_FAILURE_STATUSES = new Set(['failed', 'blocked', 'error']);

function toNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function makeBase(
  context: ExecutionMapContext,
  frame: GatewayEvent,
  payload: Record<string, unknown>,
  derivedIndex: number,
  occurredAt?: number,
): ExecutionEventBaseLike {
  return {
    schemaVersion: 1 as const,
    eventId: `${context.localFrameId}#${derivedIndex}`,
    seq: context.seq,
    runId: context.logicalRunId,
    taskId: context.taskId,
    source: makeSource(context, frame, payload, derivedIndex),
    stepId: undefined as string | undefined,
    actorId: context.actorId,
    evidence: context.evidence,
    occurredAt,
    receivedAt: context.receivedAt,
  };
}

interface ExecutionEventBaseLike {
  schemaVersion: 1;
  eventId: string;
  seq: number;
  runId: string;
  taskId: string;
  source: ExecutionEventSource;
  stepId?: string;
  actorId?: string;
  evidence: ExecutionEvidence;
  occurredAt?: number;
  receivedAt: number;
}

function makeSource(
  context: ExecutionMapContext,
  frame: GatewayEvent,
  payload: Record<string, unknown>,
  derivedIndex: number,
): ExecutionEventSource {
  const runId = typeof payload.runId === 'string' ? payload.runId : undefined;
  const state = typeof payload.state === 'string' ? payload.state : undefined;
  const stream = typeof payload.stream === 'string' ? payload.stream : undefined;
  return {
    gatewayId: frame.gatewayId,
    channel: context.channel,
    ...(context.connectionEpoch !== undefined ? { connectionEpoch: context.connectionEpoch } : {}),
    ...(context.nativeSessionKey !== undefined ? { nativeSessionKey: context.nativeSessionKey } : {}),
    ...(runId !== undefined ? { nativeRunId: runId } : {}),
    ...(frame.seq !== undefined ? { frameSeq: frame.seq } : {}),
    ...(toNumber(payload.seq) !== undefined ? { nativeSeq: toNumber(payload.seq) } : {}),
    event: frame.event,
    ...(stream !== undefined ? { stream } : {}),
    ...(state !== undefined ? { state } : {}),
    derivedIndex,
  };
}

function mapToolCallBlocks(
  context: ExecutionMapContext,
  frame: GatewayEvent,
  payload: Record<string, unknown>,
  occurredAt?: number,
): ExecutionEvent[] {
  const message = readRecord(payload.message) ?? null;
  const blocksRaw = (message?.content ?? payload.content) as unknown;
  if (!Array.isArray(blocksRaw)) return [];
  const events: ExecutionEvent[] = [];
  let index = 0;
  for (const raw of blocksRaw) {
    const block = readRecord(raw);
    if (!block || block.type !== 'toolCall') continue;
    const id = block.id;
    const name = block.name;
    if (typeof id !== 'string' || !id || typeof name !== 'string' || !name) continue;
    const base = makeBase(context, frame, payload, index, occurredAt);
    base.stepId = id;
    events.push({
      ...base,
      type: 'step.declared',
      payload: {
        toolCallId: id,
        name,
        ...(readRecord(block.arguments) !== null ? { args: readRecord(block.arguments) ?? undefined } : {}),
      },
    });
    index += 1;
  }
  return events;
}

function mapChatFrame(context: ExecutionMapContext, frame: GatewayEvent): ExecutionEvent[] {
  const payload = readRecord(frame.payload);
  if (!payload) return [];
  const state = typeof payload.state === 'string' ? payload.state : undefined;
  const toolEvents = mapToolCallBlocks(context, frame, payload);
  if (state === 'final' || state === 'aborted' || state === 'error') {
    const base = makeBase(context, frame, payload, toolEvents.length);
    const stopReason = typeof payload.stopReason === 'string' ? payload.stopReason : undefined;
    const terminal: ExecutionEvent =
      state === 'error'
        ? { ...base, type: 'model.failed', payload: {} }
        : {
            ...base,
            type: 'model.ended',
            payload: { reason: state, ...(stopReason !== undefined ? { stopReason } : {}) },
          };
    return [...toolEvents, terminal];
  }
  return toolEvents;
}

function mapAgentToolFrame(
  context: ExecutionMapContext,
  frame: GatewayEvent,
  payload: Record<string, unknown>,
): ExecutionEvent[] {
  const data = readRecord(payload.data);
  if (!data) return [];
  const toolCallId = typeof data.toolCallId === 'string' ? data.toolCallId : undefined;
  const name = typeof data.name === 'string' ? data.name : undefined;
  if (!toolCallId || !name) return [];
  const phase = typeof data.phase === 'string' ? data.phase : '(missing)';
  const occurredAt = toNumber(data.ts) ?? toNumber(payload.ts);

  if (phase === 'result' || phase === 'error') {
    const isError = phase === 'error' || data.isError === true;
    const base = makeBase(context, frame, payload, 0, occurredAt);
    base.stepId = toolCallId;
    const event: ExecutionEvent = {
      ...base,
      type: 'step.result',
      payload: {
        toolCallId,
        name,
        isError,
        heldByApproval: isExecHeldByApproval(data.result),
        ...(extractToolResultText(data.result) !== undefined
          ? { resultText: extractToolResultText(data.result) }
          : typeof data.meta === 'string' && data.meta
            ? { resultText: data.meta }
            : {}),
      },
    };
    return [event];
  }

  // start / update / review / input_delta 及其它非终态相位 ⇒ 调用进入处理
  const base = makeBase(context, frame, payload, 0, occurredAt);
  base.stepId = toolCallId;
  const event: ExecutionEvent = {
    ...base,
    type: 'step.dispatched',
    payload: { toolCallId, name, phase },
  };
  return [event];
}

function mapAgentItemFrame(
  context: ExecutionMapContext,
  frame: GatewayEvent,
  payload: Record<string, unknown>,
): ExecutionEvent[] {
  const data = readRecord(payload.data);
  if (!data) return [];
  if (data.kind !== 'tool') return []; // preamble 等非工具条目：不派生（原 handler 已有护栏）
  const toolCallId = typeof data.toolCallId === 'string' ? data.toolCallId : undefined;
  const name = typeof data.name === 'string' ? data.name : undefined;
  if (!toolCallId || !name) return [];
  const phase = typeof data.phase === 'string' ? data.phase : '(missing)';
  const startedAt = toNumber(data.startedAt);
  const endedAt = toNumber(data.endedAt);
  const status = typeof data.status === 'string' ? data.status : undefined;
  const failed = (status !== undefined && ITEM_FAILURE_STATUSES.has(status)) || Boolean(data.error);
  const settled = phase === 'end' || failed;

  if (settled) {
    const base = makeBase(context, frame, payload, 0, startedAt);
    base.stepId = toolCallId;
    const event: ExecutionEvent = {
      ...base,
      type: 'step.result',
      payload: {
        toolCallId,
        name,
        isError: failed,
        ...(endedAt !== undefined ? { completedAtMs: endedAt } : {}),
        ...(typeof data.meta === 'string' && data.meta ? { resultText: data.meta } : {}),
      },
    };
    return [event];
  }

  const base = makeBase(context, frame, payload, 0, startedAt);
  base.stepId = toolCallId;
  const event: ExecutionEvent = {
    ...base,
    type: 'step.dispatched',
    payload: {
      toolCallId,
      name,
      phase,
      ...(startedAt !== undefined ? { startedAtMs: startedAt } : {}),
    },
  };
  return [event];
}

function mapAgentApprovalFrame(
  context: ExecutionMapContext,
  frame: GatewayEvent,
  payload: Record<string, unknown>,
): ExecutionEvent[] {
  const data = readRecord(payload.data);
  if (!data) return [];
  const phase = typeof data.phase === 'string' ? data.phase : undefined;
  const approvalId = typeof data.approvalId === 'string' ? data.approvalId : undefined;
  if (!approvalId) return [];
  const toolCallId = typeof data.toolCallId === 'string' ? data.toolCallId : undefined;
  const base = makeBase(context, frame, payload, 0);
  if (toolCallId !== undefined) base.stepId = toolCallId;

  if (phase === 'requested') {
    const event: ExecutionEvent = {
      ...base,
      type: 'approval.requested',
      payload: {
        approvalId,
        ...(toolCallId !== undefined ? { toolCallId } : {}),
        ...(typeof data.kind === 'string' ? { name: data.kind } : {}),
        status: typeof data.status === 'string' ? data.status : '(missing)',
      },
    };
    return [event];
  }
  if (phase === 'resolved') {
    const event: ExecutionEvent = {
      ...base,
      type: 'approval.resolved',
      payload: {
        approvalId,
        ...(toolCallId !== undefined ? { toolCallId } : {}),
        decision: typeof data.status === 'string' ? data.status : '(missing)',
      },
    };
    return [event];
  }
  return []; // 其余相位由原 handler 的护栏负责（不在这里重复记日志）
}

function mapAgentLifecycleFrame(
  context: ExecutionMapContext,
  frame: GatewayEvent,
  payload: Record<string, unknown>,
): ExecutionEvent[] {
  const data = readRecord(payload.data);
  if (!data) return [];
  const phase = typeof data.phase === 'string' ? data.phase : undefined;
  const base = makeBase(context, frame, payload, 0);
  if (phase === 'start') return [{ ...base, type: 'model.started', payload: {} }];
  if (phase === 'end') return [{ ...base, type: 'model.ended', payload: { reason: 'final' } }];
  if (phase === 'error') {
    const reason = typeof data.reason === 'string' ? data.reason : undefined;
    return [{ ...base, type: 'model.failed', payload: { ...(reason !== undefined ? { reason } : {}) } }];
  }
  return []; // fallback / fallback_step / fallback_cleared / finishing 等相位：原 handler 的护栏负责
}

export function mapNativeToExecution(frame: GatewayEvent, context: ExecutionMapContext): readonly ExecutionEvent[] {
  const payload = readRecord(frame.payload);
  if (!payload) return [];

  if (frame.event === 'chat') return mapChatFrame(context, frame);
  if (frame.event !== 'agent') return [];

  const stream = typeof payload.stream === 'string' ? payload.stream : undefined;
  switch (stream) {
    case 'tool':
      return mapAgentToolFrame(context, frame, payload);
    case 'item':
      return mapAgentItemFrame(context, frame, payload);
    case 'lifecycle':
      return mapAgentLifecycleFrame(context, frame, payload);
    // V3：审批流（approvalId 独立归并；原 handler 仍负责工具卡状态与遥测护栏）。
    case 'approval':
      return mapAgentApprovalFrame(context, frame, payload);
    default:
      return []; // thinking/text/error/assistant/compaction/run_status…：原路径处理
  }
}
