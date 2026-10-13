/**
 * V2（2026-10-13 集中整改 step 2）：执行事件协议 —— 05 §4 v0.2 草案的**实施收窄**。
 *
 * 只放**类型**（判别联合：不同 `type` 有明确 payload，禁 any/任意 Record）。
 * 映射在 `map-execution-event.ts`（纯函数），归约在 `stores/execution-projection.ts`（纯函数）。
 *
 * ## 身份（05 F2 修订）
 *
 * - `eventId = localFrameId + derivedIndex`：由映射边界**首次接收时分配一次**，
 *   落盘/重放沿用，不在重放时重新生成 —— 与连接帧 seq / 原生 run seq **无关**
 *   （外层 seq 按连接域计数、重连重置、delta 与 final 复用同一 seq，拿它做身份会误删合法事件）。
 * - `seq`：本地同逻辑回合的接收顺序（边界分配，分配后保持稳定）。
 * - `runId`：**本地逻辑用户回合**（UI turn）；原生 run 始终在 `source.nativeRunId`，
 *   两者不互相覆盖（05 F3：UI 可聚合，原生身份必须保留）。
 * - `stepId` = toolCallId；stepKey（投影层）由 gateway/nativeSession/nativeRun/toolCallId 拼成。
 */

export type ExecutionChannel = 'main' | 'approval' | 'local' | 'unknown';

export type ExecutionEvidence = 'observed' | 'reconciled';

export interface ExecutionEventSource {
  gatewayId: string;
  /** 可信 transport 元数据（真实连接拥有者生成）；缺 = unknown，既有生产者兼容。 */
  channel: ExecutionChannel;
  connectionEpoch?: string;
  nativeSessionKey?: string;
  nativeRunId?: string;
  /** 外层连接帧序号（重连后需配合 `connectionEpoch` 才有可比性）。 */
  frameSeq?: number;
  /** `payload.seq`：原生 run 内计数（与外层 seq **分栏**存）。 */
  nativeSeq?: number;
  /** 帧类型：`chat` / `agent`。 */
  event: string;
  /** agent 流的 stream 名；chat 帧为 undefined。 */
  stream?: string;
  /** chat 帧的 state；agent 帧为 undefined。 */
  state?: string;
  /** 同帧派生序号（0..n-1，按 content blocks 顺序）。 */
  derivedIndex: number;
}

export interface ExecutionEventBase {
  schemaVersion: 1;
  /** `${localFrameId}#${derivedIndex}` —— 见文件头注释。 */
  eventId: string;
  seq: number;
  /** 本地逻辑回合；'' = 未归属（归约层拒收，不归到前台）。 */
  runId: string;
  taskId: string;
  source: ExecutionEventSource;
  stepId?: string;
  /** 执行 actor（agent id）；未知不冒充 main。 */
  actorId?: string;
  parentRunId?: string;
  /** 无真实父关系证据则不填（不猜 parentSpan）。 */
  parentSpanId?: string;
  approvalId?: string;
  operationId?: string;
  /** 源时间（ms）；没有则留空 —— **不冒充** firstObservedAt。 */
  occurredAt?: number;
  /** 本地首次收到时刻（ms，边界分配）。 */
  receivedAt: number;
  evidence: ExecutionEvidence;
}

/**
 * 事件族（05 §4 表的 V2 范围收窄：run/model/step；approval/cancel/delivery/artifact 属 V3）。
 * 每族 `type` 为字面量，`payload` 显式类型 —— 判别联合，不落 any/任意 Record。
 */
export type ExecutionEvent = ExecutionEventBase &
  (
    | { type: 'model.started'; payload: { model?: string } }
    | { type: 'model.ended'; payload: { reason: 'final' | 'aborted'; stopReason?: string; model?: string } }
    | { type: 'model.failed'; payload: { reason?: string; model?: string } }
    | { type: 'step.declared'; payload: { toolCallId: string; name: string; args?: Record<string, unknown> } }
    | {
        type: 'step.dispatched';
        payload: { toolCallId: string; name: string; phase: string; startedAtMs?: number };
      }
    | {
        type: 'step.result';
        payload: {
          toolCallId: string;
          name: string;
          isError: boolean;
          /** `approval-pending/approval-unavailable` 的 result 不是执行终态（05 F1）。 */
          heldByApproval?: boolean;
          resultText?: string;
          completedAtMs?: number;
        };
      }
    // ── V3 · 审批族（approvalId 独立归并；allow ≠ 开始执行；deny ≠ 全程零修改）──
    | {
        type: 'approval.requested';
        payload: { approvalId: string; toolCallId?: string; name?: string; status: string };
      }
    | {
        type: 'approval.resolved';
        payload: {
          approvalId: string;
          toolCallId?: string;
          decision: string;
          resolvedBy?: string;
          /** RPC 层结论：resolve 调用失败/过期/重复到达都要能说清。 */
          rpcError?: boolean;
          expired?: boolean;
        };
      }
    // ── V3 · 取消族（复用既有 stop ticket：requested → confirmed / unconfirmed）──
    | { type: 'cancel.requested'; payload: { stopTicketId?: string; reason?: string } }
    | { type: 'cancel.confirmed'; payload: { stopTicketId?: string } }
    | { type: 'cancel.unconfirmed'; payload: { stopTicketId?: string; reason?: string } }
    // ── V3 · 交付族（operation 来自可信生成请求登记；settle 由交付证据驱动）──
    | { type: 'delivery.started'; payload: { operationId: string; kind?: string } }
    | { type: 'delivery.phase'; payload: { operationId: string; phase: string } }
    | {
        type: 'delivery.settled';
        payload: { operationId: string; outcome: 'complete' | 'failed' | 'unconfirmed' };
      }
    // ── V4 · 证据缺口（由执行历史 writer 合成；映射器不产生）──
    | { type: 'evidence.gap'; payload: { reason: string; dropped?: number } }
  );

export type ExecutionEventType = ExecutionEvent['type'];
