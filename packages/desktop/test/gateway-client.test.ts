import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_RECONNECT_ATTEMPTS, RECONNECT_DELAY_MS } from '@clawwork/shared';
import { sendToWindow } from '../src/main/ws/window-utils.js';

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

vi.mock('ws', () => ({
  default: websocketMock.constructor,
}));

vi.mock('electron', () => ({
  app: {
    getVersion: vi.fn(() => '0.0.0-test'),
    // GatewayClient.connect 会拿它算 win-ca 的证书目录（tls-trust 已在本文件被 mock）
    getPath: vi.fn(() => '/tmp/clawwork-test-userdata'),
  },
}));

vi.mock('../src/main/ws/window-utils.js', () => ({
  sendToWindow: vi.fn(),
}));

vi.mock('../src/main/window-manager.js', () => ({
  getMainWindow: vi.fn(() => null),
}));

vi.mock('../src/main/ws/device-identity.js', () => ({
  loadOrCreateDeviceIdentity: vi.fn(() => ({ deviceId: 'device', publicKeyPem: 'public', privateKeyPem: 'private' })),
  buildDeviceConnectPayload: vi.fn(() => ({})),
  saveDeviceToken: vi.fn(),
  loadDeviceToken: vi.fn(() => null),
}));

vi.mock('../src/main/debug/index.js', () => ({
  getDebugLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock('../src/main/ws/tls-trust.js', () => ({
  ensureGatewayWindowsSystemTrust: vi.fn(),
}));

describe('GatewayClient connection lifecycle', () => {
  const clients: Array<{ destroy: () => void }> = [];

  function pendingRequestCount(client: object): number {
    return (client as unknown as { pendingRequests: Map<string, unknown> }).pendingRequests.size;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    websocketMock.constructor.mockClear();
    websocketMock.instances.length = 0;
  });

  afterEach(() => {
    for (const client of clients) client.destroy();
    clients.length = 0;
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('calculates capped exponential reconnect delays', async () => {
    const { calculateReconnectDelay } = await import('../src/main/ws/gateway-client.js');

    expect(calculateReconnectDelay(1)).toBe(RECONNECT_DELAY_MS);
    expect(calculateReconnectDelay(2)).toBe(RECONNECT_DELAY_MS * 2);
    expect(calculateReconnectDelay(3)).toBe(RECONNECT_DELAY_MS * 4);
    expect(calculateReconnectDelay(6)).toBe(RECONNECT_DELAY_MS * 32);
    expect(calculateReconnectDelay(7)).toBe(RECONNECT_DELAY_MS * 32);
    expect(calculateReconnectDelay(MAX_RECONNECT_ATTEMPTS)).toBe(RECONNECT_DELAY_MS * 32);
  });

  it('rejects requests that exceed the 15-second timeout', async () => {
    const { GatewayClient } = await import('../src/main/ws/gateway-client.js');
    const client = new GatewayClient({
      id: 'gw-1',
      name: 'Gateway',
      url: 'ws://127.0.0.1:18789',
      auth: { token: 'token' },
    });
    clients.push(client);
    client.connect();

    const socket = websocketMock.instances[0];
    if (!socket) throw new Error('expected a websocket instance');
    socket.readyState = 1;

    let settled = false;
    const request = client.sendReq('slow.request', {});
    void request.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    vi.advanceTimersByTime(14_999);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(pendingRequestCount(client)).toBe(1);

    vi.advanceTimersByTime(1);
    await expect(request).rejects.toMatchObject({
      message: 'request timeout: slow.request',
      code: 'TIMEOUT',
    });
    expect(pendingRequestCount(client)).toBe(0);
  });

  it('rejects pending requests immediately when the websocket closes', async () => {
    const { GatewayClient } = await import('../src/main/ws/gateway-client.js');
    const client = new GatewayClient({
      id: 'gw-1',
      name: 'Gateway',
      url: 'ws://127.0.0.1:18789',
      auth: { token: 'token' },
    });
    clients.push(client);
    client.connect();

    const socket = websocketMock.instances[0];
    if (!socket) throw new Error('expected a websocket instance');
    socket.readyState = 1;

    const first = client.sendReq('first', {});
    const second = client.sendReq('second', {});
    const settled = Promise.allSettled([first, second]);

    expect(pendingRequestCount(client)).toBe(2);

    socket.emit('close', 1006, Buffer.from('network failure'));
    const results = await settled;

    expect(results).toEqual([
      {
        status: 'rejected',
        reason: expect.objectContaining({ message: 'connection closed', code: 'GATEWAY_CONNECTION_CLOSED' }),
      },
      {
        status: 'rejected',
        reason: expect.objectContaining({ message: 'connection closed', code: 'GATEWAY_CONNECTION_CLOSED' }),
      },
    ]);
    expect(pendingRequestCount(client)).toBe(0);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(15_000);
    expect(pendingRequestCount(client)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

/**
 * 2026-09-20 现场（用户截图）：横幅一直挂着「网关"Local Gateway"已断开，正在尝试重连… (0/10)」、
 * 输入框「离线模式 — 只读」、准备面板超过 90 秒变成「准备时间比平时更久」。
 *
 * `(0/10)` 说明界面收到的 `reconnectAttempt` 是 **0** —— 也就是**一次都没重试过**，
 * 而横幅却在说"正在尝试重连"。两个真实的无声停摆路径：
 *   ① 服务端明确拒绝（1008）⇒ 客户端**刻意不重连**（`d1abc55e`），但报给界面的
 *      状态是 `gaveUp:false` ⇒ 界面永远停在"正在重连"，**一个出路都没有**（只有重启）。
 *   ② 第一次握手 `connect` 请求 15 秒超时（网关卡住 / 还在预热，T-a8 那类）
 *      ⇒ 也被当成"服务端拒绝"关掉 ⇒ 同样永久停摆。
 */
describe('断线之后不许无声停摆：服务端拒绝 vs 这次连接没成', () => {
  const clients: Array<{ destroy: () => void }> = [];

  beforeEach(() => {
    vi.useFakeTimers();
    websocketMock.constructor.mockClear();
    websocketMock.instances.length = 0;
    vi.mocked(sendToWindow).mockClear();
  });

  afterEach(() => {
    for (const client of clients) client.destroy();
    clients.length = 0;
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  /** 真 `ws.close(code)` 会**触发 close 事件**；这个 mock 默认只是个空函数，得补上。 */
  function closeEmitsCloseEvent(socket: {
    close: ReturnType<typeof vi.fn>;
    readyState: number;
    emit: (e: string, ...a: unknown[]) => void;
  }): void {
    socket.close.mockImplementation((...args: unknown[]) => {
      socket.readyState = 3;
      socket.emit('close', (args[0] as number | undefined) ?? 1005, Buffer.from(''));
    });
  }

  function sentFrameId(socket: { send: ReturnType<typeof vi.fn> }, method: string): string {
    const frames = socket.send.mock.calls.map((call) => JSON.parse(String(call[0])) as { id: string; method: string });
    const frame = frames.find((item) => item.method === method);
    if (!frame) throw new Error(`没有发出 ${method} 帧：${JSON.stringify(frames.map((f) => f.method))}`);
    return frame.id;
  }

  function lastStatus(): Record<string, unknown> {
    const call = vi.mocked(sendToWindow).mock.calls.at(-1);
    if (!call) throw new Error('没有给界面发过 gateway-status');
    expect(call[1]).toBe('gateway-status');
    return call[2] as Record<string, unknown>;
  }

  function connectAndChallenge(client: { connect: () => void }) {
    client.connect();
    const socket = websocketMock.instances.at(-1);
    if (!socket) throw new Error('expected a websocket instance');
    closeEmitsCloseEvent(socket);
    socket.readyState = 1;
    socket.emit('message', JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n1' } }));
    return { socket, frameId: sentFrameId(socket, 'connect') };
  }

  async function makeClient() {
    const { GatewayClient } = await import('../src/main/ws/gateway-client.js');
    const client = new GatewayClient({
      id: 'gw-1',
      name: 'Gateway',
      url: 'ws://127.0.0.1:18789',
      auth: { token: 'token' },
    });
    clients.push(client);
    return client;
  }

  it('握手超时不是“服务端拒绝”：一次 15 秒超时之后还要能再连（网关卡住时不许永久停摆）', async () => {
    const client = await makeClient();
    const { socket } = connectAndChallenge(client);

    await vi.advanceTimersByTimeAsync(15_000); // 网关一个字都没回 ⇒ connect 请求超时
    expect(websocketMock.instances.length).toBe(1);
    expect(lastStatus()['gaveUp']).not.toBe(true);

    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS); // 第一次背退到点
    expect(websocketMock.instances.length).toBe(2); // ⭐ 真的又连了一次
    expect(socket.close).toHaveBeenCalled();
  });

  it('网关回了错误码才算“明确拒绝”：不重连，但必须把“不再自动重连”如实报出去（gaveUp）', async () => {
    const client = await makeClient();
    const { socket, frameId } = connectAndChallenge(client);

    socket.emit(
      'message',
      JSON.stringify({
        type: 'res',
        id: frameId,
        ok: false,
        error: { code: 'INVALID_REQUEST', message: 'auth denied' },
      }),
    );
    await vi.advanceTimersByTimeAsync(0);

    const status = lastStatus();
    expect(status['gaveUp']).toBe(true); // ⭐ 界面这才换得成有出口的收尾态
    expect(String(status['error'])).toContain('auth denied');
    expect(vi.getTimerCount()).toBe(0); // 不再重连
    expect(websocketMock.instances.length).toBe(1);
  });

  it('码放在 details 里（PAIRING_REQUIRED 那种形状）同样算明确拒绝：不重连、并且说出来', async () => {
    const client = await makeClient();
    const { socket, frameId } = connectAndChallenge(client);

    socket.emit(
      'message',
      JSON.stringify({
        type: 'res',
        id: frameId,
        ok: false,
        error: { message: 'pairing required', details: { code: 'PAIRING_REQUIRED' } },
      }),
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(lastStatus()['gaveUp']).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(websocketMock.instances.length).toBe(1);
  });

  it('网关回了错误但没有码：按“这次连接没成”处理（宁可多试，也不许一次事故就判死）', async () => {
    const client = await makeClient();
    const { socket, frameId } = connectAndChallenge(client);

    // `res.error` 里既没有 `code` 也没有 `details.code` ⇒ 认不出"是明确拒绝"⇒ 不判死
    socket.emit('message', JSON.stringify({ type: 'res', id: frameId, ok: false, error: { message: 'boom' } }));
    await vi.advanceTimersByTimeAsync(0);

    expect(lastStatus()['gaveUp']).not.toBe(true);
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS);
    expect(websocketMock.instances.length).toBe(2);
  });

  it('“明确拒绝”之后点“立即重试”必须真的能再连一次（界面上那个按钮不是摆设）', async () => {
    const client = await makeClient();
    const { socket, frameId } = connectAndChallenge(client);

    socket.emit(
      'message',
      JSON.stringify({
        type: 'res',
        id: frameId,
        ok: false,
        error: { code: 'INVALID_REQUEST', message: 'auth denied' },
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(lastStatus()['gaveUp']).toBe(true);

    client.reconnect();
    expect(websocketMock.instances.length).toBe(2);
  });
});
