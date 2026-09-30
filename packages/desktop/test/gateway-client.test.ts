import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_RECONNECT_ATTEMPTS, RECONNECT_DELAY_MS } from '@clawwork/shared';
import { sendToWindow } from '../src/main/ws/window-utils.js';
import { getDebugLogger } from '../src/main/debug/index.js';

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

  it('does not log a temporary artifact download ticket while returning it to the caller', async () => {
    const { GatewayClient } = await import('../src/main/ws/gateway-client.js');
    const logger = getDebugLogger();
    vi.mocked(getDebugLogger).mockReturnValue(logger);
    const client = new GatewayClient({
      id: 'gw-1',
      name: 'Gateway',
      url: 'ws://127.0.0.1:18789',
      auth: { token: 'test' },
    });
    clients.push(client);
    client.connect();
    const socket = websocketMock.instances.at(-1)!;
    socket.readyState = 1;
    const pending = client.sendReq('artifacts.download', {
      sessionKey: 'agent:main:clawwork:task:qa',
      artifactId: 'artifact_managed_media_test',
    });
    const request = JSON.parse(socket.send.mock.calls.at(-1)![0] as string) as { id: string };
    const payload = {
      url: 'http://127.0.0.1:18789/api/chat/media/outgoing/test/full?mediaTicket=private-download-ticket',
    };
    socket.emit('message', JSON.stringify({ type: 'res', id: request.id, ok: true, payload }));
    await expect(pending).resolves.toEqual(payload);
    expect(JSON.stringify(vi.mocked(logger.info).mock.calls)).not.toContain('private-download-ticket');
  });

  it('passes the explicit model catalog owner onto the wire', async () => {
    const { GatewayClient } = await import('../src/main/ws/gateway-client.js');
    const client = new GatewayClient({
      id: 'gw-1',
      name: 'Gateway',
      url: 'ws://127.0.0.1:18789',
      auth: { token: 'test' },
    });
    clients.push(client);
    const sendReq = vi.spyOn(client, 'sendReq').mockResolvedValue({ models: [] });
    await client.listModels('office');
    expect(sendReq).toHaveBeenCalledWith('models.list', { agentId: 'office' });
  });

  it('⭐ 同一个网关的配置写事务严格串行，失败也必须释放后续队列', async () => {
    const { GatewayClient } = await import('../src/main/ws/gateway-client.js');
    const client = new GatewayClient({
      id: 'gw-1',
      name: 'Gateway',
      url: 'ws://127.0.0.1:18789',
      auth: { token: 'token' },
    });
    clients.push(client);
    let releaseFirst = (): void => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const order: string[] = [];

    const first = client.runConfigMutation(async () => {
      order.push('first:start');
      await firstGate;
      order.push('first:end');
      throw new Error('first failed');
    });
    const second = client.runConfigMutation(async () => {
      order.push('second');
      return 'recovered';
    });

    await vi.waitFor(() => expect(order).toEqual(['first:start']));
    releaseFirst();
    await expect(first).rejects.toThrow('first failed');
    await expect(second).resolves.toBe('recovered');
    expect(order).toEqual(['first:start', 'first:end', 'second']);
  });

  it('⭐ skills.update 必须加入配置写队列，多个随包技能启动升级不能并发争同一份配置', async () => {
    const { GatewayClient } = await import('../src/main/ws/gateway-client.js');
    const client = new GatewayClient({
      id: 'gw-1',
      name: 'Gateway',
      url: 'ws://127.0.0.1:18789',
      auth: { token: 'token' },
    });
    clients.push(client);
    let releaseFirst = (): void => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const sendReq = vi.spyOn(client, 'sendReq').mockResolvedValue({ ok: true });

    const first = client.runConfigMutation(async () => firstGate);
    const update = client.updateSkill({ skillKey: 'presentation-deck-v2', enabled: false });
    await Promise.resolve();
    expect(sendReq).not.toHaveBeenCalled();

    releaseFirst();
    await first;
    await expect(update).resolves.toEqual({ ok: true });
    expect(sendReq).toHaveBeenCalledOnce();
    expect(sendReq).toHaveBeenCalledWith(
      'skills.update',
      {
        skillKey: 'presentation-deck-v2',
        enabled: false,
      },
      { timeoutMs: 60_000 },
    );
  });

  it('⭐ agents.create/update 必须加入同一条配置写队列，不能穿过 relay 事务', async () => {
    const { GatewayClient } = await import('../src/main/ws/gateway-client.js');
    const client = new GatewayClient({
      id: 'gw-1',
      name: 'Gateway',
      url: 'ws://127.0.0.1:18789',
      auth: { token: 'token' },
    });
    clients.push(client);
    let releaseRelay = (): void => {};
    const relayGate = new Promise<void>((resolve) => {
      releaseRelay = resolve;
    });
    const sendReq = vi
      .spyOn(client, 'sendReq')
      .mockImplementation(async (method) =>
        method === 'agents.list'
          ? { agents: [{ id: 'main' }, { id: 'rongying-content' }] }
          : { agentId: 'rongying-content' },
      );

    const relay = client.runConfigMutation(async () => relayGate);
    const create = client.createAgent({ name: 'rongying-content', workspace: 'E:/workspace/rongying-content' });
    const update = client.updateAgent({ agentId: 'rongying-content', name: '内容创作' });
    await Promise.resolve();
    expect(sendReq).not.toHaveBeenCalled();

    releaseRelay();
    await relay;
    await expect(create).resolves.toEqual({ agentId: 'rongying-content' });
    await expect(update).resolves.toEqual({ agentId: 'rongying-content' });
    expect(sendReq).toHaveBeenCalledTimes(3);
    expect(sendReq).toHaveBeenNthCalledWith(1, 'agents.create', {
      name: 'rongying-content',
      workspace: 'E:/workspace/rongying-content',
    });
    expect(sendReq).toHaveBeenNthCalledWith(2, 'agents.list', {}, { timeoutMs: 10_000 });
    expect(sendReq).toHaveBeenNthCalledWith(3, 'agents.update', {
      agentId: 'rongying-content',
      name: '内容创作',
    });
  });

  it('⭐⭐ agents.create 返回后必须等 runtime catalog 看见新 ID，才允许紧接 agents.update', async () => {
    const { GatewayClient } = await import('../src/main/ws/gateway-client.js');
    const client = new GatewayClient({
      id: 'gw-1',
      name: 'Gateway',
      url: 'ws://127.0.0.1:18789',
      auth: { token: 'token' },
    });
    clients.push(client);
    let listReads = 0;
    const sendReq = vi.spyOn(client, 'sendReq').mockImplementation(async (method) => {
      if (method === 'agents.create') return { agentId: 'rongying-content' };
      if (method === 'agents.list') {
        listReads += 1;
        return listReads === 1
          ? { agents: [{ id: 'main' }] }
          : { agents: [{ id: 'main' }, { id: 'rongying-content' }] };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    let settled = false;
    const create = client
      .createAgent({ name: 'rongying-content', workspace: 'E:/workspace/rongying-content' })
      .finally(() => {
        settled = true;
      });
    await vi.advanceTimersByTimeAsync(0);

    expect(sendReq.mock.calls.map(([method]) => method)).toEqual(['agents.create', 'agents.list']);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(100);
    await expect(create).resolves.toEqual({ agentId: 'rongying-content' });
    expect(sendReq.mock.calls.map(([method]) => method)).toEqual(['agents.create', 'agents.list', 'agents.list']);
  });

  it('⭐ create 已成功后 catalog RPC 失败不能抹掉 agentId，且队列必须释放', async () => {
    const { GatewayClient } = await import('../src/main/ws/gateway-client.js');
    const client = new GatewayClient({
      id: 'gw-1',
      name: 'Gateway',
      url: 'ws://127.0.0.1:18789',
      auth: { token: 'token' },
    });
    clients.push(client);
    const sendReq = vi.spyOn(client, 'sendReq').mockImplementation(async (method) => {
      if (method === 'agents.create') return { agentId: 'rongying-content' };
      if (method === 'agents.list') throw new Error('request timeout: agents.list');
      if (method === 'config.get') return { hash: 'h1', config: {} };
      throw new Error(`unexpected method: ${method}`);
    });

    const create = client.createAgent({ name: 'rongying-content', workspace: 'E:/workspace/rongying-content' });
    const resolved = expect(create).resolves.toMatchObject({
      agentId: 'rongying-content',
      visibilityConfirmed: false,
      visibilityError: expect.stringContaining('request timeout: agents.list'),
    });
    await vi.runAllTimersAsync();
    await resolved;
    await expect(client.runConfigMutation((tx) => tx.getConfig())).resolves.toEqual({ hash: 'h1', config: {} });
    expect(sendReq.mock.calls.map(([method]) => method)).toEqual(['agents.create', 'agents.list', 'config.get']);
  });

  it('⭐ runtime catalog 持续缺 ID 时只按 8.5 秒预算轮询，保留 agentId 且队列仍可用', async () => {
    const { GatewayClient } = await import('../src/main/ws/gateway-client.js');
    const client = new GatewayClient({
      id: 'gw-1',
      name: 'Gateway',
      url: 'ws://127.0.0.1:18789',
      auth: { token: 'token' },
    });
    clients.push(client);
    const sendReq = vi.spyOn(client, 'sendReq').mockImplementation(async (method) => {
      if (method === 'agents.create') return { agentId: 'rongying-content' };
      if (method === 'agents.list') return { agents: [{ id: 'main' }] };
      if (method === 'config.get') return { hash: 'h1', config: {} };
      throw new Error(`unexpected method: ${method}`);
    });

    const create = client.createAgent({ name: 'rongying-content', workspace: 'E:/workspace/rongying-content' });
    const resolved = expect(create).resolves.toMatchObject({
      agentId: 'rongying-content',
      visibilityConfirmed: false,
      visibilityError: expect.stringContaining('visibility timeout'),
    });
    await vi.runAllTimersAsync();
    await resolved;
    await expect(client.runConfigMutation((tx) => tx.getConfig())).resolves.toEqual({ hash: 'h1', config: {} });
    expect(sendReq.mock.calls.filter(([method]) => method === 'agents.list')).toHaveLength(10);
  });

  it('⭐ 8.5 秒预算的最后一次 catalog 读取看见 ID 时仍算成功', async () => {
    const { GatewayClient } = await import('../src/main/ws/gateway-client.js');
    const client = new GatewayClient({
      id: 'gw-1',
      name: 'Gateway',
      url: 'ws://127.0.0.1:18789',
      auth: { token: 'token' },
    });
    clients.push(client);
    let listReads = 0;
    const sendReq = vi.spyOn(client, 'sendReq').mockImplementation(async (method) => {
      if (method === 'agents.create') return { agentId: 'rongying-content' };
      if (method === 'agents.list') {
        listReads += 1;
        return {
          agents: listReads === 10 ? [{ id: 'main' }, { id: 'rongying-content' }] : [{ id: 'main' }],
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    let settled = false;
    const create = client
      .createAgent({ name: 'rongying-content', workspace: 'E:/workspace/rongying-content' })
      .finally(() => {
        settled = true;
      });
    await vi.advanceTimersByTimeAsync(8_499);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(create).resolves.toEqual({ agentId: 'rongying-content' });
    expect(sendReq.mock.calls.filter(([method]) => method === 'agents.list')).toHaveLength(10);
  });

  it('⭐ 慢 catalog RPC 也必须受 10 秒总墙钟限制，不能把十轮 15 秒叠成几分钟', async () => {
    const { GatewayClient } = await import('../src/main/ws/gateway-client.js');
    const client = new GatewayClient({
      id: 'gw-1',
      name: 'Gateway',
      url: 'ws://127.0.0.1:18789',
      auth: { token: 'token' },
    });
    clients.push(client);
    let listReads = 0;
    vi.spyOn(client, 'sendReq').mockImplementation(async (method, _params, meta) => {
      if (method === 'agents.create') return { agentId: 'rongying-content' };
      if (method !== 'agents.list') throw new Error(`unexpected method: ${method}`);
      listReads += 1;
      const responseMs = 4_000;
      const timeoutMs = meta?.timeoutMs ?? 15_000;
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        setTimeout(
          () => {
            if (timeoutMs < responseMs) reject(new Error('request timeout: agents.list'));
            else resolve({ agents: [{ id: 'main' }] });
          },
          Math.min(responseMs, timeoutMs),
        );
      });
    });

    let settled = false;
    const create = client
      .createAgent({ name: 'rongying-content', workspace: 'E:/workspace/rongying-content' })
      .finally(() => {
        settled = true;
      });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(create).resolves.toMatchObject({
      agentId: 'rongying-content',
      visibilityConfirmed: false,
    });
    expect(listReads).toBe(3);
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

  it('⭐ 显式长超时可等待到 60 秒，技能冷启动写配置不能在 15 秒时制造迟到副作用', async () => {
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
    const request = client.sendReq('skills.update', {}, { timeoutMs: 60_000 });
    void request.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    vi.advanceTimersByTime(15_000);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(pendingRequestCount(client)).toBe(1);

    vi.advanceTimersByTime(44_999);
    await Promise.resolve();
    expect(settled).toBe(false);

    vi.advanceTimersByTime(1);
    await expect(request).rejects.toMatchObject({
      message: 'request timeout: skills.update',
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

  it('exFAT 写后身份校验误报 unsafe 时，只有精确读回同内容才算写成功', async () => {
    const { GatewayClient } = await import('../src/main/ws/gateway-client.js');
    const client = new GatewayClient({
      id: 'gw-1',
      name: 'Gateway',
      url: 'ws://127.0.0.1:18789',
      auth: { token: 'token' },
    });
    clients.push(client);

    const unsafe = Object.assign(new Error('unsafe workspace file "IDENTITY.md"'), { code: 'INVALID_REQUEST' });
    const sendReq = vi
      .spyOn(client, 'sendReq')
      .mockRejectedValueOnce(unsafe)
      .mockResolvedValueOnce({
        agentId: 'writer',
        file: { name: 'IDENTITY.md', missing: false, content: '# 身份\n' },
      });

    await expect(client.setAgentFile('writer', 'IDENTITY.md', '# 身份\n')).resolves.toMatchObject({
      ok: true,
      agentId: 'writer',
      file: { content: '# 身份\n' },
    });
    expect(sendReq).toHaveBeenNthCalledWith(1, 'agents.files.set', {
      agentId: 'writer',
      name: 'IDENTITY.md',
      content: '# 身份\n',
    });
    expect(sendReq).toHaveBeenNthCalledWith(2, 'agents.files.get', {
      agentId: 'writer',
      name: 'IDENTITY.md',
    });
  });

  it.each([
    ['内容不同', { agentId: 'writer', file: { name: 'SOUL.md', missing: false, content: '旧内容' } }],
    ['agent 不同', { agentId: 'other', file: { name: 'SOUL.md', missing: false, content: '新内容' } }],
    ['文件名不同', { agentId: 'writer', file: { name: 'IDENTITY.md', missing: false, content: '新内容' } }],
    ['文件缺失', { agentId: 'writer', file: { name: 'SOUL.md', missing: true, content: '新内容' } }],
    ['回包畸形', { agentId: 'writer', file: null }],
  ])('unsafe 后读回%s仍然失败，不能把真写失败伪装成成功', async (_case, readback) => {
    const { GatewayClient } = await import('../src/main/ws/gateway-client.js');
    const client = new GatewayClient({
      id: 'gw-1',
      name: 'Gateway',
      url: 'ws://127.0.0.1:18789',
      auth: { token: 'token' },
    });
    clients.push(client);

    const unsafe = Object.assign(new Error('unsafe workspace file "SOUL.md"'), { code: 'INVALID_REQUEST' });
    vi.spyOn(client, 'sendReq').mockRejectedValueOnce(unsafe).mockResolvedValueOnce(readback);

    await expect(client.setAgentFile('writer', 'SOUL.md', '新内容')).rejects.toBe(unsafe);
  });

  it('不是这个文件的精确 unsafe 写后误报时，不读回、不吞错', async () => {
    const { GatewayClient } = await import('../src/main/ws/gateway-client.js');
    const client = new GatewayClient({
      id: 'gw-1',
      name: 'Gateway',
      url: 'ws://127.0.0.1:18789',
      auth: { token: 'token' },
    });
    clients.push(client);

    const unsafe = Object.assign(new Error('unsafe workspace file "OTHER.md"'), { code: 'INVALID_REQUEST' });
    const sendReq = vi.spyOn(client, 'sendReq').mockRejectedValueOnce(unsafe);

    await expect(client.setAgentFile('writer', 'IDENTITY.md', '# 身份\n')).rejects.toBe(unsafe);
    expect(sendReq).toHaveBeenCalledTimes(1);
  });

  it('unsafe 后的读回自身失败时，仍然抛最初的写失败', async () => {
    const { GatewayClient } = await import('../src/main/ws/gateway-client.js');
    const client = new GatewayClient({
      id: 'gw-1',
      name: 'Gateway',
      url: 'ws://127.0.0.1:18789',
      auth: { token: 'token' },
    });
    clients.push(client);

    const unsafe = Object.assign(new Error('unsafe workspace file "IDENTITY.md"'), { code: 'INVALID_REQUEST' });
    const verifyError = Object.assign(new Error('not connected'), { code: 'GATEWAY_NOT_CONNECTED' });
    const sendReq = vi.spyOn(client, 'sendReq').mockRejectedValueOnce(unsafe).mockRejectedValueOnce(verifyError);

    await expect(client.setAgentFile('writer', 'IDENTITY.md', '# 身份\n')).rejects.toBe(unsafe);
    expect(sendReq).toHaveBeenCalledTimes(2);
  });

  it('错误码不精确匹配时，即使文案一样也不读回', async () => {
    const { GatewayClient } = await import('../src/main/ws/gateway-client.js');
    const client = new GatewayClient({
      id: 'gw-1',
      name: 'Gateway',
      url: 'ws://127.0.0.1:18789',
      auth: { token: 'token' },
    });
    clients.push(client);

    const unsafe = Object.assign(new Error('unsafe workspace file "IDENTITY.md"'), { code: 'CONFLICT' });
    const sendReq = vi.spyOn(client, 'sendReq').mockRejectedValueOnce(unsafe);

    await expect(client.setAgentFile('writer', 'IDENTITY.md', '# 身份\n')).rejects.toBe(unsafe);
    expect(sendReq).toHaveBeenCalledTimes(1);
  });

  it('正常写成功时原样返回，不多做一次读回', async () => {
    const { GatewayClient } = await import('../src/main/ws/gateway-client.js');
    const client = new GatewayClient({
      id: 'gw-1',
      name: 'Gateway',
      url: 'ws://127.0.0.1:18789',
      auth: { token: 'token' },
    });
    clients.push(client);

    const response = { ok: true, agentId: 'writer', file: { name: 'SOUL.md', content: '内容' } };
    const sendReq = vi.spyOn(client, 'sendReq').mockResolvedValueOnce(response);

    await expect(client.setAgentFile('writer', 'SOUL.md', '内容')).resolves.toBe(response);
    expect(sendReq).toHaveBeenCalledTimes(1);
  });

  it('⭐ exFAT agents.update 写后误报时，校验文件并用最新 hash 补写、回读配置', async () => {
    const { GatewayClient } = await import('../src/main/ws/gateway-client.js');
    const client = new GatewayClient({
      id: 'gw-1',
      name: 'Gateway',
      url: 'ws://127.0.0.1:18789',
      auth: { token: 'token' },
    });
    clients.push(client);

    const unsafe = Object.assign(new Error('unsafe workspace file "IDENTITY.md"'), { code: 'INVALID_REQUEST' });
    const conflict = Object.assign(new Error('config changed since last load; re-run config.get and retry'), {
      code: 'INVALID_REQUEST',
    });
    let configReads = 0;
    let patchWrites = 0;
    const sendReq = vi.spyOn(client, 'sendReq').mockImplementation(async (method) => {
      if (method === 'agents.update') throw unsafe;
      if (method === 'agents.files.get') {
        return {
          agentId: 'rongying-content',
          file: { name: 'IDENTITY.md', missing: false, content: '# IDENTITY.md\n\n- Name: 内容创作\n' },
        };
      }
      if (method === 'config.get') {
        configReads += 1;
        if (configReads === 1) {
          return {
            hash: 'stale',
            config: { agents: { entries: { 'rongying-content': { name: 'rongying-content' } } } },
          };
        }
        if (configReads === 2) {
          return {
            hash: 'fresh',
            config: { agents: { entries: { 'rongying-content': { name: 'rongying-content' } } } },
          };
        }
        return {
          hash: 'applied',
          config: {
            agents: {
              entries: { 'rongying-content': { name: '内容创作', identity: { name: '内容创作' } } },
            },
          },
        };
      }
      if (method === 'config.patch') {
        patchWrites += 1;
        if (patchWrites === 1) throw conflict;
        return { ok: true };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await expect(client.updateAgent({ agentId: 'rongying-content', name: '内容创作' })).resolves.toMatchObject({
      ok: true,
      agentId: 'rongying-content',
    });

    const patchCalls = sendReq.mock.calls.filter(([method]) => method === 'config.patch');
    expect(patchCalls).toHaveLength(2);
    expect(patchCalls[0]?.[1]).toMatchObject({ baseHash: 'stale' });
    expect(patchCalls[1]?.[1]).toMatchObject({ baseHash: 'fresh' });
    expect(JSON.parse(String((patchCalls[1]?.[1] as { raw?: unknown }).raw))).toEqual({
      agents: {
        entries: {
          'rongying-content': { name: '内容创作', identity: { name: '内容创作' } },
        },
      },
    });
    expect(configReads).toBe(3);
  });

  it('agents.update unsafe 后 IDENTITY 名称读回不匹配时保留原错，不补写配置', async () => {
    const { GatewayClient } = await import('../src/main/ws/gateway-client.js');
    const client = new GatewayClient({
      id: 'gw-1',
      name: 'Gateway',
      url: 'ws://127.0.0.1:18789',
      auth: { token: 'token' },
    });
    clients.push(client);

    const unsafe = Object.assign(new Error('unsafe workspace file "IDENTITY.md"'), { code: 'INVALID_REQUEST' });
    const sendReq = vi
      .spyOn(client, 'sendReq')
      .mockRejectedValueOnce(unsafe)
      .mockResolvedValueOnce({
        agentId: 'rongying-content',
        file: { name: 'IDENTITY.md', missing: false, content: '# IDENTITY.md\n\n- Name: 另一个名字\n' },
      });

    await expect(client.updateAgent({ agentId: 'rongying-content', name: '内容创作' })).rejects.toBe(unsafe);
    expect(sendReq).toHaveBeenCalledTimes(2);
  });

  it('agents.update 同时改 workspace 时即使报 unsafe 也不走窄补丁', async () => {
    const { GatewayClient } = await import('../src/main/ws/gateway-client.js');
    const client = new GatewayClient({
      id: 'gw-1',
      name: 'Gateway',
      url: 'ws://127.0.0.1:18789',
      auth: { token: 'token' },
    });
    clients.push(client);

    const unsafe = Object.assign(new Error('unsafe workspace file "IDENTITY.md"'), { code: 'INVALID_REQUEST' });
    const sendReq = vi.spyOn(client, 'sendReq').mockRejectedValueOnce(unsafe);

    await expect(
      client.updateAgent({ agentId: 'rongying-content', name: '内容创作', workspace: 'E:/other' }),
    ).rejects.toBe(unsafe);
    expect(sendReq).toHaveBeenCalledTimes(1);
  });

  it('agents.update 正常成功时原样返回，不读文件也不碰配置', async () => {
    const { GatewayClient } = await import('../src/main/ws/gateway-client.js');
    const client = new GatewayClient({
      id: 'gw-1',
      name: 'Gateway',
      url: 'ws://127.0.0.1:18789',
      auth: { token: 'token' },
    });
    clients.push(client);

    const response = { ok: true, agentId: 'rongying-content' };
    const sendReq = vi.spyOn(client, 'sendReq').mockResolvedValueOnce(response);

    await expect(client.updateAgent({ agentId: 'rongying-content', name: '内容创作' })).resolves.toBe(response);
    expect(sendReq).toHaveBeenCalledOnce();
  });

  it('agents.update 的补丁若被 schema 拒绝必须向上抛，不能把半成品报成功', async () => {
    const { GatewayClient } = await import('../src/main/ws/gateway-client.js');
    const client = new GatewayClient({
      id: 'gw-1',
      name: 'Gateway',
      url: 'ws://127.0.0.1:18789',
      auth: { token: 'token' },
    });
    clients.push(client);

    const unsafe = Object.assign(new Error('unsafe workspace file "IDENTITY.md"'), { code: 'INVALID_REQUEST' });
    const rejected = Object.assign(new Error('invalid config: agents.entries'), { code: 'INVALID_REQUEST' });
    const sendReq = vi
      .spyOn(client, 'sendReq')
      .mockRejectedValueOnce(unsafe)
      .mockResolvedValueOnce({
        agentId: 'rongying-content',
        file: { name: 'IDENTITY.md', missing: false, content: '# IDENTITY.md\n\n- Name: 内容创作\n' },
      })
      .mockResolvedValueOnce({
        hash: 'fresh',
        config: { agents: { entries: { 'rongying-content': { name: 'rongying-content' } } } },
      })
      .mockRejectedValueOnce(rejected);

    await expect(client.updateAgent({ agentId: 'rongying-content', name: '内容创作' })).rejects.toBe(rejected);
    expect(sendReq).toHaveBeenCalledTimes(4);
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

  /**
   * ⭐ "被拒绝"要说得出是**哪一类**拒绝：光有 `gaveUp` 只能让界面说"连不上"，
   *    说不出"是网关不认我们" —— 而这两句话让用户做的事完全不同。
   *
   * ⚠️ 判据是**闭集里的值**（`GatewayFailureReason`），不是那句错误原文：
   *    `error` 里有网关给的原话，它要留在日志里，不许上界面。
   */
  it('⭐ 网关明确拒绝 ⇒ 状态里带上"哪一类拒绝"（闭集值，不是错误原文）', async () => {
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
    expect(lastStatus()['reason']).toBe('auth-rejected');
    // 原文照旧只留在 error 里（它进日志，不进"原因"那个字段）
    expect(lastStatus()['reason']).not.toContain('auth denied');
  });

  it('对照：普通断线**不**给原因（还没有结论，不许猜）', async () => {
    const client = await makeClient();
    const { socket } = connectAndChallenge(client);

    socket.close(1006, 'abnormal');
    await vi.advanceTimersByTimeAsync(0);

    expect(lastStatus()['gaveUp']).not.toBe(true);
    expect(lastStatus()['reason']).toBeUndefined();
  });
});

/**
 * 2026-09-20 的**第三个**缺口（T-a30）：网关**连上了**，却连 `connect.challenge` 都不发。
 *
 * 代码事实（改之前）：`ws.on('open')` 只记一条日志 `Waiting for connect challenge`，
 * **没有任何计时器**；那条 15 秒请求超时只有**收到 challenge、发出 `connect` 之后**才开始跑
 * ⇒ 网关事件循环卡死时（T-a8 那种：端口在听、TCP 能连、RPC 全超时），客户端会**静默挂**
 * 在这一段：界面状态一直是 `undefined` ⇒ **连横幅都不会出现**，用户只看到"看起来在准备、
 * 就是不动"，比"正在尝试重连"更没法判断。
 *
 * 另一条同族理由：`ws.close()` 在对端没反应时要等 **close 握手超时（默认 30 秒）**才触发
 * `close` 事件 ⇒ 光靠 `close` 处理器报状态，界面还要再白等半分钟 ⇒ 状态必须**自己先报**。
 */
describe('网关连上了却不发 challenge：必须有人喊一声（不是静默挂住）', () => {
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

  function openSocket(client: { connect: () => void }, opts: { closeEmits?: boolean } = {}) {
    client.connect();
    const socket = websocketMock.instances.at(-1);
    if (!socket) throw new Error('expected a websocket instance');
    if (opts.closeEmits !== false) {
      socket.close.mockImplementation((...args: unknown[]) => {
        socket.readyState = 3;
        socket.emit('close', (args[0] as number | undefined) ?? 1005, Buffer.from(''));
      });
    }
    socket.readyState = 1;
    socket.emit('open');
    return socket;
  }

  function lastStatus(): Record<string, unknown> {
    const call = vi.mocked(sendToWindow).mock.calls.at(-1);
    if (!call) throw new Error('没有给界面发过 gateway-status');
    expect(call[1]).toBe('gateway-status');
    return call[2] as Record<string, unknown>;
  }

  it('网关一个字都不回：15 秒后要如实报出来，而且必须能再连一次（不许静默挂住）', async () => {
    const client = await makeClient();
    const socket = openSocket(client);

    await vi.advanceTimersByTimeAsync(14_999);
    expect(vi.mocked(sendToWindow)).not.toHaveBeenCalled(); // 沉默期是设计的一部分
    expect(websocketMock.instances.length).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    const status = lastStatus();
    expect(status['connected']).toBe(false);
    expect(String(status['error'])).toContain('challenge'); // 如实说清"在等什么"
    expect(status['gaveUp']).not.toBe(true); // 这**不是**"服务端拒绝"
    expect(socket.close).toHaveBeenCalled(); // 关掉它，交给普通断线路径

    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS);
    expect(websocketMock.instances.length).toBe(2); // ⭐ 真的又连了一次
  });

  it('对端卡死时连 close 都迟迟不回来：状态必须自己先报出去（不许干等 close 事件）', async () => {
    const client = await makeClient();
    // 这个 socket 的 close() **不**触发 close 事件 —— 对端没反应时就是这种形态
    openSocket(client, { closeEmits: false });

    await vi.advanceTimersByTimeAsync(15_000);

    const status = lastStatus();
    expect(status['connected']).toBe(false);
    expect(String(status['error'])).toContain('challenge');
    expect(websocketMock.instances.length).toBe(1); // close 事件没回来 ⇒ 还没轮到重连
  });

  it('challenge 一到手，等待计时器就要被取消（15 秒该报的是“请求超时”，不是“没收到 challenge”）', async () => {
    const client = await makeClient();
    const socket = openSocket(client);

    socket.emit('message', JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n1' } }));
    await vi.advanceTimersByTimeAsync(15_000);

    const status = lastStatus();
    expect(String(status['error'])).toContain('request timeout'); // 是那条 15 秒请求超时在报
    expect(String(status['error'])).not.toContain('challenge'); // 不许是"没收到 challenge"
  });

  it('destroy() 之后等待计时器不许再开火（不留悬空定时器）', async () => {
    const client = await makeClient();
    openSocket(client);
    client.destroy();

    await vi.advanceTimersByTimeAsync(60_000);

    expect(vi.mocked(sendToWindow)).not.toHaveBeenCalled();
    expect(websocketMock.instances.length).toBe(1);
  });
});

/**
 * 审批专用连接 —— exec 审批**永远送不到用户面前**的根因与修法。
 *
 * ## 现场（2026-09-27，用户真机的 `operator_approvals` 表）
 *
 * 助手写好 `数学第一课·认识数字1-5.html`，想在本机起个服务给用户看，
 * 于是跑 `node -e "...createServer(...).listen(8080)"`。审批记录是：
 * 创建 → **17 毫秒后** `status=denied`、`terminal_reason="no-route"`、
 * `resolver_id="no-approval-route"`。用户**根本来不及看见任何弹窗**。
 * 同一天三次，全都是这个死法；用户读成「工具调用失败」。
 *
 * ## 判死条件（运行时源码，不是推断）
 *
 * ```js
 * // approval-shared-*.mjs
 * const hasApprovalClients = params.context.hasExecApprovalClients?.(params.clientConnId) ?? false;
 * if (... && !hasApprovalClients && !hasTurnSourceRoute && !delivered)
 *   manager.expire(record.id, "no-approval-route");
 *
 * // server-request-context-*.mjs —— ★ 请求者自己被跳过
 * hasExecApprovalClients: (excludeConnId) => {
 *   for (const gatewayClient of clients) {
 *     if (excludeConnId && gatewayClient.connId === excludeConnId) continue;
 *     if (canDeliverApprovals(gatewayClient, "exec")) return true;
 *   }
 *
 * // server-request-context-*.mjs —— 四选一，我们一条都不满足
 * function canDeliverApprovals(gatewayClient, approvalKind) {
 *   if (!(scopes.includes("operator.admin") || scopes.includes("operator.approvals"))) return false;
 *   return internal?.approvalRuntime === true
 *       || client.id ∈ {CONTROL_UI}
 *       || caps ∋ APPROVALS
 *       || approvalKind === "exec" && (client.id ∈ EXEC_APPROVAL_CLIENT_IDS || caps ∋ EXEC_APPROVALS);
 * }
 * ```
 *
 * 我们发的是 `client.id = 'gateway-client'`、`caps = ['tool-events']`
 * ⇒ scope 那条**满足**（`operator.approvals` 早就在 scopes 里），**后面四选一全不满足**。
 *
 * ## ⭐ 为什么必须是**第二条**连接，而不是给主连接加个 cap
 *
 * `excludeConnId` 把**发起请求的那条连接**跳过了（网关刻意不问"提问者本人"）。
 * 所以主连接即使补上 `exec-approvals` 也永远查不到自己 —— 网关侧每条 WS 连接是
 * 独立的 client 条目，**多开一条**才落在 `excludeConnId` 之外。
 *
 * ## ⚠️ 两个字段别搞混（我第一版就在这里读错了）
 *
 * | 字段 | 谁在用 | 含义 |
 * | --- | --- | --- |
 * | **`connId`** | `hasExecApprovalClients(excludeConnId)` 的排除 | **每条 WS 连接独有** |
 * | `client.id` | `canDeliverApprovals` 的四选一 | 客户端自报的身份 |
 *
 * ⇒ 第二条连接**保持同一个 `client.id`** 就够了（connId 天然不同），
 *   **不该**为了"看起来不同"去换 id：配对记录里存着 `device.clientId`
 *   （`device-pairing-tokens-*.mjs` 的 `isBrowserRelatedPairedDevice` 就拿它判），
 *   换掉有配对失配的风险，而收益是零。
 *
 * 网关也不会踢掉第二条：`server-ws-runtime-*.mjs` 里唯一的"踢旧"是
 * `existing.worker?.environmentId === next.worker.environmentId` —— 只针对
 * **worker** 连接，operator 连接不去重。
 *
 * ## 这条连接刻意**不做**什么
 *
 * 它只为"能被推审批"而存在，所以不发 `sessions.subscribe`（否则每条会话事件翻倍）、
 * 不发 `gateway-status`（否则会跟主连接抢界面上的连接状态）。
 * 它照样走完整握手、心跳与重连。
 */
describe('审批专用连接：exec 审批要真能送到用户面前', () => {
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

  type Socket = (typeof websocketMock.instances)[number];

  function sentMethods(socket: Socket): string[] {
    return socket.send.mock.calls.map((call) => (JSON.parse(String(call[0])) as { method: string }).method);
  }

  function sentFrame(socket: Socket, method: string): { id: string; params?: Record<string, unknown> } {
    const frames = socket.send.mock.calls.map(
      (call) => JSON.parse(String(call[0])) as { id: string; method: string; params?: Record<string, unknown> },
    );
    const frame = frames.find((item) => item.method === method);
    if (!frame) throw new Error(`没有发出 ${method} 帧：${JSON.stringify(frames.map((f) => f.method))}`);
    return frame;
  }

  /** 走到 `connect` 已发出为止（不算握手完成）。 */
  async function reachConnect(opts?: { approvalChannel?: boolean }) {
    const { GatewayClient } = await import('../src/main/ws/gateway-client.js');
    const client = new GatewayClient(
      { id: 'gw-1', name: 'Gateway', url: 'ws://127.0.0.1:18789', auth: { token: 'token' } },
      opts,
    );
    clients.push(client);
    client.connect();
    const socket = websocketMock.instances.at(-1);
    if (!socket) throw new Error('expected a websocket instance');
    socket.readyState = 1;
    socket.emit('message', JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n1' } }));
    const connect = sentFrame(socket, 'connect');
    return { socket, connect, params: connect.params as Record<string, unknown> };
  }

  /** 走到握手**真的完成**（收到 hello-ok），否则"没发 gateway-status"是假绿。 */
  async function finishHandshake(opts?: { approvalChannel?: boolean }) {
    const reached = await reachConnect(opts);
    reached.socket.emit(
      'message',
      JSON.stringify({
        type: 'res',
        id: reached.connect.id,
        ok: true,
        payload: { type: 'hello-ok', server: { version: '2026.9.3' } },
      }),
    );
    await vi.advanceTimersByTimeAsync(0); // 让 connect 的 .then 链跑完
    return reached;
  }

  it('caps **恰好**是 [exec-approvals] —— 四选一里唯一我们拿得到的那条', async () => {
    const { params } = await reachConnect({ approvalChannel: true });
    // ⭐ 断言"恰好"而不是"包含"：通用 `approvals` cap 会让 plugin./openclaw. 两个
    //    **没接线**的审批家族也变成可投递（收到只会被丢掉）。谁顺手加上它，这条要红。
    expect(params['caps']).toEqual(['exec-approvals']);
  });

  it('operator.approvals 这个 scope 也得在（canDeliverApprovals 的第一道门）', async () => {
    const { params } = await reachConnect({ approvalChannel: true });
    expect(params['scopes']).toContain('operator.approvals');
  });

  it('⭐ client.id 与主连接**相同** —— 换了 id 有配对失配风险，而收益是零', async () => {
    const primary = await reachConnect();
    const companion = await reachConnect({ approvalChannel: true });
    const primaryId = (primary.params['client'] as Record<string, unknown>)['id'];
    const companionId = (companion.params['client'] as Record<string, unknown>)['id'];
    expect(primaryId, '主连接不许被顺手改掉').toBe('gateway-client');
    // 排除是**按 connId**（网关逐条分配）不是按 client.id ⇒ 不需要、也不该换 id。
    // ⚠️ "真的不被 excludeConnId 排除"是**服务端行为，单测观测不到** ——
    //    这条只钉住"我们没去换 id"这个决定；端到端要真机验。
    expect(companionId).toBe(primaryId);
  });

  it('⭐ 不发 sessions.subscribe —— 否则每条会话事件都翻倍', async () => {
    const { socket } = await finishHandshake({ approvalChannel: true });
    expect(sentMethods(socket)).not.toContain('sessions.subscribe');
  });

  it('⭐ 不发 gateway-status —— 否则会跟主连接抢界面上的连接状态', async () => {
    // ⚠️ 这条必须驱动到 hello-ok 才有意义：没完成握手时"没发状态"是**必然**的，
    //    断言它会得到一条永远不会红的假绿（本项目栽过）。
    const { socket } = await finishHandshake({ approvalChannel: true });
    expect(sentMethods(socket)).toContain('connect'); // 前提：握手真的发了
    const statuses = vi
      .mocked(sendToWindow)
      .mock.calls.filter((call) => call[1] === 'gateway-status')
      .map((call) => call[2] as Record<string, unknown>);
    expect(statuses).toHaveLength(0);
  });

  it('对照组：**主连接**照常发 sessions.subscribe 与 gateway-status（证明上面两条不是恒真）', async () => {
    const { socket } = await finishHandshake();
    expect(sentMethods(socket)).toContain('sessions.subscribe');
    const statuses = vi.mocked(sendToWindow).mock.calls.filter((call) => call[1] === 'gateway-status');
    expect(statuses.length, '主连接完成握手后必须报一次状态').toBeGreaterThan(0);
  });

  function emitEvent(socket: Socket, event: string, payload: Record<string, unknown> = {}): void {
    socket.emit('message', JSON.stringify({ type: 'event', event, payload }));
  }

  /** 转发给渲染器的 `gateway-event` 事件名（按发出顺序）。 */
  function forwardedEvents(): string[] {
    return vi
      .mocked(sendToWindow)
      .mock.calls.filter((call) => call[1] === 'gateway-event')
      .map((call) => (call[2] as Record<string, unknown>)['event'] as string);
  }

  it('⭐ 转发 `exec.approval.*` —— 这是它存在的**唯一**理由', async () => {
    const { socket } = await reachConnect({ approvalChannel: true });
    emitEvent(socket, 'exec.approval.requested', { id: 'a1' });
    emitEvent(socket, 'exec.approval.resolved', { id: 'a1' });
    expect(forwardedEvents()).toEqual(['exec.approval.requested', 'exec.approval.resolved']);
  });

  it('⭐ 广播事件**不**转发 —— 主连接也在收，转发等于渲染器把每条处理两遍', async () => {
    const { socket } = await reachConnect({ approvalChannel: true });
    emitEvent(socket, 'health', {});
    emitEvent(socket, 'presence', {});
    emitEvent(socket, 'node.changed', {});
    expect(forwardedEvents()).toHaveLength(0);
  });

  it('对照组：**主连接**照常转发广播事件（证明上面那条不是恒真）', async () => {
    const { socket } = await reachConnect();
    emitEvent(socket, 'health', {});
    expect(forwardedEvents()).toContain('health');
  });

  it('requests the effective tool inventory for the exact session', async () => {
    const { GatewayClient } = await import('../src/main/ws/gateway-client.js');
    const client = new GatewayClient({
      id: 'gw-1',
      name: 'Gateway',
      url: 'ws://127.0.0.1:18789',
      auth: { token: 'token' },
    });
    clients.push(client);
    const sendReq = vi.spyOn(client, 'sendReq').mockResolvedValue({ groups: [] });
    const method = (
      client as unknown as {
        getEffectiveTools: (sessionKey: string, agentId?: string) => Promise<Record<string, unknown>>;
      }
    ).getEffectiveTools;

    expect(typeof method).toBe('function');
    await method.call(client, 'agent:main:clawwork:task:task-1', 'main');

    expect(sendReq).toHaveBeenCalledWith('tools.effective', {
      sessionKey: 'agent:main:clawwork:task:task-1',
      agentId: 'main',
    });
  });
});
