import { describe, expect, it } from 'vitest';
import type { ExecutionEvent } from '../src/protocol/execution-events.js';
import { selectHistoryEvents, executionEventPriority } from '../src/stores/execution-history.js';
import { createMessageStore, createExecutionProjection, reduceExecutionProjection } from '../src/index.js';

/**
 * V4（2026-10-13 step 5）· 执行历史**事件选择**红例（core 侧纯函数）。
 *
 * 口径：只存**已收到的状态边缘**（稳定 eventId + 关联 + 脱敏摘要）——
 * 不存高频累计 thinking 正文 / 原始参数；连续累计快照不线性保存完整全文；
 * 同文两次合法结果不按文本去重（事件 ID 不同就是两条事实）。
 */

const base = (over: Partial<ExecutionEvent> = {}): ExecutionEvent =>
  ({
    schemaVersion: 1,
    eventId: 'f1#0',
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
    payload: { toolCallId: 'tc-1', name: 'read', phase: 'update' },
    ...over,
  }) as ExecutionEvent;

const opts = { sanitize: (text: string) => text };

describe('V4 · selectHistoryEvents —— 状态边缘选择', () => {
  it('⭐ 连续累计快照不线性保存：同 step 多条进度 ⇒ 只留最新一条', () => {
    const events: ExecutionEvent[] = [
      base({ eventId: 'f1#0', seq: 0 }),
      base({ eventId: 'f2#0', seq: 1 }),
      base({ eventId: 'f3#0', seq: 2 }),
    ];
    const { records, dropped } = selectHistoryEvents(events, opts);

    expect(records, '三条进度合并为一条').toHaveLength(1);
    expect(records[0].eventId, '保留最新（seq 最大）').toBe('f3#0');
    expect(dropped).toBe(2);
  });

  it('⭐ 同批内终态到达 ⇒ 该 step 更早的进度条目丢弃、只留终态', () => {
    const events: ExecutionEvent[] = [
      base({ eventId: 'f1#0', seq: 0 }),
      base({
        eventId: 'f2#0',
        seq: 1,
        type: 'step.result',
        payload: { toolCallId: 'tc-1', name: 'read', isError: false, resultText: 'ok' },
      }),
    ];
    const { records } = selectHistoryEvents(events, opts);

    expect(records).toHaveLength(1);
    expect(records[0].type).toBe('step.result');
  });

  it('⭐ 不保存原始参数（step.declared 的 args 剥离）', () => {
    const event = base({
      type: 'step.declared',
      payload: { toolCallId: 'tc-1', name: 'exec', args: { command: 'secret-token --flag' } },
    });
    const { records } = selectHistoryEvents([event], opts);

    expect(records[0].type).toBe('step.declared');
    if (records[0].type === 'step.declared') {
      expect(records[0].payload.args, '原始参数不入历史').toBeUndefined();
    }
  });

  it('⭐ step.result 的正文走脱敏 + 截断（不保存全文）', () => {
    const event = base({
      type: 'step.result',
      payload: { toolCallId: 'tc-1', name: 'read', isError: false, resultText: 'SECRET'.repeat(500) },
    });
    const { records } = selectHistoryEvents([event], opts);

    expect(records[0].type).toBe('step.result');
    if (records[0].type === 'step.result') {
      expect(records[0].payload.resultText).toBeDefined();
      expect(records[0].payload.resultText!.length, '截断到摘要上限内').toBeLessThanOrEqual(200);
    }
  });

  it('⭐ 同文两次合法结果不按文本去重：两个 step 各留一条终态', () => {
    const events: ExecutionEvent[] = [
      base({
        eventId: 'f1#0',
        type: 'step.result',
        payload: { toolCallId: 'tc-1', name: 'read', isError: false, resultText: 'same text' },
      }),
      base({
        eventId: 'f2#0',
        type: 'step.result',
        payload: { toolCallId: 'tc-2', name: 'read', isError: false, resultText: 'same text' },
      }),
    ];
    const { records } = selectHistoryEvents(events, opts);

    expect(records.map((r) => r.eventId)).toEqual(['f1#0', 'f2#0']);
  });

  it('⭐ 单条预算 ≤4KiB：超限先截摘要、仍超则丢该条并计数', () => {
    const big = base({
      type: 'step.result',
      payload: { toolCallId: 'tc-1', name: 'read', isError: false, resultText: 'x'.repeat(8000) },
    });
    const { records, dropped } = selectHistoryEvents([big], opts);

    for (const record of records) {
      expect(JSON.stringify(record).length, '每条 ≤4KiB').toBeLessThanOrEqual(4096);
    }
    expect(records.length + dropped).toBe(1);
  });

  it('⭐ 审批/取消/终态优先于进度（priority 标记供 writer 溢出时先丢进度）', () => {
    expect(executionEventPriority('step.result')).toBe('terminal');
    expect(executionEventPriority('approval.requested')).toBe('terminal');
    expect(executionEventPriority('approval.resolved')).toBe('terminal');
    expect(executionEventPriority('cancel.confirmed')).toBe('terminal');
    expect(executionEventPriority('delivery.settled')).toBe('terminal');
    expect(executionEventPriority('model.ended')).toBe('terminal');
    expect(executionEventPriority('step.dispatched')).toBe('progress');
    expect(executionEventPriority('delivery.phase')).toBe('progress');
    expect(executionEventPriority('step.declared')).toBe('progress');
  });

  it('⭐ 批内保序：持久化顺序 ≡ 接收顺序（priority 只作 writer 丢载判据，不再重排批次）', () => {
    // 2026-10-14 history-order 修正：批次重排会让"落盘顺序 ≠ 消费顺序"——恢复重放
    // （cancel.requested → cancel.confirmed 这类同帧多事件）会得到与现场不同的投影。
    // 现在：selectHistoryEvents **保持输入顺序**；溢出丢载由 writer 按每条 record 的
    // priority 自行扫描（见 main/execution/history.ts 的 enqueue）。
    const events: ExecutionEvent[] = [
      base({ eventId: 'p1', seq: 0, payload: { toolCallId: 'tc-1', name: 'read', phase: 'update' } }),
      base({
        eventId: 't1',
        seq: 1,
        type: 'step.result',
        payload: { toolCallId: 'tc-2', name: 'write', isError: false },
      }),
    ];
    const { records } = selectHistoryEvents(events, opts);

    expect(records.map((r) => r.eventId)).toEqual(['p1', 't1']);
  });

  it('⭐ 同 run 同帧多事件保序：requested → confirmed 重放与现场投影一致', () => {
    const requested = base({
      eventId: 'req#0',
      seq: 4,
      type: 'cancel.requested',
      payload: { stopTicketId: 'ticket-1' },
    });
    const confirmed = base({
      eventId: 'conf#0',
      seq: 5,
      type: 'cancel.confirmed',
      payload: { stopTicketId: 'ticket-1' },
    });
    const { records } = selectHistoryEvents([requested, confirmed], opts);
    expect(records.map((r) => r.eventId)).toEqual(['req#0', 'conf#0']);

    let live = createExecutionProjection('run-a');
    for (const event of [requested, confirmed]) live = reduceExecutionProjection(live, event);
    let replayed = createExecutionProjection('run-a');
    for (const record of records) replayed = reduceExecutionProjection(replayed, record);
    expect(replayed.stop.state).toBe('confirmed');
    expect(replayed.stop.state).toBe(live.stop.state);
  });

  it('⭐ 跨生产者 seq 交错不参与批次重排：进度与主进程终态各按接收顺序落盘', () => {
    const dispatchProgress = base({ eventId: 'd#0', seq: 40 });
    const mainSettled = base({
      eventId: 'main#x',
      seq: 0,
      type: 'delivery.settled',
      payload: { operationId: 'op-1', outcome: 'complete' },
      source: { gatewayId: 'gw-1', channel: 'local', event: 'main', derivedIndex: 0 },
    });
    const { records } = selectHistoryEvents([dispatchProgress, mainSettled], opts);
    expect(records.map((r) => r.eventId)).toEqual(['d#0', 'main#x']);
  });

  it('⭐ 恢复重放幂等：同 ID 事件重放两次，投影不变（不重复计）', () => {
    const store = createMessageStore({ persistMessage: async () => ({ ok: true }) });
    const events = [
      base({
        eventId: 'f1#0',
        type: 'step.result',
        payload: { toolCallId: 'tc-1', name: 'read', isError: false, resultText: 'ok' },
      }),
    ];
    store.getState().applyExecutionEvents('agent:main:clawwork:task:task-1', events);
    const first = store.getState().executionBySession['agent:main:clawwork:task:task-1'];
    expect(Object.values(first?.steps ?? {})[0]?.state).toBe('done');

    // 重启后同 ID 重放 ⇒ 归约幂等，投影不翻新、计数不变
    store.getState().applyExecutionEvents('agent:main:clawwork:task:task-1', events);
    const second = store.getState().executionBySession['agent:main:clawwork:task:task-1'];
    expect(second).toBe(first);
    expect(Object.values(second?.steps ?? {})).toHaveLength(1);
  });

  it('⭐ 接线：applyExecutionEvents 把被接受的状态边缘交给历史 writer（进度合并、拒收事件不喂）', () => {
    const persisted: Array<{ sessionKey: string; records: readonly ExecutionEvent[] }> = [];
    const store = createMessageStore({
      persistMessage: async () => ({ ok: true }),
      persistExecutionHistory: (sessionKey, records) => persisted.push({ sessionKey, records }),
    });
    const SK = 'agent:main:clawwork:task:task-1';

    // 同一 step 两条进度 + 一条终态：历史只收终态（进度在批内被合并丢弃）
    store.getState().applyExecutionEvents(SK, [
      base({ eventId: 'f1#0', seq: 0 }),
      base({ eventId: 'f2#0', seq: 1 }),
      base({
        eventId: 'f3#0',
        seq: 2,
        type: 'step.result',
        payload: { toolCallId: 'tc-1', name: 'read', isError: false, resultText: 'ok' },
      }),
    ]);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].records.map((r) => r.eventId)).toEqual(['f3#0']);

    // 被归约拒收的事件（旧 run 晚包）不喂历史
    persisted.length = 0;
    store.getState().applyExecutionEvents(SK, [base({ runId: 'run-old', eventId: 'f9#0' })]);
    expect(persisted, '拒收的事件不进历史').toHaveLength(0);
  });

  it('⭐ 断线远端终态未收到 ⇒ 恢复只还原本地证据：unknown 过程保留 gap、不补造终态', () => {
    // 本地只收到 dispatched；模型结束事件缺失（断线）——恢复后步骤是 unreported 投影
    // 的基础（dispatched），**不**补造 done/approval 通过。
    let p = createExecutionProjection('run-a');
    const dispatched = base({ eventId: 'f1#0' });
    p = reduceExecutionProjection(p, dispatched);
    expect(Object.values(p.steps)[0].state, '无结果证据 ⇒ 保持 dispatched').toBe('dispatched');
    expect(p.approvals, '无审批证据 ⇒ 空').toEqual({});
    expect(p.delivery.phase, '无交付证据 ⇒ none').toBe('none');
  });
});
