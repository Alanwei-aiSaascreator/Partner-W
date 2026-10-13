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

const mocks = vi.hoisted(() => ({ send: vi.fn(), sqlite: null as object | null }));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [{ webContents: { isDestroyed: () => false, send: mocks.send } }] },
  ipcMain: { handle: vi.fn() },
}));
// ⭐ 2026-10-14（P-2/P-3 定向验收 4）：`licenses generation` 维度要求在真实
//    `isDeliveryActivityOwnerCurrent` 上比较 —— 只有"有库"时 generation 才参与
//    （无库时两侧都是 null）。默认不提供库（既有用例的上下文不变），仅 generation
//    用例在这一档里临时放一个 opaque 库对象。
vi.mock('../src/main/db/index.js', () => ({
  getSqlite: () => mocks.sqlite,
  getDb: () => ({}),
  isDbReady: () => true,
}));

import { getWorkspaceScope, setWorkspaceDatabaseOwner } from '../src/main/workspace/scope.js';
import { advanceLicenseGeneration } from '../src/main/commercial/license-generation.js';
import { captureArtifactDeliveryOperation } from '../src/main/artifact/delivery-operation.js';
import { EXECUTION_EVENTS_CHANNEL, resetMainExecutionEventsForTests } from '../src/main/artifact/execution-events.js';

const session = 'agent:main:clawwork:task:task-1';
const identity = { taskId: 'task-1', sessionKey: session, messageId: 'm1', runId: 'run-1', gatewayId: 'gw-1' };

beforeEach(() => {
  mocks.send.mockClear();
  mocks.sqlite = null;
  setWorkspaceDatabaseOwner({});
  resetMainExecutionEventsForTests();
});

/**
 * 收到的 `artifact:execution-events` 载荷（按到达顺序）。
 * ⭐ P-3（2026-10-14）：载荷必须携带**捕获时**的 workspace scope/revision ——
 *    渲染层据此拒"主进程校验后发出、到达前换区"的在途帧。
 */
function emittedPayloads(): Array<{
  sessionKey: string;
  events: ExecutionEvent[];
  workspaceScope: string | null;
  workspaceRevision: number;
}> {
  return mocks.send.mock.calls
    .filter((call) => call[0] === EXECUTION_EVENTS_CHANNEL)
    .map(
      (call) =>
        call[1] as {
          sessionKey: string;
          events: ExecutionEvent[];
          workspaceScope: string | null;
          workspaceRevision: number;
        },
    );
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

it('⭐ P-3：每个载荷都盖捕获时的 workspace scope/revision（STARTED/PHASE/SETTLED 同款）', () => {
  const scope = getWorkspaceScope();
  expect(scope.scope).not.toBeNull();
  const operation = captureArtifactDeliveryOperation(identity);
  operation.phase('generating-presentation');
  operation.finish('succeeded');

  const payloads = emittedPayloads();
  expect(payloads.map((payload) => payload.events.map((event) => event.type))).toEqual([
    ['delivery.started'],
    ['delivery.phase'],
    ['delivery.settled'],
  ]);
  for (const payload of payloads) {
    expect(payload.workspaceScope).toBe(scope.scope);
    expect(payload.workspaceRevision).toBe(scope.revision);
  }
  // 同一 operationId 贯穿三个出口（载荷字段不改变兄弟通道共号语义）
  expect(
    payloads
      .flatMap((payload) => payload.events)
      .map((event) => (event.payload as { operationId: string }).operationId),
  ).toEqual([operation.operationId, operation.operationId, operation.operationId]);
});

it('⭐ P-2：无有效 workspace scope（库已关）⇒ 一律零执行广播（旧"照常广播"豁免撤销）', () => {
  setWorkspaceDatabaseOwner(null);
  expect(getWorkspaceScope().scope).toBeNull();
  const operation = captureArtifactDeliveryOperation(identity);
  operation.phase('generating-presentation');
  operation.finish('succeeded');
  expect(emittedPayloads()).toHaveLength(0);
});

it('⭐ P-2 正对照：合法 owner 下 started→phase→settled、operationId 不变、终态幂等', () => {
  const store = createMessageStore({ persistMessage: vi.fn(async () => ({ ok: true })) });
  const scope = getWorkspaceScope();
  const operation = captureArtifactDeliveryOperation(identity);
  operation.phase('generating-presentation');
  operation.finish('succeeded');
  operation.finish('failed'); // 终态幂等：ended 之后不再广播（同一句柄重复 finish 零新增）
  operation.phase('saving-artifacts');

  const events = emittedPayloads().flatMap((payload) => payload.events);
  expect(events.map((event) => event.type)).toEqual(['delivery.started', 'delivery.phase', 'delivery.settled']);
  expect(events[2]!.payload).toMatchObject({ operationId: operation.operationId, outcome: 'complete' });
  foldIntoStore(store);
  expect(deliveryOf(store)).toMatchObject({ phase: 'settled', outcome: 'complete' });
  expect(scope.scope).not.toBeNull();
});

it('⭐ P-2：捕获后换区（含 A→B→A 同一对象复归）⇒ 旧句柄零新广播', () => {
  const ownerA = {};
  setWorkspaceDatabaseOwner(ownerA);
  const scopeA = getWorkspaceScope();
  const operation = captureArtifactDeliveryOperation(identity);
  const before = emittedPayloads().length;
  expect(before).toBe(1); // started 已发（捕获时仍是 A）

  setWorkspaceDatabaseOwner({}); // B
  setWorkspaceDatabaseOwner(ownerA); // 回到 A **对象** —— scope 是新一代 UUID，捕获代仍失效
  expect(getWorkspaceScope().scope).not.toBe(scopeA.scope);

  operation.phase('generating-presentation');
  operation.finish('succeeded');
  expect(emittedPayloads()).toHaveLength(before);
});

it('⭐ P-2：同路径 DB reopen（close→open 新对象）⇒ 旧句柄零新广播', () => {
  const operation = captureArtifactDeliveryOperation(identity);
  setWorkspaceDatabaseOwner(null); // close
  setWorkspaceDatabaseOwner({}); // 同路径 reopen（新 opaque owner 对象）
  const before = emittedPayloads().length;

  operation.phase('generating-presentation');
  operation.finish('succeeded');
  expect(emittedPayloads()).toHaveLength(before);
  // 新代里新的登记照常广播（不是"通道坏了"）
  const fresh = captureArtifactDeliveryOperation(identity);
  fresh.finish('succeeded');
  const events = emittedPayloads()
    .slice(before)
    .flatMap((payload) => payload.events);
  expect(events.map((event) => event.type)).toEqual(['delivery.started', 'delivery.settled']);
});

it('⭐ P-2：同 workspace 账号/授权 generation 更换 ⇒ 旧句柄零新广播（isDeliveryActivityOwnerCurrent 维度）', () => {
  mocks.sqlite = {}; // 有库上下文：licenseGeneration 参与 owner 判据
  const operation = captureArtifactDeliveryOperation(identity);
  const before = emittedPayloads().length;
  advanceLicenseGeneration(); // 同 workspace、同库对象，仅授权代次更换
  operation.phase('generating-presentation');
  operation.finish('succeeded');
  expect(emittedPayloads()).toHaveLength(before);
});

it('⭐ 未登记过的 operation 结算不得补位（投影不凭空造操作）', () => {
  const store = createMessageStore({ persistMessage: vi.fn(async () => ({ ok: true })) });
  store.getState().applyExecutionEvents(session, [ghostSettled('ghost-op')]);
  const delivery = deliveryOf(store)!;
  expect(delivery.phase).toBe('none');
  expect(Object.values(delivery.operations)).toHaveLength(0);
});

// ⚠️ 已删除（2026-10-14，P-2 合同收口）：旧用例「工作区作用域变化 ⇒ …交付事件仍如实产出」
//    把**越界广播**钉成了成功（无 owner 也发）。现行合同：无有效 workspace scope/revision
//    ⇒ 一律零执行广播（见上「P-2」两例：库已关零广播 + 合法 owner 正对照）。
