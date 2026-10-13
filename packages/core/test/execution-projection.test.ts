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

  /**
   * V3（2026-10-13 step 3）· 审批/取消/交付三个事件族的归约红例（05 §4 状态归约规则）。
   */
  describe('V3 · 审批投影', () => {
    const approvalBase = (over: Partial<ExecutionEvent> = {}): ExecutionEvent =>
      ({
        ...base(),
        type: 'approval.requested',
        payload: { approvalId: 'ap-1', toolCallId: 'tc-1', name: 'bash', status: 'pending' },
        ...over,
      }) as ExecutionEvent;

    it('⭐ result(held)→pending→allow→abort：allow 不推进工具状态，abort 真结果收场', () => {
      let p = createExecutionProjection('run-a');
      p = reduceExecutionProjection(
        p,
        base({
          type: 'step.result',
          payload: { toolCallId: 'tc-1', name: 'bash', isError: false, heldByApproval: true },
        }),
      );
      expect(Object.values(p.steps)[0].state).toBe('awaitingApproval');

      p = reduceExecutionProjection(p, approvalBase());
      expect(Object.values(p.approvals)[0].state).toBe('requested');

      p = reduceExecutionProjection(
        p,
        base({
          type: 'approval.resolved',
          payload: { approvalId: 'ap-1', toolCallId: 'tc-1', decision: 'allow-once' },
        }),
      );
      expect(Object.values(p.approvals)[0].state, 'allow 只是解除阻塞').toBe('resolved');
      expect(Object.values(p.steps)[0].state, 'allow ≠ 开始执行 ⇒ 步骤仍等待批准').toBe('awaitingApproval');

      p = reduceExecutionProjection(
        p,
        base({ type: 'step.result', payload: { toolCallId: 'tc-1', name: 'bash', isError: true } }),
      );
      expect(Object.values(p.steps)[0].state, '中止/失败的真结果收场').toBe('error');
    });

    it('⭐ 两个审批并行：解决一个不能清另一个', () => {
      let p = createExecutionProjection('run-a');
      p = reduceExecutionProjection(p, approvalBase());
      p = reduceExecutionProjection(
        p,
        approvalBase({ payload: { approvalId: 'ap-2', toolCallId: 'tc-2', name: 'bash', status: 'pending' } }),
      );
      p = reduceExecutionProjection(
        p,
        base({
          type: 'approval.resolved',
          payload: { approvalId: 'ap-1', toolCallId: 'tc-1', decision: 'allow-once' },
        }),
      );

      const states = Object.values(p.approvals).sort((a, b) => a.approvalId.localeCompare(b.approvalId));
      expect(states.map((a) => a.state)).toEqual(['resolved', 'requested']);
    });

    it('⭐ 相同 approvalId 来自不同 gateway 不串（键含 gatewayId）', () => {
      let p = createExecutionProjection('run-a');
      p = reduceExecutionProjection(p, approvalBase());
      p = reduceExecutionProjection(
        p,
        approvalBase({
          source: { ...(base() as ExecutionEvent).source, gatewayId: 'gw-2' },
        }),
      );
      p = reduceExecutionProjection(
        p,
        base({ type: 'approval.resolved', payload: { approvalId: 'ap-1', toolCallId: 'tc-1', decision: 'deny' } }),
      );

      const states = Object.values(p.approvals).sort((a, b) => a.approvalKey.localeCompare(b.approvalKey));
      expect(states, '两条独立审批记录').toHaveLength(2);
      expect(states.map((a) => a.state)).toEqual(['denied', 'requested']);
    });

    it('⭐ RPC 失败 / 过期 / 重复 resolved 均有明确投影', () => {
      let p = createExecutionProjection('run-a');
      p = reduceExecutionProjection(p, approvalBase());
      p = reduceExecutionProjection(
        p,
        base({
          type: 'approval.resolved',
          payload: { approvalId: 'ap-1', toolCallId: 'tc-1', decision: 'allow-once', rpcError: true },
        }),
      );
      expect(Object.values(p.approvals)[0].state, 'resolve 调用失败 ≠ 已批准').toBe('failed');

      p = createExecutionProjection('run-a');
      p = reduceExecutionProjection(p, approvalBase());
      p = reduceExecutionProjection(
        p,
        base({
          type: 'approval.resolved',
          payload: { approvalId: 'ap-1', toolCallId: 'tc-1', decision: 'allow-once', expired: true },
        }),
      );
      expect(Object.values(p.approvals)[0].state, '过期审批有明确投影').toBe('expired');

      p = reduceExecutionProjection(
        p,
        base({
          type: 'approval.resolved',
          payload: { approvalId: 'ap-1', toolCallId: 'tc-1', decision: 'allow-once' },
        }),
      );
      expect(Object.values(p.approvals)[0].state, '终态后重复 resolved 不回退').toBe('expired');
    });
  });

  describe('V3 · 取消投影', () => {
    it('⭐ requested → confirmed；超时/RPC reject ⇒ unconfirmed（不显示"已停止"）', () => {
      let p = createExecutionProjection('run-a');
      p = reduceExecutionProjection(p, base({ type: 'cancel.requested', payload: { stopTicketId: 't-1' } }));
      expect(p.stop.state).toBe('requested');

      p = reduceExecutionProjection(p, base({ type: 'cancel.confirmed', payload: { stopTicketId: 't-1' } }));
      expect(p.stop.state, '网关确认后才是"已停止"').toBe('confirmed');

      p = createExecutionProjection('run-a');
      p = reduceExecutionProjection(p, base({ type: 'cancel.requested', payload: { stopTicketId: 't-2' } }));
      p = reduceExecutionProjection(
        p,
        base({ type: 'cancel.unconfirmed', payload: { stopTicketId: 't-2', reason: 'timeout' } }),
      );
      expect(p.stop.state, '超时不得显示"已停止"').toBe('unconfirmed');
    });

    it('⭐ 没有 requested 的 confirmed/unconfirmed 是噪音 ⇒ 拒收（不凭空造停止态）', () => {
      const p = createExecutionProjection('run-a');
      const after = reduceExecutionProjection(p, base({ type: 'cancel.confirmed', payload: { stopTicketId: 't-1' } }));
      // 语义拒收：停止投影零变化（lastSeq 如实前进属正常记账，不断言引用同一）。
      expect(after.stop).toEqual(p.stop);
      expect(after.stop.state).toBe('none');
      expect(after.steps).toEqual({});
    });

    it('⭐ V4 修正：unconfirmed → confirmed（同 ticket）升级（重连补发的真实确认）', () => {
      let p = createExecutionProjection('run-a');
      p = reduceExecutionProjection(p, base({ type: 'cancel.requested', payload: { stopTicketId: 't-1' } }));
      p = reduceExecutionProjection(
        p,
        base({ type: 'cancel.unconfirmed', payload: { stopTicketId: 't-1', reason: 'timeout' } }),
      );
      expect(p.stop.state).toBe('unconfirmed');

      p = reduceExecutionProjection(p, base({ type: 'cancel.confirmed', payload: { stopTicketId: 't-1' } }));
      expect(p.stop.state, '重连补发的确认必须把临时态拨回已停止').toBe('confirmed');
    });

    it('⭐ V4 修正：confirmed 后迟到的 unconfirmed 仍拒收（终态不回退）', () => {
      let p = createExecutionProjection('run-a');
      p = reduceExecutionProjection(p, base({ type: 'cancel.requested', payload: { stopTicketId: 't-1' } }));
      p = reduceExecutionProjection(p, base({ type: 'cancel.confirmed', payload: { stopTicketId: 't-1' } }));

      const after = reduceExecutionProjection(
        p,
        base({ type: 'cancel.unconfirmed', payload: { stopTicketId: 't-1', reason: 'timeout' } }),
      );
      expect(after.stop.state, 'confirmed 不回退').toBe('confirmed');
    });

    it('⭐ 旧 ticket 确认不清新 run：runId 守卫整条拒收', () => {
      const p = createExecutionProjection('run-new');
      const after = reduceExecutionProjection(
        p,
        base({ runId: 'run-old', type: 'cancel.confirmed', payload: { stopTicketId: 't-old' } }),
      );
      expect(after).toBe(p);
      expect(after.stop.state).toBe('none');
    });
  });

  describe('V3 · 交付投影', () => {
    const deliveryBase = (over: Partial<ExecutionEvent> = {}): ExecutionEvent =>
      ({
        ...base(),
        type: 'delivery.started',
        payload: { operationId: 'op-1', kind: 'video' },
        ...over,
      }) as ExecutionEvent;

    it('⭐ 模型先 final、视频后完成：模型结束不结算交付，活动作业保持交付中', () => {
      let p = createExecutionProjection('run-a');
      p = reduceExecutionProjection(p, deliveryBase());
      p = reduceExecutionProjection(p, base({ type: 'model.ended', payload: { reason: 'final' } }));

      expect(p.modelPhase).toBe('ended');
      expect(p.delivery.phase, '模型结束 ≠ 交付结算').toBe('pending');

      p = reduceExecutionProjection(
        p,
        base({ type: 'delivery.settled', payload: { operationId: 'op-1', outcome: 'complete' } }),
      );
      expect(p.delivery.phase).toBe('settled');
      expect(p.delivery.outcome).toBe('complete');
    });

    it('⭐ PPT+视频一成一败 ⇒ partial（不得判整轮成功）', () => {
      let p = createExecutionProjection('run-a');
      p = reduceExecutionProjection(p, deliveryBase());
      p = reduceExecutionProjection(p, deliveryBase({ payload: { operationId: 'op-2', kind: 'ppt' } }));
      p = reduceExecutionProjection(
        p,
        base({ type: 'delivery.settled', payload: { operationId: 'op-1', outcome: 'complete' } }),
      );
      p = reduceExecutionProjection(
        p,
        base({ type: 'delivery.settled', payload: { operationId: 'op-2', outcome: 'failed' } }),
      );

      expect(p.delivery.phase).toBe('settled');
      expect(p.delivery.outcome, '一成一败 ≠ 整轮成功').toBe('partial');
    });

    it('⭐ 同消息两个同格式产物仅一个成功 ⇒ partial', () => {
      let p = createExecutionProjection('run-a');
      p = reduceExecutionProjection(p, deliveryBase());
      p = reduceExecutionProjection(p, deliveryBase({ payload: { operationId: 'op-2', kind: 'ppt' } }));
      p = reduceExecutionProjection(
        p,
        base({ type: 'delivery.settled', payload: { operationId: 'op-1', outcome: 'complete' } }),
      );
      p = reduceExecutionProjection(
        p,
        base({ type: 'delivery.settled', payload: { operationId: 'op-2', outcome: 'unconfirmed' } }),
      );

      expect(p.delivery.outcome, '一个成功 + 一个未确认 ⇒ 不得整轮成功').toBe('partial');
    });

    it('⭐ 两项已请求、仅一项进入 activity（另一项启动失败）：两条 operation 都保留', () => {
      let p = createExecutionProjection('run-a');
      p = reduceExecutionProjection(p, deliveryBase());
      p = reduceExecutionProjection(p, deliveryBase({ payload: { operationId: 'op-2', kind: 'ppt' } }));
      p = reduceExecutionProjection(
        p,
        base({ type: 'delivery.phase', payload: { operationId: 'op-1', phase: 'running' } }),
      );
      p = reduceExecutionProjection(
        p,
        base({ type: 'delivery.settled', payload: { operationId: 'op-1', outcome: 'complete' } }),
      );
      p = reduceExecutionProjection(
        p,
        base({ type: 'delivery.settled', payload: { operationId: 'op-2', outcome: 'failed' } }),
      );

      const ops = Object.values(p.delivery.operations).sort((a, b) => a.operationId.localeCompare(b.operationId));
      expect(ops).toHaveLength(2);
      expect(ops[0]).toMatchObject({ operationId: 'op-1', requested: true, started: true, outcome: 'complete' });
      expect(ops[1]).toMatchObject({ operationId: 'op-2', requested: true, started: false, outcome: 'failed' });
      expect(p.delivery.outcome).toBe('partial');
    });

    it('⭐ V4 修正：settled 之后新 operation 登记 ⇒ phase 拨回 pending（新作业未结算不得当已交付）', () => {
      let p = createExecutionProjection('run-a');
      p = reduceExecutionProjection(p, deliveryBase());
      p = reduceExecutionProjection(
        p,
        base({ type: 'delivery.settled', payload: { operationId: 'op-1', outcome: 'complete' } }),
      );
      expect(p.delivery.phase).toBe('settled');

      // 同 run 后到的第二个 operation（例如模型先 final 后补的视频请求）
      p = reduceExecutionProjection(p, deliveryBase({ payload: { operationId: 'op-2', kind: 'video' } }));
      expect(p.delivery.phase, '新 operation 未结算 ⇒ 回到交付中').toBe('pending');
      expect(p.delivery.operations['gw-1|op-1'].outcome, '已结算 op 的结果保留').toBe('complete');

      p = reduceExecutionProjection(
        p,
        base({ type: 'delivery.settled', payload: { operationId: 'op-2', outcome: 'complete' } }),
      );
      expect(p.delivery.phase, '全部结算后重算').toBe('settled');
      expect(p.delivery.outcome).toBe('complete');
    });

    it('⭐ 旧 run 的交付结算不写新 run（runId 守卫）', () => {
      const p = createExecutionProjection('run-new');
      const after = reduceExecutionProjection(
        p,
        base({ runId: 'run-old', type: 'delivery.settled', payload: { operationId: 'op-x', outcome: 'complete' } }),
      );
      expect(after).toBe(p);
      expect(after.delivery.phase).toBe('none');
    });
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
