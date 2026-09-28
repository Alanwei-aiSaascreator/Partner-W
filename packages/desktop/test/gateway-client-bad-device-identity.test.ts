import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendToWindow } from '../src/main/ws/window-utils.js';

/**
 * ⭐⭐ 设备身份**在运行期不可用**时，握手不许把主进程带崩（§二 P0，2026-09-29）。
 *
 * ## 为什么单独一个文件
 *
 * `gateway-client.test.ts` 把 `device-identity.js` **整个打了桩**
 * （`buildDeviceConnectPayload: vi.fn(() => ({}))`）—— 那 45 条用例跑的全是假构建器。
 * 我第一版把用例加在那儿，结果**它咬不住任何东西**：构建器永不抛，
 * 打不打那道 catch 都会绿。（探针打出来 `deviceId = 'device'` 才发现的。）
 *
 * ⇒ 这个文件**保留真身**（`...actual`），只把 `loadOrCreateDeviceIdentity` 换成一个坏身份，
 *    于是 `handleChallenge` 里那句 `signDevicePayload` 会**真的**抛 —— 这才是被守的那条路。
 *
 * ## 被守的行为
 *
 * `handleChallenge` 里构造 `connect` 帧是**同步**的，而 `sendReq(...).catch()` 只管
 * **异步**失败 ⇒ 同步抛出会直接冲出 WS 消息处理器 = **主进程未捕获异常**。
 * 真机那次的表现就是一个错误弹框，而网关握手**永远走不完**。
 */

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

vi.mock('electron', () => ({
  app: {
    getVersion: vi.fn(() => '0.0.0-test'),
    getPath: vi.fn(() => '/tmp/clawwork-test-userdata'),
  },
}));

vi.mock('../src/main/ws/window-utils.js', () => ({ sendToWindow: vi.fn() }));
vi.mock('../src/main/window-manager.js', () => ({ getMainWindow: vi.fn(() => null) }));
vi.mock('../src/main/ws/tls-trust.js', () => ({ ensureGatewayWindowsSystemTrust: vi.fn() }));

const logSpy = vi.hoisted(() => ({ errors: [] as Array<Record<string, unknown>> }));
vi.mock('../src/main/debug/index.js', () => ({
  getDebugLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn((event: Record<string, unknown>) => logSpy.errors.push(event)),
  })),
}));

/** 坏身份开关；默认 null ⇒ 走真身。 */
const identityMock = vi.hoisted(() => ({
  bad: null as null | { deviceId: string; publicKeyPem: string; privateKeyPem: string },
}));

vi.mock('../src/main/ws/device-identity.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/ws/device-identity.js')>();
  return {
    ...actual,
    loadOrCreateDeviceIdentity: () => identityMock.bad ?? actual.loadOrCreateDeviceIdentity(),
  };
});

describe('设备身份不可用：握手不许把主进程带崩', () => {
  const clients: Array<{ destroy: () => void }> = [];

  beforeEach(() => {
    vi.useFakeTimers();
    websocketMock.constructor.mockClear();
    websocketMock.instances.length = 0;
    vi.mocked(sendToWindow).mockClear();
    logSpy.errors.length = 0;
    // 两把都是**解析不开**的垃圾：`signDevicePayload` 必然抛
    identityMock.bad = { deviceId: 'broken', publicKeyPem: 'not-a-key', privateKeyPem: 'not-a-key' };
  });

  afterEach(() => {
    identityMock.bad = null;
    for (const client of clients) client.destroy();
    clients.length = 0;
    vi.clearAllTimers();
    vi.useRealTimers();
  });

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

  function emitChallenge(socket: (typeof websocketMock.instances)[number]): void {
    socket.readyState = 1;
    socket.emit('message', JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n1' } }));
  }

  it('⭐ 挑战到达时**不许抛**（抛出来就是主进程未捕获异常 = 真机那个弹框）', async () => {
    const client = await makeClient();
    client.connect();
    const socket = websocketMock.instances.at(-1);
    if (!socket) throw new Error('expected a websocket instance');

    expect(() => emitChallenge(socket)).not.toThrow();
  });

  it('⭐ 身份不可用 ⇒ **不发出 connect**，而且留下一条说得出原因的日志', async () => {
    const client = await makeClient();
    client.connect();
    const socket = websocketMock.instances.at(-1);
    if (!socket) throw new Error('expected a websocket instance');

    emitChallenge(socket);

    const methods = socket.send.mock.calls.map((call) => (JSON.parse(String(call[0])) as { method?: string }).method);
    expect(methods, '身份不可用时不该假装在握手').not.toContain('connect');
    expect(
      logSpy.errors.some((entry) => entry['event'] === 'gateway.connect.device-identity-unusable'),
      '要留下一条能查的日志（否则用户只说得出"连不上"）',
    ).toBe(true);
  });
});
