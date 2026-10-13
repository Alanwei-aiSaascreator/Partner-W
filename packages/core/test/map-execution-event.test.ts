import { describe, expect, it } from 'vitest';
import type { GatewayEvent } from '../src/ports/gateway-transport.js';
import { mapNativeToExecution, type ExecutionMapContext } from '../src/protocol/map-execution-event.js';
import {
  chatDeltaFrame,
  chatFinalFrame,
  heldResultFrame,
  toolItemStartFrame,
  toolResultFrame,
  toolStartFrame,
} from './fixtures/native-gateway-frames.js';

/**
 * V2（2026-10-13 集中整改 step 2）· 纯映射红例。
 *
 * 05 F2 修订的纪律：`${runId}:${seq}` 不是事件身份 —— 外层 seq 按连接域计数、
 * 重连会重置、delta 与 final 复用同一 seq、一条帧还能派生多个事件。
 * 事件 ID = `localFrameId + derivedIndex`（边界分配、映射器只拼接），与 seq 无关。
 */

const ctx = (over: Partial<ExecutionMapContext> = {}): ExecutionMapContext => ({
  localFrameId: 'f1',
  receivedAt: 1_000,
  seq: 0,
  taskId: 'task-1',
  logicalRunId: 'run-a',
  channel: 'main',
  connectionEpoch: 'epoch-1',
  nativeSessionKey: 'agent:main:clawwork:task:task-1',
  evidence: 'observed',
  ...over,
});

describe('V2 · mapNativeToExecution —— 事件身份与派生', () => {
  it('⭐ 同 run/seq 的 delta 与 final 各生效：两条帧都映射，eventId 按 localFrameId 区分', () => {
    const delta = mapNativeToExecution(
      chatDeltaFrame([{ type: 'toolCall', id: 't1', name: 'read' }], { seq: 7 }) as GatewayEvent,
      ctx({ localFrameId: 'f10', seq: 1 }),
    );
    const final = mapNativeToExecution(
      chatFinalFrame([{ type: 'toolCall', id: 't1', name: 'read' }], { seq: 7 }) as GatewayEvent,
      ctx({ localFrameId: 'f11', seq: 2 }),
    );

    expect(delta.length, 'delta 帧不被 final 吞掉').toBeGreaterThan(0);
    expect(final.length).toBeGreaterThan(0);
    expect(delta[0].eventId).toBe('f10#0');
    expect(final[0].eventId).toBe('f11#0');
    expect(final.map((e) => e.type)).toContain('model.ended');
  });

  it('⭐ 一帧派生多事件都保留：两个 toolCall 块 ⇒ 两条 declared，derivedIndex 按块序 0/1', () => {
    const events = mapNativeToExecution(
      chatDeltaFrame([
        { type: 'toolCall', id: 't1', name: 'read' },
        { type: 'toolCall', id: 't2', name: 'exec' },
      ]) as GatewayEvent,
      ctx({ localFrameId: 'f20' }),
    );

    expect(events.filter((e) => e.type === 'step.declared').map((e) => e.eventId)).toEqual(['f20#0', 'f20#1']);
    expect(events.filter((e) => e.type === 'step.declared').map((e) => e.payload.toolCallId)).toEqual(['t1', 't2']);
  });

  it('⭐ 主/审批连接相同 seq 不碰撞、重连 seq 重置不碰撞：eventId 与 seq 无关', () => {
    const main = mapNativeToExecution(toolStartFrame() as GatewayEvent, ctx({ localFrameId: 'f30', seq: 9 }));
    const approval = mapNativeToExecution(
      toolStartFrame({ toolCallId: 'tc-approval' }) as GatewayEvent,
      ctx({ localFrameId: 'f31', seq: 9, channel: 'approval', connectionEpoch: 'epoch-2' }),
    );
    const reconnect = mapNativeToExecution(
      toolStartFrame({ toolCallId: 'tc-reconnect' }) as GatewayEvent,
      ctx({ localFrameId: 'f32', seq: 9, connectionEpoch: 'epoch-3' }),
    );

    expect(main[0].eventId).toBe('f30#0');
    expect(approval[0].eventId).toBe('f31#0');
    expect(reconnect[0].eventId).toBe('f32#0');
    expect(new Set([main[0].eventId, approval[0].eventId, reconnect[0].eventId]).size).toBe(3);
    expect(approval[0].source.channel).toBe('approval');
  });

  it('⭐ payload.seq（原生 run 计数）与外层 seq 分栏存', () => {
    const frame = toolStartFrame() as GatewayEvent;
    (frame.payload as Record<string, unknown>).seq = 3; // agent-events：按原生 run 计数
    frame.seq = 41; // 外层连接帧序号

    const [event] = mapNativeToExecution(frame, ctx());

    expect(event.source.nativeSeq).toBe(3);
    expect(event.source.frameSeq).toBe(41);
  });

  it('⭐ 未知来源留 unknown：frame 无 meta 时 channel=unknown（既有生产者兼容）', () => {
    const frame = toolStartFrame() as GatewayEvent;
    const [event] = mapNativeToExecution(frame, ctx({ channel: 'unknown', connectionEpoch: undefined }));

    expect(event.source.channel).toBe('unknown');
  });

  it('⭐ tool/start ⇒ step.dispatched（进入处理，不是执行证据）', () => {
    const [event] = mapNativeToExecution(toolStartFrame() as GatewayEvent, ctx());

    expect(event.type).toBe('step.dispatched');
    if (event.type === 'step.dispatched') {
      expect(event.payload).toMatchObject({ toolCallId: 'tc-1', name: 'read', phase: 'start' });
      expect(event.payload.startedAtMs).toBeUndefined(); // tool 流无源时间 ⇒ occurredAt 留空
    }
    expect(event.stepId).toBe('tc-1');
    expect(event.source.nativeRunId).toBe('run-fixture-parent');
  });

  it('⭐ item/running ⇒ step.dispatched 并带源时间 startedAt 毫秒', () => {
    const [event] = mapNativeToExecution(toolItemStartFrame() as GatewayEvent, ctx());

    expect(event.type).toBe('step.dispatched');
    if (event.type === 'step.dispatched') {
      expect(event.payload.startedAtMs).toBe(Date.parse('2026-10-13T00:00:00.000Z'));
    }
    expect(event.occurredAt, '源时间进 occurredAt，不冒充 firstObservedAt').toBe(
      Date.parse('2026-10-13T00:00:00.000Z'),
    );
    expect(event.receivedAt).toBe(1_000);
  });

  it('⭐ tool/result ⇒ step.result；isError 与 heldByApproval 如实分栏', () => {
    const done = mapNativeToExecution(toolResultFrame() as GatewayEvent, ctx());
    expect(done[0].type).toBe('step.result');
    if (done[0].type === 'step.result') {
      expect(done[0].payload).toMatchObject({ toolCallId: 'tc-1', isError: false });
      expect(done[0].payload.heldByApproval).toBe(false);
    }

    const [held] = mapNativeToExecution(heldResultFrame() as GatewayEvent, ctx());
    expect(held.type).toBe('step.result');
    if (held.type === 'step.result') {
      expect(held.payload.isError).toBe(false);
      expect(held.payload.heldByApproval, 'approval-pending 的 result 不是执行终态').toBe(true);
    }
  });

  it('⭐ thinking/text 不派生事件（正文/思考仍走原逐块 helper，白名单）', () => {
    const thinking = {
      event: 'agent',
      gatewayId: 'gw-1',
      payload: { sessionKey: 's', stream: 'thinking', data: { text: '想' } },
    } as GatewayEvent;
    const text = {
      event: 'agent',
      gatewayId: 'gw-1',
      payload: { sessionKey: 's', stream: 'text', data: { text: '答' } },
    } as GatewayEvent;
    expect(mapNativeToExecution(thinking, ctx())).toEqual([]);
    expect(mapNativeToExecution(text, ctx())).toEqual([]);
  });

  it('⭐ lifecycle start/end/error ⇒ model.started/ended/failed', () => {
    const frame = (phase: string): GatewayEvent =>
      ({
        event: 'agent',
        gatewayId: 'gw-1',
        payload: { sessionKey: 's', runId: 'run-a', stream: 'lifecycle', data: { phase } },
      }) as GatewayEvent;

    expect(mapNativeToExecution(frame('start'), ctx())[0].type).toBe('model.started');
    expect(mapNativeToExecution(frame('end'), ctx())[0].type).toBe('model.ended');
    expect(mapNativeToExecution(frame('error'), ctx())[0].type).toBe('model.failed');
  });

  it('⭐ V3 · approval 流：requested/resolved 映射审批事件族（approvalId 独立）', () => {
    const approvalFrame = (phase: string, approvalId: string, status?: string): GatewayEvent =>
      ({
        event: 'agent',
        gatewayId: 'gw-1',
        payload: {
          sessionKey: 'agent:main:clawwork:task:task-1',
          runId: 'run-a',
          stream: 'approval',
          data: { phase, kind: 'exec', status, toolCallId: 'tc-exec-1', approvalId },
        },
      }) as GatewayEvent;

    const [requested] = mapNativeToExecution(approvalFrame('requested', 'ap-1', 'pending'), ctx());
    expect(requested.type).toBe('approval.requested');
    if (requested.type === 'approval.requested') {
      expect(requested.payload).toMatchObject({ approvalId: 'ap-1', toolCallId: 'tc-exec-1', status: 'pending' });
    }
    expect(requested.stepId).toBe('tc-exec-1');

    const [resolved] = mapNativeToExecution(approvalFrame('resolved', 'ap-1', 'denied'), ctx());
    expect(resolved.type).toBe('approval.resolved');
    if (resolved.type === 'approval.resolved') {
      expect(resolved.payload).toMatchObject({ approvalId: 'ap-1', decision: 'denied' });
    }
  });

  it('⭐ 子会话帧携带自己的 nativeSessionKey/nativeRunId（不被父回合身份覆盖）', () => {
    const child = {
      event: 'agent',
      gatewayId: 'gw-1',
      payload: {
        sessionKey: 'agent:worker:subagent:x',
        runId: 'run-child',
        stream: 'tool',
        data: { phase: 'start', name: 'webSearch', toolCallId: 'tc-child-1' },
      },
    } as GatewayEvent;
    const [event] = mapNativeToExecution(
      child,
      ctx({ logicalRunId: 'run-parent', nativeSessionKey: 'agent:worker:subagent:x' }),
    );

    expect(event.source.nativeRunId).toBe('run-child');
    expect(event.source.nativeSessionKey).toBe('agent:worker:subagent:x');
    expect(event.runId, '逻辑回合仍是 UI turn，不被 child runId 覆盖').toBe('run-parent');
  });
});
