/**
 * step 0 · 原生帧夹具（只动测试：本文件与 `native-frame-fixtures.test.ts`、docs 06）。
 *
 * 全部形状**逐字段取证自部署 runtime**：openclaw `2026.9.3`
 * （`…/@clawwork/desktop/runtime/deployed/2026.9.3-win32-x64-7311f155544a/node_modules/openclaw/dist/`）。
 * 每条夹具的 `evidence` 注释给出 dist 文件与行号；完整对照见
 * `D:\claude\mofang\exec-visualization-20261013\06-STEP0-原生帧证据表.md`。
 *
 * ⚠️ 本夹具不是"应当如何"的规范，而是"线上真实长什么样"的采样：
 * 它用于把**现有 dispatcher/store 的真实行为**钉住（pin），并在测试里用
 * `【step 1 靶点】` 标注与 05 修订稿目标语义的差异——step 0 不改产品行为。
 */
import type { GatewayEvent } from '../../src/ports/gateway-transport.js';

/** 取证 runtime 标识（复核用）。 */
export const NATIVE_RUNTIME = {
  version: '2026.9.3',
  distRoot:
    'C:/Users/digua/AppData/Roaming/@clawwork/desktop/runtime/deployed/2026.9.3-win32-x64-7311f155544a/node_modules/openclaw/dist',
} as const;

/** 夹具用会话/run（父子两套；形状参照 agent-events 的 sessionKey 富化与子代理会话命名）。 */
export const FIXTURE = {
  gatewayId: 'gw-fixture',
  taskId: 'fixture-task-1',
  taskSessionKey: 'agent:main:clawwork:task:fixture-task-1',
  childSessionKey: 'agent:worker:clawwork:subagent:fixture-child-1',
  parentRunId: 'run-fixture-parent',
  childRunId: 'run-fixture-child',
} as const;

export const FIXTURE_TASK = {
  id: FIXTURE.taskId,
  title: 'Fixture Task',
  gatewayId: FIXTURE.gatewayId,
  sessionKey: FIXTURE.taskSessionKey,
} as const;

// ---------------------------------------------------------------------------
// T1 · tool start 先于准备；**跳过/未执行也发 start**
// 取证：agent-core-D3iHCNOc.mjs:864-882（emit tool_execution_start 后才 prepareToolCall，
//       immediate 分支携带 executionStarted:false）
//       agent-core-D3iHCNOc.mjs:1339-1360（completeUnstartedToolCall：admission/steering/
//       中止的**未执行**调用同样补发 start，结果 isError:true + executionStarted:false）
// 线上投影：builtin-openclaw-FlPOnMHc.mjs:2961-2984（tool/start + item/running）
// ⚠️ wire 结果帧（builtin-openclaw:3495-3507）**不携带 executionStarted** —— 「开始过」
//    不等于「执行过」；这是 F1 的最强证据。
// ---------------------------------------------------------------------------

/** agent 流 tool/start（逐字段：phase/name/toolCallId/args；builtin-openclaw:2961-2971）。 */
export function toolStartFrame(
  overrides: { toolCallId?: string; name?: string; args?: Record<string, unknown>; runId?: string } = {},
): GatewayEvent {
  return {
    event: 'agent',
    gatewayId: FIXTURE.gatewayId,
    payload: {
      sessionKey: FIXTURE.taskSessionKey,
      runId: overrides.runId ?? FIXTURE.parentRunId,
      stream: 'tool',
      data: {
        phase: 'start',
        name: overrides.name ?? 'read',
        toolCallId: overrides.toolCallId ?? 'tc-1',
        args: overrides.args ?? { path: 'a.txt' },
      },
    },
  } as GatewayEvent;
}

/** agent 流 tool/result（builtin-openclaw:3495-3507；isError 显式、无 executionStarted）。 */
export function toolResultFrame(
  overrides: {
    toolCallId?: string;
    name?: string;
    isError?: boolean;
    result?: unknown;
    runId?: string;
  } = {},
): GatewayEvent {
  return {
    event: 'agent',
    gatewayId: FIXTURE.gatewayId,
    payload: {
      sessionKey: FIXTURE.taskSessionKey,
      runId: overrides.runId ?? FIXTURE.parentRunId,
      stream: 'tool',
      data: {
        phase: 'result',
        name: overrides.name ?? 'read',
        toolCallId: overrides.toolCallId ?? 'tc-1',
        isError: overrides.isError ?? false,
        ...(overrides.result !== undefined ? { result: overrides.result } : {}),
      },
    },
  } as GatewayEvent;
}

/** item kind:'tool' 的 start（builtin-openclaw:2972-2984：title/status/startedAt 齐全）。 */
export function toolItemStartFrame(
  overrides: { toolCallId?: string; title?: string; startedAt?: string } = {},
): GatewayEvent {
  return {
    event: 'agent',
    gatewayId: FIXTURE.gatewayId,
    payload: {
      sessionKey: FIXTURE.taskSessionKey,
      runId: FIXTURE.parentRunId,
      stream: 'item',
      data: {
        itemId: `tool:${overrides.toolCallId ?? 'tc-1'}`,
        phase: 'start',
        kind: 'tool',
        title: overrides.title ?? 'read a.txt',
        status: 'running',
        name: 'read',
        toolCallId: overrides.toolCallId ?? 'tc-1',
        startedAt: overrides.startedAt ?? '2026-10-13T00:00:00.000Z',
      },
    },
  } as GatewayEvent;
}

// ---------------------------------------------------------------------------
// T2 · result 先于 approval-pending（审批挂起路径）
// 取证：builtin-openclaw-FlPOnMHc.mjs:3495-3540 —— exec 工具先发 phase:'result'
//       （isError:false），**随后**才发 stream:'approval'（status:'pending'）。
//       客户端现状：parse-content.ts:179-185 isExecHeldByApproval 用
//       result.details.status ∈ {approval-pending, approval-unavailable} 保持 running，
//       不提前落 done（:149）。
// ---------------------------------------------------------------------------

/** 被审批按住的 result（isError:false + details.status='approval-pending'）。 */
export function heldResultFrame(
  overrides: { toolCallId?: string; name?: string; approvalId?: string; command?: string } = {},
): GatewayEvent {
  return toolResultFrame({
    toolCallId: overrides.toolCallId ?? 'tc-exec-1',
    name: overrides.name ?? 'bash',
    isError: false,
    result: {
      content: [{ type: 'text', text: 'Command approval requested' }],
      details: {
        status: 'approval-pending',
        approvalId: overrides.approvalId ?? 'ap-1',
        command: overrides.command ?? 'echo hi',
        host: 'localhost',
      },
    },
  });
}

/** approval 流 requested/pending（builtin-openclaw:3513-3528 逐字段；含 runId/toolCallId）。 */
export function approvalRequestedFrame(
  overrides: { toolCallId?: string; approvalId?: string; command?: string } = {},
): GatewayEvent {
  return {
    event: 'agent',
    gatewayId: FIXTURE.gatewayId,
    payload: {
      sessionKey: FIXTURE.taskSessionKey,
      runId: FIXTURE.parentRunId,
      stream: 'approval',
      data: {
        phase: 'requested',
        kind: 'exec',
        status: 'pending',
        title: 'Command approval requested',
        itemId: `command:${overrides.toolCallId ?? 'tc-exec-1'}`,
        toolCallId: overrides.toolCallId ?? 'tc-exec-1',
        approvalId: overrides.approvalId ?? 'ap-1',
        command: overrides.command ?? 'echo hi',
        host: 'localhost',
        message: '请批准执行该命令',
      },
    },
  } as GatewayEvent;
}

/** approval resolved（客户端消费形状：status 取值见 dispatcher handleAgentApprovalStream）。 */
export function approvalResolvedFrame(
  status: 'approved' | 'denied',
  overrides: { toolCallId?: string; approvalId?: string } = {},
): GatewayEvent {
  return {
    event: 'agent',
    gatewayId: FIXTURE.gatewayId,
    payload: {
      sessionKey: FIXTURE.taskSessionKey,
      runId: FIXTURE.parentRunId,
      stream: 'approval',
      data: {
        phase: 'resolved',
        kind: 'exec',
        status,
        toolCallId: overrides.toolCallId ?? 'tc-exec-1',
        approvalId: overrides.approvalId ?? 'ap-1',
      },
    },
  } as GatewayEvent;
}

// ---------------------------------------------------------------------------
// A1 · chat：delta 与 final **可复用同一 seq**
// 取证：server-chat-CbnqM5f6.mjs:639-662（emitChatTerminal 以传入 seq 先
//       flushBufferedChatDeltaIfNeeded 再发 final/aborted 载荷）。
// A2 · 连接域 seq：外层帧 seq 按 client WeakMap 计数（server-start-BB-IxTAg.mjs:3060-3064,3192），
//       主/审批连接是不同域；agent 载荷 seq 另有 run 内计数（agent-events-D1GBhQBX.mjs:130-138）。
// ---------------------------------------------------------------------------

export function chatDeltaFrame(
  content: unknown[],
  overrides: { seq?: number; runId?: string; sessionKey?: string } = {},
): GatewayEvent {
  return {
    event: 'chat',
    gatewayId: FIXTURE.gatewayId,
    payload: {
      sessionKey: overrides.sessionKey ?? FIXTURE.taskSessionKey,
      state: 'delta',
      runId: overrides.runId ?? FIXTURE.parentRunId,
      ...(overrides.seq !== undefined ? { seq: overrides.seq } : {}),
      message: { content },
    },
  } as GatewayEvent;
}

export function chatFinalFrame(
  content: unknown[],
  overrides: { seq?: number; runId?: string; stopReason?: string } = {},
): GatewayEvent {
  return {
    event: 'chat',
    gatewayId: FIXTURE.gatewayId,
    payload: {
      sessionKey: FIXTURE.taskSessionKey,
      state: 'final',
      runId: overrides.runId ?? FIXTURE.parentRunId,
      ...(overrides.seq !== undefined ? { seq: overrides.seq } : {}),
      ...(overrides.stopReason ? { stopReason: overrides.stopReason } : {}),
      message: { content },
    },
  } as GatewayEvent;
}

// ---------------------------------------------------------------------------
// S1 · 子代理拥有**自己的原生 run**（childRunId/childSessionKey/requesterTurnRunId）
// 取证：sessions-spawn-tool-oH7izxrQ.mjs:2591（childRunId=childIdem）、
//       :2952（childRunId=pipelineResult.runId）、:3264-3269（registerSubagentRun 带
//       runId/requesterTurnRunId/childSessionKey/requesterSessionKey）；
//       agent-events-D1GBhQBX.mjs:126-136（sessionKey 按可见性富化、seq/ts 附加）。
// ⚠️ 05 语义：UI 可聚合为一个用户回合，但**原生 session/run 必须保留**。
// ---------------------------------------------------------------------------

/** 子会话自己的 tool/start（sessionKey=child、runId=childRunId）。 */
export function childToolStartFrame(toolCallId = 'tc-child-1'): GatewayEvent {
  return {
    event: 'agent',
    gatewayId: FIXTURE.gatewayId,
    payload: {
      sessionKey: FIXTURE.childSessionKey,
      runId: FIXTURE.childRunId,
      stream: 'tool',
      data: { phase: 'start', name: 'webSearch', toolCallId, args: { query: 'x' } },
    },
  } as GatewayEvent;
}

// ---------------------------------------------------------------------------
// K1 · thinking 外发**只有 text/delta，无段身份**
// 取证：builtin-openclaw-FlPOnMHc.mjs:11863-11870（emitAgentEvent {stream:'thinking',
//       data:{text: trimmed(累计), delta}}）；内部 thinking_start/delta/end 边界未透传
//       （:10654-10672 内部 / :10011-10031 未作为字段带出）。
// ⚠️ 05 语义：这正是"跨通道回声 vs 新段同文"无法在客户端无损消歧的根源
//    （第四次复审 §2 裁决）——夹具把"无身份"钉在证据里。
// ---------------------------------------------------------------------------

export function thinkingAccumFrame(text: string, delta: string | undefined = undefined): GatewayEvent {
  return {
    event: 'agent',
    gatewayId: FIXTURE.gatewayId,
    payload: {
      sessionKey: FIXTURE.taskSessionKey,
      runId: FIXTURE.parentRunId,
      stream: 'thinking',
      data: { text, ...(delta !== undefined ? { delta } : {}) },
    },
  } as GatewayEvent;
}

/** 完整取证索引（docs 06 的机器可读版；测试失败信息里引用它）。 */
export const FIXTURE_EVIDENCE = {
  'tool-start-before-prepare': {
    file: 'agent-core-D3iHCNOc.mjs',
    lines: '864-882',
    note: 'start → prepare；immediate 结果 executionStarted:false',
  },
  'start-on-unstarted': {
    file: 'agent-core-D3iHCNOc.mjs',
    lines: '1339-1360',
    note: 'admission/steering/abort 的未执行调用也发 start',
  },
  'tool-item-projection': {
    file: 'builtin-openclaw-FlPOnMHc.mjs',
    lines: '2961-2984',
    note: 'tool/start + item/running 双发',
  },
  'result-before-approval': {
    file: 'builtin-openclaw-FlPOnMHc.mjs',
    lines: '3495-3540',
    note: '先 tool/result 再 stream:approval(pending)',
  },
  'thinking-no-identity': {
    file: 'builtin-openclaw-FlPOnMHc.mjs',
    lines: '11863-11870',
    note: 'thinking 外发仅 text/delta',
  },
  'assistant-itemid': {
    file: 'builtin-openclaw-FlPOnMHc.mjs',
    lines: '11185-11206',
    note: 'assistant itemId=streamId:messageIndex，不关联 thinking',
  },
  'abort-after-allow': {
    file: 'bash-tools-D7K7O7ip.mjs',
    lines: '327-338',
    note: 'resolveExecApprovalWaitOutcome：signal 中止 ⇒ run-aborted',
  },
  'approval-carries-ids': {
    file: 'exec-approval-B0MHHes6.mjs',
    lines: '277-286',
    note: 'approval 载荷含 sessionKey/runId/toolCallId',
  },
  'outer-seq-per-client': {
    file: 'server-start-BB-IxTAg.mjs',
    lines: '3060-3064,3192',
    note: '外层 seq 按 client 计数（连接域）',
  },
  'agent-payload-seq': { file: 'agent-events-D1GBhQBX.mjs', lines: '126-138', note: 'agent 载荷 seq 按 run 计数 + ts' },
  'chat-terminal-same-seq': {
    file: 'server-chat-CbnqM5f6.mjs',
    lines: '639-662',
    note: 'terminal 以相同 seq flush delta 再发 final/aborted',
  },
  'child-native-run': {
    file: 'sessions-spawn-tool-oH7izxrQ.mjs',
    lines: '2591,2952,3264-3269',
    note: 'childRunId/childSessionKey/requesterTurnRunId',
  },
} as const;
