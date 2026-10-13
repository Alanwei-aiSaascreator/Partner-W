import { beforeEach, expect, it, vi } from 'vitest';
import { createMessageStore, type ExecutionEvent } from '@clawwork/core';

/**
 * ⭐ V3-artifact（2026-10-13/14）：停止（cancel）事件喂入 —— 复用既有 stop ticket，
 * 把 `cancel.requested / confirmed / unconfirmed` 折回渲染层投影（真实 core store）。
 *
 * 计划口径（§V3 取消红例）：展示 requested/unconfirmed/confirmed；**超时与 RPC reject
 * 不显示"已停止"**；旧 ticket 的确认不清新 run。归属（runId/taskId）由调用方显式提供
 * （stop ticket 自身不带 runId）——缺上下文时 fail-closed：一个事件都不发。
 */

const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [{ webContents: { isDestroyed: () => false, send: mocks.send } }] },
  ipcMain: { handle: vi.fn() },
}));

import {
  noteGatewayTurnLifecycle,
  noteGatewayTurnStop,
  noteGatewayTurnStopRejected,
  releaseGatewayTurnSessions,
  resetTurnLifecycleForTests,
  retryPendingGatewayTurnStops,
} from '../src/main/artifact/turn-lifecycle.js';
import { getWorkspaceScope, setWorkspaceDatabaseOwner } from '../src/main/workspace/scope.js';
import { EXECUTION_EVENTS_CHANNEL, resetMainExecutionEventsForTests } from '../src/main/artifact/execution-events.js';

const session = 'agent:main:clawwork:task:task-1';
const context = { runId: 'run-1' };

beforeEach(() => {
  mocks.send.mockClear();
  // ⭐ P-3（2026-10-14）：合法 workspace 上下文 —— 取消帧必须带**捕获时**的
  //    scope/revision（缺 scope 的帧在发射侧即 fail-closed 拒发）。
  setWorkspaceDatabaseOwner({});
  resetTurnLifecycleForTests();
  resetMainExecutionEventsForTests();
});

interface EmittedPayload {
  sessionKey: string;
  events: ExecutionEvent[];
  workspaceScope: string | null;
  workspaceRevision: number;
}

function emittedPayloads(): EmittedPayload[] {
  return mocks.send.mock.calls
    .filter((call) => call[0] === EXECUTION_EVENTS_CHANNEL)
    .map((call) => call[1] as EmittedPayload);
}

function emittedEvents(): ExecutionEvent[] {
  return emittedPayloads().flatMap((payload) => payload.events);
}

function foldInto(store: ReturnType<typeof createMessageStore>): void {
  store.getState().applyExecutionEvents(session, emittedEvents());
}

it('⭐ 点击停止 ⇒ requested；网关确认 ⇒ confirmed（同一 ticketId，真实 store 折入）', () => {
  const store = createMessageStore({ persistMessage: vi.fn(async () => ({ ok: true })) });
  noteGatewayTurnLifecycle('start', session, 'gw-1');
  const ticket = noteGatewayTurnStop(session, false, undefined, context);
  expect(ticket).toBeDefined();
  foldInto(store);
  expect(store.getState().executionBySession[session]!.stop).toMatchObject({ state: 'requested' });

  noteGatewayTurnStop(session, true, ticket, context);
  foldInto(store);
  expect(store.getState().executionBySession[session]!.stop).toMatchObject({ state: 'confirmed' });

  const [requested, confirmed] = emittedEvents();
  expect(requested.type).toBe('cancel.requested');
  expect(confirmed.type).toBe('cancel.confirmed');
  // 两次说的是"同一次操作"：ticketId 逐字相同（投影据此核身份）
  expect((requested.payload as { stopTicketId?: string }).stopTicketId).toBe(
    (confirmed.payload as { stopTicketId?: string }).stopTicketId,
  );
  expect(requested).toMatchObject({ runId: 'run-1', taskId: 'task-1', source: { gatewayId: 'gw-1' } });

  // ⭐ P-3：帧载荷带**捕获时**的 workspace scope/revision（requested 与 confirmed 同代）
  const scope = getWorkspaceScope();
  const payloads = emittedPayloads();
  expect(payloads).toHaveLength(2);
  for (const payload of payloads) {
    expect(payload.workspaceScope).toBe(scope.scope);
    expect(payload.workspaceRevision).toBe(scope.revision);
  }
});

it('⭐ RPC reject / 超时 ⇒ unconfirmed（不显示"已停止"），且不落软状态（仍有重试路径）', () => {
  const store = createMessageStore({ persistMessage: vi.fn(async () => ({ ok: true })) });
  noteGatewayTurnLifecycle('start', session, 'gw-1');
  const ticket = noteGatewayTurnStop(session, false, undefined, context)!;
  expect(noteGatewayTurnStopRejected(session, ticket, 'rpc-error', context)).toBe(true);
  foldInto(store);
  expect(store.getState().executionBySession[session]!.stop).toMatchObject({
    state: 'unconfirmed',
    reason: 'rpc-error',
  });
  // 软状态没被这条"未确认"落掉：重连补发仍能确认（ticket 被消费 = true）
  expect(noteGatewayTurnStop(session, true, ticket, context)).toBe(ticket);
});

it('⭐ 网关终结 / 重连耗尽 ⇒ unconfirmed{gateway-terminated}（再也不可能确认）', () => {
  const store = createMessageStore({ persistMessage: vi.fn(async () => ({ ok: true })) });
  const scope = getWorkspaceScope();
  noteGatewayTurnLifecycle('start', session, 'gw-1');
  const ticket = noteGatewayTurnStop(session, false, undefined, context)!;
  // ⭐ R6：终结调用点（gateway-client 不带上下文）也必须从**原 ticket** 取身份 ——
  //    这里显式只给 gatewayId/reason，身份仍应落在原 run + 原捕获代上。
  releaseGatewayTurnSessions('gw-1', 'destroyed');
  foldInto(store);
  expect(store.getState().executionBySession[session]!.stop).toMatchObject({
    state: 'unconfirmed',
    reason: 'gateway-terminated',
  });
  const unconfirmed = emittedEvents().filter((event) => event.type === 'cancel.unconfirmed');
  expect(unconfirmed).toHaveLength(1);
  expect(unconfirmed[0]).toMatchObject({ runId: 'run-1', taskId: 'task-1', source: { gatewayId: 'gw-1' } });
  expect((unconfirmed[0]!.payload as { stopTicketId: string }).stopTicketId).toBe(ticket.stopTicketId);
  const payload = emittedPayloads().find((entry) => entry.events.some((event) => event.type === 'cancel.unconfirmed'))!;
  expect(payload.workspaceScope).toBe(scope.scope);
  expect(payload.workspaceRevision).toBe(scope.revision);
});

it('⭐ P-3：确认帧盖的是 ticket **创建代**的 scope/revision（确认前换区也不重取当前代）', () => {
  const capturedAtStop = getWorkspaceScope();
  noteGatewayTurnLifecycle('start', session, 'gw-1');
  const ticket = noteGatewayTurnStop(session, false, undefined, context)!; // 捕获代 A
  // 确认到达**之前**工作区换代（B）：帧必须仍标 A（"发出前换区"的帧不得被错标成新代）。
  setWorkspaceDatabaseOwner({});
  const currentNow = getWorkspaceScope();
  expect(currentNow.scope).not.toBe(capturedAtStop.scope);

  expect(noteGatewayTurnStop(session, true, ticket, context)).toBe(ticket);
  const payload = emittedPayloads().find((entry) => entry.events.some((event) => event.type === 'cancel.confirmed'))!;
  expect(payload.workspaceScope).toBe(capturedAtStop.scope);
  expect(payload.workspaceRevision).toBe(capturedAtStop.revision);
});

it('⭐ 无 runId 上下文 ⇒ fail-closed：一个事件都不发（ticket 语义不受影响）', () => {
  noteGatewayTurnLifecycle('start', session, 'gw-1');
  const ticket = noteGatewayTurnStop(session, false);
  expect(ticket).toBeDefined(); // 既有 stop ticket 语义原样
  expect(emittedEvents()).toHaveLength(0);
  expect(noteGatewayTurnStop(session, true, ticket)).toBe(ticket);
  expect(emittedEvents()).toHaveLength(0);
});

it('网关不在跑（没有软状态）⇒ 没有 ticket、也没有事件', () => {
  expect(noteGatewayTurnStop(session, false, undefined, context)).toBeUndefined();
  expect(noteGatewayTurnStopRejected(session, { gatewayId: 'gw-1', since: 1 }, 'rpc-error', context)).toBe(false);
  expect(emittedEvents()).toHaveLength(0);
});

it('⭐ 旧 ticket 的迟到回执/确认一个字节都不动（不清新 run、不发错事件）', () => {
  noteGatewayTurnLifecycle('start', session, 'gw-1');
  const oldTicket = noteGatewayTurnStop(session, false, undefined, context)!;
  // 新一轮开始 ⇒ 旧 pending 作废；再停一次拿到新 ticket
  noteGatewayTurnLifecycle('start', session, 'gw-1');
  const newTicket = noteGatewayTurnStop(session, false, undefined, context)!;
  const before = emittedEvents().length;

  expect(noteGatewayTurnStopRejected(session, oldTicket, 'rpc-error', context)).toBe(false);
  expect(noteGatewayTurnStop(session, true, oldTicket, context)).toBeUndefined();
  expect(emittedEvents(), '迟到回执不许产出任何事件').toHaveLength(before);
  // 新 ticket 仍是唯一可确认的那条
  expect(noteGatewayTurnStop(session, true, newTicket, context)).toBe(newTicket);
});

it('确认成功落下软状态：该会话不再算"在跑"', () => {
  noteGatewayTurnLifecycle('start', session, 'gw-1');
  const ticket = noteGatewayTurnStop(session, false, undefined, context)!;
  noteGatewayTurnStop(session, true, ticket, context);
  expect(noteGatewayTurnStop(session, false, undefined, context)).toBeUndefined(); // 已落地，没有可核对的轮次
});

// ───────────── ⭐ R6（2026-10-14 五小时窗）：停止 ticket 冻结原始身份 ─────────────

it('⭐ R6：abort 超时未确认 → 重连补发真实应答 ⇒ 原 run cancel.confirmed 恰一次且 runId/scope/revision 全同', async () => {
  const store = createMessageStore({ persistMessage: vi.fn(async () => ({ ok: true })) });
  const scope = getWorkspaceScope();
  noteGatewayTurnLifecycle('start', session, 'gw-1');
  const ticket = noteGatewayTurnStop(session, false, undefined, context)!;
  // 首次 abort 被拒/超时 ⇒ 如实 unconfirmed（不显示"已停止"）；软状态保留待补发。
  expect(noteGatewayTurnStopRejected(session, ticket, 'timeout', context)).toBe(true);
  foldInto(store);
  expect(store.getState().executionBySession[session]!.stop).toMatchObject({
    state: 'unconfirmed',
    reason: 'timeout',
  });
  const requested = emittedEvents().find((event) => event.type === 'cancel.requested')!;
  const ticketId = (requested.payload as { stopTicketId: string }).stopTicketId;

  // run 队列清空（本地已取消）之后，重连成功 ⇒ 真实补发拿到真实应答（aborted:false = 本来没在跑）。
  await retryPendingGatewayTurnStops('gw-1', async () => ({ aborted: false }));
  foldInto(store);
  // ⭐ 修复前：补发确认没有调用方上下文 ⇒ runId 缺 ⇒ 事件被拒发，投影永远停在 unconfirmed。
  expect(store.getState().executionBySession[session]!.stop).toMatchObject({ state: 'confirmed' });

  const confirmed = emittedEvents().filter((event) => event.type === 'cancel.confirmed');
  expect(confirmed, '确认恰一次，且带原 run 身份').toHaveLength(1);
  expect(confirmed[0]).toMatchObject({ runId: 'run-1', taskId: 'task-1', source: { gatewayId: 'gw-1' } });
  expect((confirmed[0]!.payload as { stopTicketId: string }).stopTicketId).toBe(ticketId);
  // 帧载荷 scope/revision = ticket 捕获的那一代（不是"当前"重新取的）
  const confirmedPayload = emittedPayloads().find((payload) =>
    payload.events.some((event) => event.type === 'cancel.confirmed'),
  )!;
  expect(confirmedPayload.workspaceScope).toBe(scope.scope);
  expect(confirmedPayload.workspaceRevision).toBe(scope.revision);
});

it('⭐ R6：旧回执在途期间开启新轮 ⇒ 旧 ticket 确认一个字节都不动（新轮不受影响）', async () => {
  noteGatewayTurnLifecycle('start', session, 'gw-1');
  const oldTicket = noteGatewayTurnStop(session, false, undefined, context)!;
  // 补发在途（应答挂住），期间用户又发了一条：新一轮开始，旧 pending 作废。
  let resolveAbort!: (value: unknown) => void;
  const inFlight = retryPendingGatewayTurnStops('gw-1', () => new Promise((resolve) => (resolveAbort = resolve)));
  await Promise.resolve();
  noteGatewayTurnLifecycle('start', session, 'gw-1');
  const before = emittedEvents().length;

  resolveAbort({ aborted: false });
  await inFlight;
  // 旧回执不产出任何确认帧；新的 pending（无 run 上下文）也不发事件。
  expect(emittedEvents(), '旧回执不许确认新轮').toHaveLength(before);
  // 旧 ticket 直接确认也被拒（对象身份不符）
  expect(noteGatewayTurnStop(session, true, oldTicket, context)).toBeUndefined();
  expect(emittedEvents()).toHaveLength(before);
});

it('⭐ R6：无 runId 的 ticket 在补发确认时同样 fail-closed（软状态照常落地，不发错归属）', async () => {
  noteGatewayTurnLifecycle('start', session, 'gw-1');
  const ticket = noteGatewayTurnStop(session, false)!; // 无 runId 上下文
  expect(ticket).toBeDefined();
  const before = emittedEvents().length;
  await retryPendingGatewayTurnStops('gw-1', async () => ({ aborted: false }));
  expect(emittedEvents(), '缺 runId ⇒ 不发事件（不猜归属）').toHaveLength(before);
  expect(noteGatewayTurnStop(session, false, undefined, context)).toBeUndefined(); // 软状态已落地
});

it('⭐ R6 ②：期间开启新 run（投影已切 run-2）⇒ 原 run 的迟到确认帧不改变新 run', async () => {
  const store = createMessageStore({ persistMessage: vi.fn(async () => ({ ok: true })) });
  noteGatewayTurnLifecycle('start', session, 'gw-1');
  expect(noteGatewayTurnStop(session, false, undefined, context), 'run-1 的停止（未确认）').toBeDefined();
  foldInto(store);
  expect(store.getState().executionBySession[session]!.stop).toMatchObject({ state: 'requested' });

  // 同一会话开新 run（同一轮内的新一轮绑定）：投影切到 run-2。
  store.getState().beginExecutionRun(session, 'run-2');
  // run-1 的迟到确认（重连补发真实应答）现在返回。
  await retryPendingGatewayTurnStops('gw-1', async () => ({ aborted: false }));

  const confirmed = emittedEvents().filter((event) => event.type === 'cancel.confirmed');
  expect(confirmed, '确认帧带原 run 身份（不是新 run）').toHaveLength(1);
  expect(confirmed[0]!.runId).toBe('run-1');
  foldInto(store);
  const projection = store.getState().executionBySession[session]!;
  expect(projection.runId, '投影仍在新 run 上').toBe('run-2');
  expect(projection.stop, '旧 run 的迟到帧不改变新 run 的停止态').toMatchObject({ state: 'none' });
});

it('⭐ P-3：无有效 workspace scope（库已关）⇒ 取消族同样零广播（run 身份齐全也不发）', () => {
  setWorkspaceDatabaseOwner(null);
  expect(getWorkspaceScope().scope).toBeNull();
  noteGatewayTurnLifecycle('start', session, 'gw-1');
  const ticket = noteGatewayTurnStop(session, false, undefined, context)!; // runId 齐全
  expect(noteGatewayTurnStopRejected(session, ticket, 'timeout', context)).toBe(true);
  releaseGatewayTurnSessions('gw-1', 'destroyed');
  expect(emittedEvents(), '无捕获 scope ⇒ 一帧不发（fail-closed）').toHaveLength(0);
});
