import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSessionKey } from '@clawwork/shared';
import { createMessageStore } from '../src/stores/message-store.js';
import { createGatewayDispatcher } from '../src/services/gateway-dispatcher.js';
import { createSessionSync } from '../src/services/session-sync.js';
import type { GatewayDispatcherDeps } from '../src/services/gateway-dispatcher.js';
import type { GatewayEvent } from '../src/ports/gateway-transport.js';
import type { RawHistoryMessage } from '../src/protocol/types.js';
import type { ExecutionEvent } from '../src/protocol/execution-events.js';

/**
 * 2026-10-14 集中修复批（V owner）· run-promotion 红例转绿例。
 *
 * 复审（2026-10-14-execution-run-promotion-review.md）：canonical 提升把 activeTurn 摘掉、
 * 却把**孤立执行投影**留在旧 run 上 ⇒ 同会话下一轮的全部执行事件被归约器跨 run 拒收
 * （投影不切换、V4 历史记录为 0）。修法：在可信 run 绑定/新轮确认边界显式建立
 * execution scope（`beginExecutionRun`），不放松归约器的跨 run 拒收；
 * `clearActiveTurn` 的 early return 也要能清孤立投影（按 scope/run 防陈旧清理误删新轮）。
 */

const task = { id: 'task-1', title: 'Task', gatewayId: 'gw-1', sessionKey: buildSessionKey('task-1') };
const SK = task.sessionKey;
const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

function deliveryStarted(runId: string, operationId = 'op-1'): ExecutionEvent {
  return {
    schemaVersion: 1,
    eventId: `main#${operationId}`,
    seq: 0,
    runId,
    taskId: task.id,
    source: { gatewayId: task.gatewayId, channel: 'local', event: 'main', derivedIndex: 0 },
    evidence: 'observed',
    receivedAt: 1_000,
    type: 'delivery.started',
    payload: { operationId, kind: 'video' },
  } as ExecutionEvent;
}

function harness(history: RawHistoryMessage[] = []) {
  const persistMessage = vi.fn(async () => ({ ok: true }));
  const persistedHistory: Array<{ sessionKey: string; records: readonly ExecutionEvent[] }> = [];
  const store = createMessageStore({
    persistMessage,
    persistExecutionHistory: (sessionKey, records) => persistedHistory.push({ sessionKey, records }),
  });
  const sessionSync = createSessionSync({
    persistence: { persistMessage, loadMessages: async () => ({ ok: true, rows: [] }) },
    gateway: {
      chatHistory: async () => ({ ok: true, result: { messages: history } }),
      syncSessions: async () => ({ ok: true, discovered: [] }),
    },
    getTaskStore: () => ({
      tasks: [task],
      hydrate: async () => {},
      adoptTasks: () => {},
      updateTaskMetadata: () => {},
    }),
    getMessageStore: () => ({ ...store.getState(), setState: store.setState }),
  });
  const syncSessionMessages = vi.fn(sessionSync.syncSessionMessages);
  const notifyAgentResponse = vi.fn();
  let listener: (event: GatewayEvent) => void = () => {};
  const dispatcher = createGatewayDispatcher({
    gateway: {
      onGatewayEvent: (callback: (event: GatewayEvent) => void) => {
        listener = callback;
        return () => {};
      },
      onGatewayStatus: () => () => {},
      onRuntimeStatus: () => () => {},
    },
    getTaskStore: () => ({ tasks: [task], updateTaskTitle: () => {} }),
    getMessageStore: () => ({ ...store.getState(), setState: store.setState }),
    getActiveTaskId: () => task.id,
    markUnread: vi.fn(),
    getSettings: async () => null,
    sendNotification: async () => {},
    isWindowFocused: () => true,
    translate: (key: string) => key,
    reportDebugEvent: () => {},
    notifyAgentResponse,
    syncSessionMessages,
  } as unknown as GatewayDispatcherDeps);
  const stop = dispatcher.start();
  cleanups.push(() => {
    stop();
    dispatcher.reset();
  });
  const emit = (event: string, payload: Record<string, unknown>) =>
    listener({ event, payload, gatewayId: task.gatewayId });
  const lifecycle = (runId: string, phase: string) =>
    emit('agent', { sessionKey: SK, runId, stream: 'lifecycle', data: { phase } });
  const chat = (runId: string, state: string, text: string) =>
    emit('chat', { sessionKey: SK, runId, state, deltaText: text, text });
  const tool = (runId: string, toolCallId: string) =>
    emit('agent', {
      sessionKey: SK,
      runId,
      stream: 'tool',
      data: { name: 'exec', toolCallId, phase: 'start' },
    });
  const drainSyncs = () => Promise.all(syncSessionMessages.mock.results.map((result) => result.value));
  const historyRecordsFor = (runId: string) =>
    persistedHistory
      .filter((entry) => entry.sessionKey === SK)
      .flatMap((entry) => entry.records)
      .filter((record) => record.runId === runId);
  return {
    store,
    persistMessage,
    syncSessionMessages,
    persistedHistory,
    historyRecordsFor,
    emit,
    lifecycle,
    chat,
    tool,
    dispatcher,
    drainSyncs,
  };
}

describe('run-promotion · canonical 提升后同会话下一轮的执行投影', () => {
  it('⭐ 真实序列：run-old 提升 → 新轮 run-new 建立 scope，投影切换且 run-new 有历史记录', async () => {
    const h = harness([
      {
        role: 'assistant',
        timestamp: 1000,
        __openclaw: { runId: 'run-old' },
        content: [{ type: 'text', text: 'old answer' }],
      },
    ]);
    h.lifecycle('run-old', 'start');
    h.chat('run-old', 'delta', 'old answer');
    h.chat('run-old', 'final', 'old answer');
    await h.drainSyncs();

    // 提升发生：canonical 落地、activeTurn 被摘掉、投影留在旧 run（孤儿）
    expect(h.store.getState().messagesByTask[task.id]).toHaveLength(1);
    expect(h.store.getState().activeTurnBySession[SK]).toBeUndefined();

    h.lifecycle('run-new', 'start');
    h.chat('run-new', 'delta', 'new answer');
    h.tool('run-new', 'tool-new');

    expect(h.store.getState().activeTurnBySession[SK]?.runId).toBe('run-new');
    expect(h.store.getState().activeTurnBySession[SK]?.streamingText).toBe('new answer');
    expect(h.store.getState().messagesByTask[task.id], '仍然只有一条 canonical').toHaveLength(1);
    expect(h.store.getState().executionBySession[SK]?.runId, '投影必须切到新轮').toBe('run-new');
    expect(h.historyRecordsFor('run-new').length, '新轮的执行证据必须进历史（拒收 ⇒ 0 条 = 缺陷）').toBeGreaterThan(0);
  });

  it('⭐ 同 run 重连不清：同 runId 再次 lifecycle.start / settle 不重置已有步骤', async () => {
    const h = harness();
    h.lifecycle('run-keep', 'start');
    h.tool('run-keep', 'tool-k');
    const before = h.store.getState().executionBySession[SK];
    expect(Object.keys(before?.steps ?? {})).toHaveLength(1);

    const ticket = h.dispatcher.beginDispatch(task.gatewayId, SK);
    h.dispatcher.settleDispatch(ticket, { sessionKey: SK, runId: 'run-keep' });
    h.lifecycle('run-keep', 'start');

    const after = h.store.getState().executionBySession[SK];
    expect(after?.runId).toBe('run-keep');
    expect(Object.keys(after?.steps ?? {}), '同 run 不清已有证据').toHaveLength(1);
  });

  it('⭐ 旧 run 晚包不覆新投影：新轮建立后旧 run 的工具帧被守卫挡下', async () => {
    const h = harness();
    h.lifecycle('run-old', 'start');
    h.tool('run-old', 'tool-old');
    h.lifecycle('run-new', 'start');
    h.tool('run-new', 'tool-new');

    h.tool('run-old', 'tool-late');
    const projection = h.store.getState().executionBySession[SK];
    expect(projection?.runId).toBe('run-new');
    expect(
      Object.values(projection?.steps ?? {}).some((step) => step.stepId === 'tool-late'),
      '旧 run 晚包不得进新投影',
    ).toBe(false);
    expect(
      h.historyRecordsFor('run-old').filter((record) => record.eventId.includes('late')).length,
      '旧 run 晚包也不得进历史',
    ).toBe(0);
  });

  it('⭐ 交付 pending 时 canonical 提升不提前丢交付（promote 不得清投影）', async () => {
    const h = harness([
      {
        role: 'assistant',
        timestamp: 1000,
        __openclaw: { runId: 'run-deliver' },
        content: [{ type: 'text', text: 'video requested' }],
      },
    ]);
    h.lifecycle('run-deliver', 'start');
    h.store.getState().applyExecutionEvents(SK, [deliveryStarted('run-deliver')]);
    expect(h.store.getState().executionBySession[SK]?.delivery.phase).toBe('pending');

    h.chat('run-deliver', 'final', 'video requested');
    await h.drainSyncs();

    expect(
      h.store.getState().executionBySession[SK]?.delivery.phase,
      'canonical 提升不等于交付结算 —— 交付中必须保留',
    ).toBe('pending');
  });

  it('⭐ adopt（对比列收编）后新轮：投影同样按新 run 轮换', async () => {
    const h = harness();
    // 对比列跑完并被收编：activeTurn 被摘掉、投影留在 run-col
    h.store.getState().applyExecutionEvents(SK, [deliveryStarted('run-col', 'op-col')]);
    h.store.getState().bindActiveRun(SK, 'run-col');
    h.store.getState().replaceStreamText(SK, 'column answer');
    h.store.getState().finalizeStream(SK);
    const adopted = h.store.getState().adoptActiveTurn(SK, task.id);
    expect(adopted).not.toBeNull();
    expect(h.store.getState().activeTurnBySession[SK]).toBeUndefined();

    h.lifecycle('run-after-adopt', 'start');
    h.tool('run-after-adopt', 'tool-a');
    expect(h.store.getState().executionBySession[SK]?.runId).toBe('run-after-adopt');
  });

  it('⭐ clearActiveTurn：孤立投影（无 activeTurn）也要被明确清理清掉', () => {
    const store = createMessageStore({ persistMessage: async () => ({ ok: true }) });
    store.getState().applyExecutionEvents(SK, [deliveryStarted('run-orphan')]);
    expect(store.getState().activeTurnBySession[SK]).toBeUndefined();
    expect(store.getState().executionBySession[SK]?.runId).toBe('run-orphan');

    store.getState().clearActiveTurn(SK);
    expect(store.getState().executionBySession[SK], '明确清理必须能清孤立投影').toBeUndefined();
  });

  it('⭐ 陈旧异步清理不误删新轮：带 runId 期望的清理只清自己那轮', () => {
    const store = createMessageStore({ persistMessage: async () => ({ ok: true }) });
    store.getState().applyExecutionEvents(SK, [deliveryStarted('run-new')]);
    expect(store.getState().executionBySession[SK]?.runId).toBe('run-new');

    // 迟到的旧轮清理（它以为自己还在收拾 run-old）
    store.getState().clearActiveTurn(SK, { runId: 'run-old' });
    expect(store.getState().executionBySession[SK]?.runId, '新轮投影不得被旧清理误删').toBe('run-new');

    store.getState().clearActiveTurn(SK, { runId: 'run-new' });
    expect(store.getState().executionBySession[SK]).toBeUndefined();
  });

  it('⭐ beginExecutionRun 语义：可信绑定即建身份屏障（无事件也不丢身份）、同 run 幂等、异 run 换 scope', () => {
    const store = createMessageStore({ persistMessage: async () => ({ ok: true }) });
    // 第二轮 R2-1：可信绑定边界建立**仅含 run 身份**的屏障投影 —— 不虚构执行事实
    //（无步骤/无生命周期/无交付），但身份已确认是事实，不能为避免"空投影"丢掉屏障。
    store.getState().beginExecutionRun(SK, 'run-x');
    const barrier = store.getState().executionBySession[SK];
    expect(barrier?.runId).toBe('run-x');
    expect(barrier?.modelPhase, '不虚构执行事实').toBe('idle');
    expect(Object.keys(barrier?.steps ?? {}), '屏障无步骤').toHaveLength(0);
    expect(Object.keys(barrier?.delivery.operations ?? {}), '屏障无交付证据').toHaveLength(0);

    store.getState().applyExecutionEvents(SK, [deliveryStarted('run-x')]);
    const first = store.getState().executionBySession[SK];
    store.getState().beginExecutionRun(SK, 'run-x');
    expect(store.getState().executionBySession[SK], '同 run 幂等（引用不变）').toBe(first);

    store.getState().beginExecutionRun(SK, 'run-y');
    const switched = store.getState().executionBySession[SK];
    expect(switched?.runId).toBe('run-y');
    expect(Object.keys(switched?.delivery.operations ?? {}), '旧 run 的作业不冒充新轮需求').toHaveLength(0);
  });

  it('⭐ 第二轮 R2-1：新 run 回执已确认、首帧未到 —— 旧 hydrate 被身份屏障拒绝，新首帧照常折入', async () => {
    const h = harness();
    // 旧轮先留下现场痕迹（activeTurn + 投影属于 run-old 之前的轮次按规则会被轮换）
    h.lifecycle('run-old', 'start');
    h.chat('run-old', 'delta', 'old answer');

    // 可信绑定：dispatch 回执确认 run-new（此刻**还没有任何执行帧**）
    const ticket = h.dispatcher.beginDispatch(task.gatewayId, SK);
    h.dispatcher.settleDispatch(ticket, { sessionKey: SK, runId: 'run-new' });
    expect(
      h.store.getState().executionBySession[SK]?.runId,
      '回执后身份屏障必须在（旧实现此处 projection 仍为旧 run / 无投影）',
    ).toBe('run-new');

    // 旧历史的恢复 Promise 恰在此刻返回：canHydrate 拒 + hydrate 模式零应用（不污染）
    expect(h.store.getState().canHydrateExecution(SK, 'run-old')).toBe(false);
    const applied = h.store.getState().applyExecutionEvents(SK, [deliveryStarted('run-old', 'op-old')], {
      mode: 'hydrate',
    });
    expect(applied, '旧历史零应用（屏障拒绝灌入）').toBe(0);
    expect(h.store.getState().executionBySession[SK]?.runId).toBe('run-new');

    // 新 run 首帧（lifecycle.start + chat.delta）照常折入屏障投影、照常进历史
    h.lifecycle('run-new', 'start');
    h.chat('run-new', 'delta', 'new answer');
    expect(h.store.getState().executionBySession[SK]?.runId).toBe('run-new');
    expect(h.store.getState().executionBySession[SK]?.modelPhase).not.toBe('idle');
    expect(h.store.getState().activeTurnBySession[SK]?.streamingText).toBe('new answer');
    expect(h.historyRecordsFor('run-new').length, '新轮证据必须进历史（被旧投影挡住 ⇒ 0 条 = 缺陷）').toBeGreaterThan(
      0,
    );
    expect(h.historyRecordsFor('run-old').filter((record) => record.eventId.includes('op-old')).length).toBe(0);
  });
});
