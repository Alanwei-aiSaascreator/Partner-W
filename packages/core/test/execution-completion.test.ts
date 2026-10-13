import { describe, expect, it } from 'vitest';
import {
  createExecutionProjection,
  deliveryRequirementsOf,
  evaluateRunCompletion,
  reduceExecutionProjection,
  type ExecutionProjection,
} from '../src/stores/execution-projection.js';
import type { ExecutionEvent } from '../src/protocol/execution-events.js';

/**
 * 2026-10-14 集中修复批（V owner）· R5：完成资格的**唯一真源**（core 窄接口）。
 *
 * 复审旁路（2026-10-14-closeout-preflight-review.md R5）：
 *  ① 同 run 已 settled/failed/unconfirmed/partial 时仍能走"任务完成"；
 *  ② final 当场看不到（异步）交付登记 ⇒ 不能证明这是普通聊天；
 *  ③ 已登记 A 完成即 settled、模型还能继续生成 B ⇒ 缺"需求集合封口"条件。
 * 本接口把判据收成一处：区分**明确普通聊天**（无可信交付需求）与**有交付需求的 run**；
 * failed/unconfirmed/partial 不得判全完成；需求未封口/未结算一律 not-complete；
 * 并给出 run 级幂等键（dispatcher 与交付出口共享，不能各发一遍）。
 */

const SK = 'agent:main:clawwork:task:task-1';

type ModelStartedEvent = Extract<ExecutionEvent, { type: 'model.started' }>;

const BASE_EVENT: ModelStartedEvent = {
  schemaVersion: 1,
  eventId: 'f#0',
  seq: 0,
  runId: 'run-a',
  taskId: 'task-1',
  source: {
    gatewayId: 'gw-1',
    channel: 'main',
    nativeSessionKey: SK,
    nativeRunId: 'native-1',
    event: 'agent',
    stream: 'lifecycle',
    derivedIndex: 0,
  },
  evidence: 'observed',
  receivedAt: 1_000,
  type: 'model.started',
  payload: {},
};

function event(over: Partial<ExecutionEvent>): ExecutionEvent {
  // 判别联合的 payload 无法用字面量展开“证明”，这里按构造安全（over 由各工厂显式给出）。
  return Object.assign({}, BASE_EVENT, over as object) as ExecutionEvent;
}

function fold(projection: ExecutionProjection, events: ExecutionEvent[]): ExecutionProjection {
  return events.reduce((acc, current) => reduceExecutionProjection(acc, current), projection);
}

function started(runId = 'run-a'): ExecutionEvent {
  return event({ runId, seq: 0, type: 'model.started', payload: {} });
}
function ended(runId = 'run-a'): ExecutionEvent {
  return event({ runId, seq: 1, type: 'model.ended', payload: { reason: 'final' } });
}
function failedModel(runId = 'run-a'): ExecutionEvent {
  return event({ runId, seq: 1, type: 'model.failed', payload: { reason: 'error' } });
}
function deliveryStarted(runId: string, operationId: string, seq = 2): ExecutionEvent {
  return event({
    runId,
    seq,
    type: 'delivery.started',
    payload: { operationId, kind: 'video' },
    source: { gatewayId: 'gw-1', channel: 'local', event: 'main', derivedIndex: 0 },
  });
}
function deliverySettled(
  runId: string,
  operationId: string,
  outcome: 'complete' | 'failed' | 'unconfirmed',
  seq = 3,
): ExecutionEvent {
  return event({
    runId,
    seq,
    type: 'delivery.settled',
    payload: { operationId, outcome },
    source: { gatewayId: 'gw-1', channel: 'local', event: 'main', derivedIndex: 0 },
  });
}

describe('R5 · evaluateRunCompletion —— 完成资格唯一真源', () => {
  it('⭐ 明确普通聊天（无交付需求、已封口、确认零需求回执）+ 模型结束 ⇒ complete，并给 run 级幂等键', () => {
    const projection = fold(createExecutionProjection('run-a'), [started(), ended()]);
    const verdict = evaluateRunCompletion(projection, {
      operationKeys: [],
      sealed: true,
      registration: 'none-expected',
    });
    expect(verdict.status).toBe('complete');
    expect(verdict.runId).toBe('run-a');
    expect(verdict.idempotencyKey).toBe('run-a|complete');
  });

  it('⭐ 第二轮（R5 P1）：登记回执是封口的必要组成 —— 缺省（unknown）一律不判 complete', () => {
    const projection = fold(createExecutionProjection('run-a'), [started(), ended()]);
    // 缺省 registration（调用方不给回执）⇒ 保守 not-complete（promote 清 activeTurn 时登记在路上）
    expect(evaluateRunCompletion(projection, { operationKeys: [], sealed: true }).status).toBe('not-complete');
    expect(evaluateRunCompletion(projection, { operationKeys: [], sealed: true, registration: 'unknown' }).status).toBe(
      'not-complete',
    );
    // registered 而 ops 尚未到达 = 等登记证据（不得回退成普通聊天）
    expect(
      evaluateRunCompletion(projection, { operationKeys: [], sealed: true, registration: 'registered' }).status,
    ).toBe('not-complete');
    // needs-review（已知文件需求登记失败）：需求保留 ⇒ unconfirmed，不得 complete
    expect(
      evaluateRunCompletion(projection, { operationKeys: [], sealed: true, registration: 'needs-review' }).status,
    ).toBe('unconfirmed');
    // none-expected 但模型未结束 ⇒ 仍 not-complete
    const mid = fold(createExecutionProjection('run-a'), [started()]);
    expect(evaluateRunCompletion(mid, { operationKeys: [], sealed: true, registration: 'none-expected' }).status).toBe(
      'not-complete',
    );
  });

  it('⭐ needs-review 配已登记 operations：complete 降级 partial；failed 照常 failed', () => {
    const settled = fold(createExecutionProjection('run-a'), [
      started(),
      deliveryStarted('run-a', 'op-1', 2),
      ended(),
      deliverySettled('run-a', 'op-1', 'complete', 3),
    ]);
    expect(
      evaluateRunCompletion(settled, { operationKeys: ['gw-1|op-1'], sealed: true, registration: 'registered' }).status,
    ).toBe('complete');
    expect(
      evaluateRunCompletion(settled, { operationKeys: ['gw-1|op-1'], sealed: true, registration: 'needs-review' })
        .status,
      '有已知需求未见登记证据 ⇒ 不得整轮 complete',
    ).toBe('partial');

    const failedOp = fold(createExecutionProjection('run-a'), [
      started(),
      deliveryStarted('run-a', 'op-1', 2),
      ended(),
      deliverySettled('run-a', 'op-1', 'failed', 3),
    ]);
    expect(
      evaluateRunCompletion(failedOp, { operationKeys: ['gw-1|op-1'], sealed: true, registration: 'needs-review' })
        .status,
    ).toBe('failed');
  });

  it('⭐ 需求未封口 ⇒ not-complete（模型结束也不能证明整轮完成 —— 旁路三）', () => {
    const projection = fold(createExecutionProjection('run-a'), [started(), ended()]);
    expect(
      evaluateRunCompletion(projection, { operationKeys: [], sealed: false, registration: 'none-expected' }).status,
    ).toBe('not-complete');
  });

  it('⭐ 有交付需求：全部结算 complete ⇒ complete；未结算 ⇒ not-complete', () => {
    const live = fold(createExecutionProjection('run-a'), [started(), deliveryStarted('run-a', 'op-1'), ended()]);
    expect(
      evaluateRunCompletion(live, { operationKeys: ['gw-1|op-1'], sealed: true, registration: 'registered' }).status,
    ).toBe('not-complete');

    const settled = fold(live, [deliverySettled('run-a', 'op-1', 'complete')]);
    expect(
      evaluateRunCompletion(settled, { operationKeys: ['gw-1|op-1'], sealed: true, registration: 'registered' }).status,
    ).toBe('complete');
  });

  it('⭐ failed / unconfirmed / partial 不得判全完成（旁路一）', () => {
    const base = fold(createExecutionProjection('run-a'), [
      started(),
      deliveryStarted('run-a', 'op-1', 2),
      deliveryStarted('run-a', 'op-2', 3),
      ended(),
    ]);
    const failed = fold(base, [deliverySettled('run-a', 'op-1', 'failed', 4)]);
    expect(
      evaluateRunCompletion(failed, { operationKeys: ['gw-1|op-1'], sealed: true, registration: 'registered' }).status,
    ).toBe('failed');

    const unconfirmed = fold(base, [deliverySettled('run-a', 'op-1', 'unconfirmed', 5)]);
    expect(
      evaluateRunCompletion(unconfirmed, { operationKeys: ['gw-1|op-1'], sealed: true, registration: 'registered' })
        .status,
    ).toBe('unconfirmed');

    const partial = fold(base, [
      deliverySettled('run-a', 'op-1', 'complete', 6),
      deliverySettled('run-a', 'op-2', 'failed', 7),
    ]);
    expect(
      evaluateRunCompletion(partial, {
        operationKeys: ['gw-1|op-1', 'gw-1|op-2'],
        sealed: true,
        registration: 'registered',
      }).status,
      '一项成功一项失败 ⇒ 只能部分完成',
    ).toBe('partial');

    // 两项都成功才算全完成
    const both = fold(base, [
      deliverySettled('run-a', 'op-1', 'complete', 8),
      deliverySettled('run-a', 'op-2', 'complete', 9),
    ]);
    expect(
      evaluateRunCompletion(both, {
        operationKeys: ['gw-1|op-1', 'gw-1|op-2'],
        sealed: true,
        registration: 'registered',
      }).status,
    ).toBe('complete');
  });

  it('⭐ 需求集合里有一项在投影中无证据（登记异步未达）⇒ not-complete（旁路二 fail-closed）', () => {
    const projection = fold(createExecutionProjection('run-a'), [started(), ended()]);
    expect(
      evaluateRunCompletion(projection, {
        operationKeys: ['gw-1|op-async'],
        sealed: true,
        registration: 'registered',
      }).status,
      '看不到证据 ≠ 普通聊天',
    ).toBe('not-complete');
  });

  it('⭐ 模型失败 ⇒ failed（失败轮不得报完成，交付证据保留供展示）', () => {
    const projection = fold(createExecutionProjection('run-a'), [started(), failedModel()]);
    expect(
      evaluateRunCompletion(projection, { operationKeys: [], sealed: true, registration: 'none-expected' }).status,
    ).toBe('failed');

    const withDelivery = fold(projection, [deliveryStarted('run-a', 'op-1', 2)]);
    expect(
      evaluateRunCompletion(withDelivery, { operationKeys: ['gw-1|op-1'], sealed: true, registration: 'registered' })
        .status,
    ).toBe('failed');
  });

  it('⭐ 幂等：同投影重复评估同结果同键；结算推进后键随状态变化', () => {
    const live = fold(createExecutionProjection('run-a'), [started(), deliveryStarted('run-a', 'op-1')]);
    const req = { operationKeys: ['gw-1|op-1'], sealed: true, registration: 'registered' } as const;
    const first = evaluateRunCompletion(live, req);
    const second = evaluateRunCompletion(live, req);
    expect(second).toEqual(first);
    expect(first.idempotencyKey).toBe('run-a|not-complete');

    const settled = fold(live, [deliverySettled('run-a', 'op-1', 'complete', 9)]);
    const after = evaluateRunCompletion(settled, req);
    expect(after.idempotencyKey).toBe('run-a|complete');
  });

  it('⭐ deliveryRequirementsOf：需求键来自投影内的可信登记（delivery.started）；回执缺省 unknown', () => {
    const projection = fold(createExecutionProjection('run-a'), [
      started(),
      deliveryStarted('run-a', 'op-1', 2),
      deliveryStarted('run-a', 'op-2', 3),
    ]);
    const requirements = deliveryRequirementsOf(projection, true);
    expect(requirements.operationKeys).toEqual(['gw-1|op-1', 'gw-1|op-2']);
    expect(requirements.registration).toBe('unknown');
    expect(evaluateRunCompletion(projection, requirements).status).toBe('not-complete'); // 都还没结算 + 无回执

    const withAck = deliveryRequirementsOf(projection, true, 'registered');
    expect(withAck.registration).toBe('registered');
    expect(evaluateRunCompletion(projection, withAck).status).toBe('not-complete'); // 都还没结算
  });

  it('⭐ 未归属投影（runId 空）不得判完成：没有 run 身份就没有幂等依据', () => {
    const projection: ExecutionProjection = { ...createExecutionProjection(''), modelPhase: 'ended' };
    expect(
      evaluateRunCompletion(projection, { operationKeys: [], sealed: true, registration: 'none-expected' }).status,
    ).toBe('not-complete');
  });
});
