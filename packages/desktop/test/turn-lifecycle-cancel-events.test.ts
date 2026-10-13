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
} from '../src/main/artifact/turn-lifecycle.js';
import { EXECUTION_EVENTS_CHANNEL, resetMainExecutionEventsForTests } from '../src/main/artifact/execution-events.js';

const session = 'agent:main:clawwork:task:task-1';
const context = { runId: 'run-1' };

beforeEach(() => {
  mocks.send.mockClear();
  resetTurnLifecycleForTests();
  resetMainExecutionEventsForTests();
});

function emittedEvents(): ExecutionEvent[] {
  return mocks.send.mock.calls
    .filter((call) => call[0] === EXECUTION_EVENTS_CHANNEL)
    .flatMap((call) => (call[1] as { events: ExecutionEvent[] }).events);
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
  noteGatewayTurnLifecycle('start', session, 'gw-1');
  noteGatewayTurnStop(session, false, undefined, context);
  releaseGatewayTurnSessions('gw-1', 'destroyed', context);
  foldInto(store);
  expect(store.getState().executionBySession[session]!.stop).toMatchObject({
    state: 'unconfirmed',
    reason: 'gateway-terminated',
  });
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
