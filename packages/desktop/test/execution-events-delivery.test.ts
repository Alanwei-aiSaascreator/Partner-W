import { beforeEach, expect, it, vi } from 'vitest';
import { createMessageStore, type ExecutionEvent } from '@clawwork/core';

/**
 * ⭐ V3-artifact（2026-10-13/14）：主进程**交付事件生产**——可信请求登记 ⇒ started、
 * 作业启动 ⇒ phase、结算 ⇒ settled（绑定在生产者自己的 finish 时点）。
 *
 * 「真实店铺接线」口径：事件由**真实生产者模块**（`captureArtifactDeliveryOperation`
 * → `delivery-activity`）产生，经**真实广播通道**（mock 窗口捕获）取出，再折进
 * **真实 core store**（`createMessageStore` + `applyExecutionEvents` + 真实归约），
 * 断言的是投影状态 —— 不是只测纯函数。
 *
 * 红例（计划 §V3）：模型先 final、视频后完成；PPT+视频一成一败；两项已请求但仅一项
 * 进入 activity/另一项启动失败 ⇒ 都不得判整轮成功；错误 operation 的结算不得补位。
 */

const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [{ webContents: { isDestroyed: () => false, send: mocks.send } }] },
  ipcMain: { handle: vi.fn() },
}));

import { getWorkspaceScope, setWorkspaceDatabaseOwner } from '../src/main/workspace/scope.js';
import { captureArtifactDeliveryOperation } from '../src/main/artifact/delivery-operation.js';
import { EXECUTION_EVENTS_CHANNEL, resetMainExecutionEventsForTests } from '../src/main/artifact/execution-events.js';

const session = 'agent:main:clawwork:task:task-1';
const identity = { taskId: 'task-1', sessionKey: session, messageId: 'm1', runId: 'run-1', gatewayId: 'gw-1' };

beforeEach(() => {
  mocks.send.mockClear();
  setWorkspaceDatabaseOwner({});
  resetMainExecutionEventsForTests();
});

/** 收到的 `artifact:execution-events` 载荷（按到达顺序）。 */
function emittedPayloads(): Array<{ sessionKey: string; events: ExecutionEvent[] }> {
  return mocks.send.mock.calls
    .filter((call) => call[0] === EXECUTION_EVENTS_CHANNEL)
    .map((call) => call[1] as { sessionKey: string; events: ExecutionEvent[] });
}

function foldIntoStore(store: ReturnType<typeof createMessageStore>): void {
  for (const payload of emittedPayloads()) store.getState().applyExecutionEvents(payload.sessionKey, payload.events);
}

function deliveryOf(store: ReturnType<typeof createMessageStore>, key = session) {
  return store.getState().executionBySession[key]?.delivery;
}

/** V 侧同 run 的一条 model.ended（用于钉"模型结束不结算交付"）。 */
function modelEnded(runId = 'run-1'): ExecutionEvent {
  return {
    schemaVersion: 1,
    eventId: 'renderer#model-ended',
    seq: 0,
    runId,
    taskId: 'task-1',
    source: { gatewayId: 'gw-1', channel: 'main', event: 'chat', derivedIndex: 0 },
    receivedAt: Date.now(),
    evidence: 'observed',
    type: 'model.ended',
    payload: { reason: 'final' },
  } as ExecutionEvent;
}

/** 幽灵 operation 的结算（"错误 operation 文件不得补位"的身份层钉子）。 */
function ghostSettled(operationId: string, runId = 'run-1'): ExecutionEvent {
  return {
    schemaVersion: 1,
    eventId: 'renderer#ghost',
    seq: 1,
    runId,
    taskId: 'task-1',
    source: { gatewayId: 'gw-1', channel: 'local', event: 'main', derivedIndex: 0 },
    receivedAt: Date.now(),
    evidence: 'observed',
    type: 'delivery.settled',
    payload: { operationId, outcome: 'complete' },
  } as ExecutionEvent;
}

it('可信请求登记 ⇒ started；作业启动 ⇒ phase；结算 ⇒ settled（真实 store 折入）', () => {
  const store = createMessageStore({ persistMessage: vi.fn(async () => ({ ok: true })) });
  const operation = captureArtifactDeliveryOperation(identity);
  operation.phase('generating-presentation');
  operation.finish('succeeded');
  foldIntoStore(store);

  const delivery = deliveryOf(store)!;
  expect(delivery.phase).toBe('settled');
  expect(delivery.outcome).toBe('complete');
  expect(Object.values(delivery.operations)).toEqual([
    expect.objectContaining({
      operationId: operation.operationId,
      requested: true,
      started: true,
      outcome: 'complete',
    }),
  ]);
  // 活动帧与执行事件共用同一个 operationId（两条通道说同一件事）
  const activity = mocks.send.mock.calls.find((call) => call[0] === 'artifact:delivery-activity')?.[1] as {
    operationId?: string;
  };
  expect(activity?.operationId).toBe(operation.operationId);
});

it('⭐ 模型先 final、作业后完成 ⇒ 交付保持 pending，不被模型结束结算', () => {
  const store = createMessageStore({ persistMessage: vi.fn(async () => ({ ok: true })) });
  const operation = captureArtifactDeliveryOperation(identity);
  operation.phase('generating-video');
  store.getState().applyExecutionEvents(session, [modelEnded()]);
  foldIntoStore(store);

  expect(deliveryOf(store)!.phase).toBe('pending'); // 模型 ended 不结算交付

  operation.finish('succeeded');
  foldIntoStore(store);
  expect(deliveryOf(store)).toMatchObject({ phase: 'settled', outcome: 'complete' });
});

it('⭐ PPT + 视频一成一败 ⇒ partial（不得判整轮成功）', () => {
  const store = createMessageStore({ persistMessage: vi.fn(async () => ({ ok: true })) });
  const doc = captureArtifactDeliveryOperation(identity);
  doc.phase('generating-presentation');
  doc.finish('succeeded');
  const video = captureArtifactDeliveryOperation(identity);
  video.phase('generating-video');
  video.finish('failed');
  foldIntoStore(store);

  const delivery = deliveryOf(store)!;
  expect(delivery.phase).toBe('settled');
  expect(delivery.outcome).toBe('partial');
  expect(delivery.outcome).not.toBe('complete');
});

it('⭐ 两项已请求、仅一项进入作业 ⇒ 另一项未结算，整轮保持 pending（不得判完成）', () => {
  const store = createMessageStore({ persistMessage: vi.fn(async () => ({ ok: true })) });
  // 两项请求都在一轮内先后被登记（真实时序：同一轮的两个生产者各自登记），
  // 之后只有第一项真正跑完；第二项只登记、既不启动也不结算。
  const started = captureArtifactDeliveryOperation(identity);
  captureArtifactDeliveryOperation(identity);
  started.phase('generating-presentation');
  started.finish('succeeded');
  foldIntoStore(store);

  const delivery = deliveryOf(store)!;
  expect(delivery.phase).toBe('pending');
  expect(delivery.outcome).toBeUndefined();
  expect(Object.values(delivery.operations).filter((op) => op.requested)).toHaveLength(2);
});

it('⭐ 另一项启动失败（结算 failed）⇒ partial，不得判整轮成功', () => {
  const store = createMessageStore({ persistMessage: vi.fn(async () => ({ ok: true })) });
  const started = captureArtifactDeliveryOperation(identity);
  started.phase('generating-presentation');
  started.finish('succeeded');
  const failed = captureArtifactDeliveryOperation(identity);
  failed.phase('generating-video');
  failed.finish('failed');
  foldIntoStore(store);

  expect(deliveryOf(store)).toMatchObject({ phase: 'settled', outcome: 'partial' });
});

it('needs-review / canceled 不判完整（如实未确认）', () => {
  const store = createMessageStore({ persistMessage: vi.fn(async () => ({ ok: true })) });
  const review = captureArtifactDeliveryOperation(identity);
  review.phase('saving-artifacts');
  review.finish('needs-review');
  foldIntoStore(store);
  expect(deliveryOf(store)).toMatchObject({ phase: 'settled', outcome: 'unconfirmed' });
});

it('⭐ 普通聊天（无 operation 登记）⇒ 交付 phase 保持 none，通知不必等文件', () => {
  const store = createMessageStore({ persistMessage: vi.fn(async () => ({ ok: true })) });
  store.getState().applyExecutionEvents(session, [modelEnded()]);
  foldIntoStore(store);
  expect(deliveryOf(store)!.phase).toBe('none');
  expect(mocks.send.mock.calls.filter((call) => call[0] === EXECUTION_EVENTS_CHANNEL)).toHaveLength(0);
});

it('⭐ 身份不足（无 runId）⇒ 一个事件都不发（fail-closed，不猜归属）', () => {
  captureArtifactDeliveryOperation({ ...identity, runId: undefined });
  captureArtifactDeliveryOperation({ ...identity, runId: '   ' });
  expect(emittedPayloads()).toHaveLength(0);
  // 同一次操作再带 runId 登记 ⇒ 正常发
  const ok = captureArtifactDeliveryOperation(identity);
  ok.finish('succeeded');
  const events = emittedPayloads().flatMap((payload) => payload.events);
  expect(events.map((event) => event.type)).toEqual(['delivery.started', 'delivery.settled']);
});

it('事件字段：边界分配 eventId/seq、身份与来源如实（不冒充 renderer）', () => {
  const a = captureArtifactDeliveryOperation(identity);
  const b = captureArtifactDeliveryOperation(identity);
  a.finish('succeeded');
  b.finish('failed');
  const events = emittedPayloads().flatMap((payload) => payload.events);
  expect(events.every((event) => event.eventId.startsWith('main#'))).toBe(true);
  expect(events.map((event) => event.seq)).toEqual([0, 1, 2, 3]);
  expect(events[0]).toMatchObject({
    runId: 'run-1',
    taskId: 'task-1',
    evidence: 'observed',
    source: { gatewayId: 'gw-1', channel: 'local', event: 'main' },
  });
});

it('⭐ 未登记过的 operation 结算不得补位（投影不凭空造操作）', () => {
  const store = createMessageStore({ persistMessage: vi.fn(async () => ({ ok: true })) });
  store.getState().applyExecutionEvents(session, [ghostSettled('ghost-op')]);
  const delivery = deliveryOf(store)!;
  expect(delivery.phase).toBe('none');
  expect(Object.values(delivery.operations)).toHaveLength(0);
});

it('工作区作用域变化 ⇒ 生产者拿不到活动句柄时，交付事件仍如实产出（作业确实在跑）', () => {
  const store = createMessageStore({ persistMessage: vi.fn(async () => ({ ok: true })) });
  // 让 begin 拿不到 owner：清掉 workspace owner 后 begin 返回 null；但 phase/finish 的
  // 交付事件描述的是生产者的真实工作，不因活动帧缺席而消失。
  setWorkspaceDatabaseOwner(null);
  const operation = captureArtifactDeliveryOperation(identity);
  operation.phase('generating-presentation');
  operation.finish('succeeded');
  foldIntoStore(store);
  expect(deliveryOf(store)).toMatchObject({ phase: 'settled', outcome: 'complete' });
  expect(getWorkspaceScope()).toBeDefined();
});
