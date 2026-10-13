import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ⭐ P-R2-1（2026-10-14 第二轮）：终态路由的**原生 run 身份**端到端 —— 真实 `GatewayClient`。
 *
 * 复审代码链直指 `gateway-client.ts` 的 lifecycle/chat 终态分发：修复前 chat aborted/error
 * 折成 phase='error'、**不带**原生 run 身份，`turn-lifecycle` 在删除票据前也没有先给原票据
 * 收口 —— 本档用真实客户端 + 内存 ws 驱动真实帧，核这几条：
 *  ① chat.aborted（带 payload.runId）先到 ⇒ 原票据立即收口 `cancel.confirmed`（恰一次），
 *     随后真正的 abort RPC 成功已无票可重复确认；
 *  ② chat.final（带身份）⇒ 只折 `cancel.unconfirmed{run-terminated}`（"该 run 已结束"≠"已停止"）；
 *  ③ 帧**不带**身份（旧/异常帧）⇒ 一个 cancel 事件都不发（fail-closed，不冒充收口）；
 *  ④ 另一个网关的同会话终态 ⇒ 拒（不消费本网关键票据）。
 */

const mocks = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0-test', getPath: () => '/tmp/clawwork-test-userdata' },
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: () => [{ webContents: { isDestroyed: () => false, send: mocks.send } }] },
}));

const websocketMock = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => void;
  type Socket = {
    readyState: number;
    on: ReturnType<typeof vi.fn>;
    removeAllListeners: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    emit: (event: string, ...args: unknown[]) => void;
  };

  const instances: Socket[] = [];
  const constructor = vi.fn().mockImplementation(() => {
    const handlers = new Map<string, Handler>();
    const socket: Socket = {
      readyState: 0,
      on: vi.fn((event: string, handler: Handler) => {
        handlers.set(event, handler);
        return socket;
      }),
      removeAllListeners: vi.fn(() => handlers.clear()),
      close: vi.fn(),
      send: vi.fn(),
      emit: (event: string, ...args: unknown[]) => handlers.get(event)?.(...args),
    };
    instances.push(socket);
    return socket;
  });
  Object.assign(constructor, { OPEN: 1, CONNECTING: 0 });
  return { constructor, instances };
});

vi.mock('ws', () => ({ default: websocketMock.constructor }));

vi.mock('../src/main/ws/window-utils.js', () => ({ sendToWindow: vi.fn() }));
vi.mock('../src/main/window-manager.js', () => ({ getMainWindow: vi.fn(() => null) }));
vi.mock('../src/main/ws/device-identity.js', () => ({
  loadOrCreateDeviceIdentity: vi.fn(() => ({ deviceId: 'device', publicKeyPem: 'public', privateKeyPem: 'private' })),
  buildDeviceConnectPayload: vi.fn(() => ({})),
  saveDeviceToken: vi.fn(),
  loadDeviceToken: vi.fn(() => null),
}));
vi.mock('../src/main/debug/index.js', () => ({
  getDebugLogger: vi.fn(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
}));
vi.mock('../src/main/ws/tls-trust.js', () => ({ ensureGatewayWindowsSystemTrust: vi.fn() }));
vi.mock('../src/main/runtime/gateway-process.js', () => ({ probeStartupz: vi.fn() }));
vi.mock('../src/main/db/index.js', () => {
  const db = {
    insert: () => ({ values: () => ({ onConflictDoUpdate: () => ({ run: () => undefined }) }) }),
    select: () => ({ from: () => ({ where: () => ({ get: () => undefined }) }) }),
  };
  return { getDb: () => db, getSqlite: () => null, isDbReady: () => true };
});
vi.mock('../src/main/workspace/config.js', () => ({ getWorkspacePath: () => 'C:\\workspace' }));
vi.mock('../src/main/ws/index.js', () => ({ getGatewayClient: () => undefined }));
// 工作区作用域：本档聚焦"帧→票据→事件"链，scope 机制自带单测；这里给合法固定代。
vi.mock('../src/main/workspace/scope.js', () => ({
  getWorkspaceScope: () => ({ scope: 'ws-terminal-identity', revision: 7 }),
  setWorkspaceDatabaseOwner: vi.fn(),
}));

import { EXECUTION_EVENTS_CHANNEL, resetMainExecutionEventsForTests } from '../src/main/artifact/execution-events.js';
import type { ExecutionEvent } from '@clawwork/core';

const SESSION = 'agent:main:clawwork:task:task-1';
const context = { runId: 'run-1' };

interface EmittedPayload {
  sessionKey: string;
  events: ExecutionEvent[];
}

function emittedEvents(): ExecutionEvent[] {
  return mocks.send.mock.calls
    .filter((call) => call[0] === EXECUTION_EVENTS_CHANNEL)
    .flatMap((call) => (call[1] as EmittedPayload).events);
}

function countEvents(type: string): ExecutionEvent[] {
  return emittedEvents().filter((event) => event.type === type);
}

type Socket = (typeof websocketMock.instances)[number];

async function helloOk(client: { connect: () => void }): Promise<Socket> {
  client.connect();
  const socket = websocketMock.instances.at(-1);
  if (!socket) throw new Error('expected a websocket instance');
  socket.readyState = 1;
  socket.emit('message', JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n1' } }));
  const frames = socket.send.mock.calls.map((call) => JSON.parse(String(call[0])) as { id: string; method: string });
  const connect = frames.find((frame) => frame.method === 'connect');
  if (!connect) throw new Error('没有发出 connect 帧');
  socket.emit(
    'message',
    JSON.stringify({
      type: 'res',
      id: connect.id,
      ok: true,
      payload: { type: 'hello-ok', server: { version: '2026.9.3' } },
    }),
  );
  await vi.advanceTimersByTimeAsync(0);
  return socket;
}

function gatewayFrame(socket: Socket, event: string, payload: Record<string, unknown>): void {
  socket.emit('message', JSON.stringify({ type: 'event', event, payload }));
}

function frameOf(socket: Socket, method: string): { id: string; method: string } {
  const frames = socket.send.mock.calls.map((call) => JSON.parse(String(call[0])) as { id: string; method: string });
  const found = frames.find((frame) => frame.method === method);
  if (!found) throw new Error(`没有发出 ${method} 帧`);
  return found;
}

function resolveFrame(socket: Socket, id: string, payload: unknown): void {
  socket.emit('message', JSON.stringify({ type: 'res', id, ok: true, payload }));
}

async function makeClient(id: string) {
  const { GatewayClient } = await import('../src/main/ws/gateway-client.js');
  return new GatewayClient({ id, name: id, url: `ws://127.0.0.1:18789`, auth: { token: 't' } });
}

describe('P-R2-1：真实 GatewayClient 的终态路由（原生 run 身份）', () => {
  const clients: Array<{ destroy: () => void }> = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    websocketMock.constructor.mockClear();
    websocketMock.instances.length = 0;
    mocks.send.mockClear();
    resetMainExecutionEventsForTests();
  });

  afterEach(async () => {
    for (const client of clients) client.destroy();
    clients.length = 0;
    const { resetTurnLifecycleForTests } = await import('../src/main/artifact/turn-lifecycle.js');
    resetTurnLifecycleForTests();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('⭐ chat.aborted 带原生身份先到 ⇒ 票据立即收口 confirmed（恰一次）；迟到的成功回执不重复', async () => {
    const gw = await makeClient('gw-1');
    clients.push(gw);
    const socket = await helloOk(gw);
    const { noteGatewayTurnStop } = await import('../src/main/artifact/turn-lifecycle.js');

    gatewayFrame(socket, 'agent', {
      sessionKey: SESSION,
      stream: 'lifecycle',
      data: { phase: 'start' },
      runId: 'run-1',
    });
    const ticket = noteGatewayTurnStop(SESSION, false, undefined, context)!;
    expect(ticket).toBeDefined();
    expect(countEvents('cancel.requested')).toHaveLength(1);

    // 网关**先**发本 run 的真实终态（chat.aborted，带 payload.runId）—— 修复前：票据被删、零事件。
    gatewayFrame(socket, 'chat', { sessionKey: SESSION, state: 'aborted', runId: 'run-1' });
    const confirmed = countEvents('cancel.confirmed');
    expect(confirmed, 'aborted 是本 run 停止请求的真实结局 ⇒ 立即收口').toHaveLength(1);
    expect(confirmed[0]).toMatchObject({ runId: 'run-1', taskId: 'task-1', source: { gatewayId: 'gw-1' } });
    expect((confirmed[0]!.payload as { stopTicketId?: string }).stopTicketId).toBe(ticket.stopTicketId);

    // 随后真正的 abort RPC 成功返回：票据已终结 ⇒ 不产出第二次确认。
    const abortPromise = gw.abortChat(SESSION);
    resolveFrame(socket, frameOf(socket, 'chat.abort').id, { aborted: true });
    await abortPromise;
    await vi.advanceTimersByTimeAsync(0);
    expect(countEvents('cancel.confirmed'), '确认恰一次').toHaveLength(1);
  });

  it('⭐ chat.final 带身份 ⇒ 只折 unconfirmed{run-terminated}（"该 run 已结束"≠"已停止"）', async () => {
    const gw = await makeClient('gw-1');
    clients.push(gw);
    const socket = await helloOk(gw);
    const { noteGatewayTurnStop } = await import('../src/main/artifact/turn-lifecycle.js');

    gatewayFrame(socket, 'agent', {
      sessionKey: SESSION,
      stream: 'lifecycle',
      data: { phase: 'start' },
      runId: 'run-1',
    });
    const ticket = noteGatewayTurnStop(SESSION, false, undefined, context)!;
    gatewayFrame(socket, 'chat', { sessionKey: SESSION, state: 'final', runId: 'run-1' });

    const unconfirmed = countEvents('cancel.unconfirmed');
    expect(unconfirmed).toHaveLength(1);
    expect(unconfirmed[0]!.payload).toMatchObject({ stopTicketId: ticket.stopTicketId, reason: 'run-terminated' });
    expect(countEvents('cancel.confirmed'), '普通 final 不许冒充"已停止"').toHaveLength(0);
  });

  it('⭐ 终态帧不带原生身份 ⇒ 一个 cancel 事件都不发（fail-closed，不冒充收口）', async () => {
    const gw = await makeClient('gw-1');
    clients.push(gw);
    const socket = await helloOk(gw);
    const { noteGatewayTurnStop } = await import('../src/main/artifact/turn-lifecycle.js');

    gatewayFrame(socket, 'agent', { sessionKey: SESSION, stream: 'lifecycle', data: { phase: 'start' } });
    const ticket = noteGatewayTurnStop(SESSION, false, undefined, context)!;
    const before = emittedEvents().length;
    gatewayFrame(socket, 'chat', { sessionKey: SESSION, state: 'aborted' });

    expect(emittedEvents(), '无身份 ⇒ 零新事件').toHaveLength(before);
    expect(countEvents('cancel.confirmed')).toHaveLength(0);
    // 票据本身按既有软状态语义收尾（迟到回执不再消费，也不误报事件）。
    void ticket;
  });

  it('⭐ 另一个网关的同会话终态 ⇒ 拒（本网关键票据仍可确认）', async () => {
    const gw1 = await makeClient('gw-1');
    const gw2 = await makeClient('gw-2');
    clients.push(gw1, gw2);
    const socket1 = await helloOk(gw1);
    const socket2 = await helloOk(gw2);
    const { noteGatewayTurnStop } = await import('../src/main/artifact/turn-lifecycle.js');

    gatewayFrame(socket1, 'agent', {
      sessionKey: SESSION,
      stream: 'lifecycle',
      data: { phase: 'start' },
      runId: 'run-1',
    });
    const ticket = noteGatewayTurnStop(SESSION, false, undefined, context)!;
    const before = emittedEvents().length;

    gatewayFrame(socket2, 'chat', { sessionKey: SESSION, state: 'aborted', runId: 'run-1' });
    expect(emittedEvents(), '另一网关的终态一个事件都不许产出').toHaveLength(before);
    expect(countEvents('cancel.confirmed')).toHaveLength(0);

    // 本网关键票据仍可确认（软状态没被另一个网关的终态清掉）。
    expect(noteGatewayTurnStop(SESSION, true, ticket, context)).toBe(ticket);
    expect(countEvents('cancel.confirmed')).toHaveLength(1);
  });
});
