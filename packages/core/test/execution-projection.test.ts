import { describe, expect, it } from 'vitest';
import type { ExecutionEvent } from '../src/protocol/execution-events.js';
import { createExecutionProjection, reduceExecutionProjection, stepKeyOf } from '../src/stores/execution-projection.js';

/**
 * V2（2026-10-13 集中整改 step 2）· 纯归约红例（05 §4 状态归约规则）。
 *
 * 纪律：终态证据不被旧 progress 回退；unreported 可由同 run 真实结果补正；
 * 同文两次合法结果不按文本全局去重；双 child 相同 toolCallId 按 stepKey 隔离；
 * 旧 run 晚包不写新 run（归约层守卫，主守卫在 dispatcher 的 acceptsRun）。
 */

const base = (over: Partial<ExecutionEvent> = {}): ExecutionEvent =>
  ({
    schemaVersion: 1,
    eventId: 'f#0',
    seq: 0,
    runId: 'run-a',
    taskId: 'task-1',
    source: {
      gatewayId: 'gw-1',
      channel: 'main',
      nativeSessionKey: 'agent:main:clawwork:task:task-1',
      nativeRunId: 'run-native-a',
      event: 'agent',
      stream: 'tool',
      derivedIndex: 0,
    },
    evidence: 'observed',
    receivedAt: 1_000,
    type: 'step.dispatched',
    payload: { toolCallId: 'tc-1', name: 'read', phase: 'start' },
    ...over,
  }) as ExecutionEvent;

describe('V2 · reduceExecutionProjection —— 状态归约', () => {
  it('⭐ declared → dispatched → result(done)：每帧中间态与最终态都正确', () => {
    let p = createExecutionProjection('run-a');
    p = reduceExecutionProjection(p, {
      ...base(),
      type: 'step.declared',
      payload: { toolCallId: 'tc-1', name: 'read' },
    } as ExecutionEvent);
    expect(Object.values(p.steps)[0].state).toBe('declared');

    p = reduceExecutionProjection(p, base());
    expect(Object.values(p.steps)[0].state).toBe('dispatched');

    p = reduceExecutionProjection(
      p,
      base({ type: 'step.result', payload: { toolCallId: 'tc-1', name: 'read', isError: false } }),
    );
    expect(Object.values(p.steps)[0].state).toBe('done');
  });

  it('⭐ 终态不被旧 progress 回退：done 之后迟到的 start/update 不得改状态', () => {
    let p = createExecutionProjection('run-a');
    p = reduceExecutionProjection(
      p,
      base({ type: 'step.result', payload: { toolCallId: 'tc-1', name: 'read', isError: false } }),
    );
    const done = p.steps[stepKeyOf('gw-1', 'agent:main:clawwork:task:task-1', 'run-native-a', 'tc-1')];
    expect(done.state).toBe('done');

    p = reduceExecutionProjection(p, base());
    expect(p.steps[Object.keys(p.steps)[0]].state, 'dispatched 不回退 done').toBe('done');
  });

  it('⭐ model.ended 后未回报步骤 ⇒ unreported；同 run 真实结果到达 ⇒ 补正（不永久冻结）', () => {
    let p = createExecutionProjection('run-a');
    p = reduceExecutionProjection(p, base());
    p = reduceExecutionProjection(p, base({ type: 'model.ended', payload: { reason: 'final' } } as ExecutionEvent));
    expect(Object.values(p.steps)[0].state, '定稿后仍缺结果 ⇒ unreported').toBe('unreported');
    expect(p.modelPhase).toBe('ended');

    p = reduceExecutionProjection(
      p,
      base({ type: 'step.result', payload: { toolCallId: 'tc-1', name: 'read', isError: false } }),
    );
    expect(Object.values(p.steps)[0].state, '真实结果补正 unreported').toBe('done');
  });

  it('⭐ 双 child 相同 toolCallId 不串：stepKey 含 gateway/nativeSession/nativeRun', () => {
    let p = createExecutionProjection('run-parent');
    const childA = base({
      runId: 'run-parent',
      source: {
        gatewayId: 'gw-1',
        channel: 'main',
        nativeSessionKey: 'agent:worker:subagent:a',
        nativeRunId: 'run-child-a',
        event: 'agent',
        stream: 'tool',
        derivedIndex: 0,
      },
    });
    const childB = base({
      runId: 'run-parent',
      source: {
        gatewayId: 'gw-1',
        channel: 'main',
        nativeSessionKey: 'agent:worker:subagent:b',
        nativeRunId: 'run-child-b',
        event: 'agent',
        stream: 'tool',
        derivedIndex: 0,
      },
    });

    p = reduceExecutionProjection(p, childA);
    p = reduceExecutionProjection(
      p,
      base({
        runId: 'run-parent',
        type: 'step.result',
        payload: { toolCallId: 'tc-1', name: 'read', isError: true },
        source: childB.source,
      }),
    );

    const steps = Object.values(p.steps);
    expect(steps, '相同 toolCallId、不同 child run ⇒ 两条独立 step').toHaveLength(2);
    expect(steps.find((s) => s.stepKey.includes('run-child-a'))?.state).toBe('dispatched');
    expect(steps.find((s) => s.stepKey.includes('run-child-b'))?.state).toBe('error');
  });

  it('⭐ 同文两次合法结果不按文本全局去重：两个 stepKey 都保留各自结果', () => {
    let p = createExecutionProjection('run-a');
    for (const id of ['tc-1', 'tc-2']) {
      p = reduceExecutionProjection(
        p,
        base({
          type: 'step.result',
          payload: { toolCallId: id, name: 'read', isError: false, resultText: 'same text' },
        }),
      );
    }
    expect(Object.values(p.steps)).toHaveLength(2);
  });

  it('⭐ 旧 run 晚包不写新 run：runId 不匹配的事件被归约层拒绝（返回原投影）', () => {
    let p = createExecutionProjection('run-a');
    p = reduceExecutionProjection(
      p,
      base({ type: 'step.result', payload: { toolCallId: 'tc-1', name: 'read', isError: false } }),
    );

    const late = base({
      runId: 'run-old',
      type: 'step.result',
      payload: { toolCallId: 'tc-x', name: 'exec', isError: true },
    });
    const after = reduceExecutionProjection(p, late);

    expect(after).toBe(p);
    expect(Object.values(after.steps)).toHaveLength(1);
  });

  it('⭐ 无 run 归属的事件不写投影（cron 无任务归属不归到前台）', () => {
    const p = createExecutionProjection('');
    const after = reduceExecutionProjection(p, base({ runId: '' }));

    expect(after).toBe(p);
    expect(after.steps).toEqual({});
  });

  it('⭐ 首次事件把投影归属到它的 runId；lastSeq 单调', () => {
    let p = createExecutionProjection('');
    p = reduceExecutionProjection(p, base({ seq: 5 }));
    expect(p.runId).toBe('run-a');
    expect(p.lastSeq).toBe(5);

    const after = reduceExecutionProjection(p, base({ seq: 3 }));
    expect(after.lastSeq, '晚到低 seq 不回拨').toBe(5);
  });

  it('⭐ held result ⇒ awaitingApproval；随后真实 error 收场（审批不是终态）', () => {
    let p = createExecutionProjection('run-a');
    p = reduceExecutionProjection(p, base());
    p = reduceExecutionProjection(
      p,
      base({
        type: 'step.result',
        payload: { toolCallId: 'tc-1', name: 'bash', isError: false, heldByApproval: true },
      }),
    );
    expect(Object.values(p.steps)[0].state).toBe('awaitingApproval');

    p = reduceExecutionProjection(
      p,
      base({ type: 'step.result', payload: { toolCallId: 'tc-1', name: 'bash', isError: true } }),
    );
    expect(Object.values(p.steps)[0].state).toBe('error');
  });
});
