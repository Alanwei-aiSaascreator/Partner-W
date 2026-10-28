import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ⭐ B1（2026-10-11 整改）主进程「一轮在跑」软状态的**归属与释放**。
 *
 * 真源复审（CHANGES_REQUIRED）：软状态不绑连接/网关，网关被**永久移除**（或重连
 * 耗尽彻底失败）后 `hasLiveTurnSessions()` 永远为 true ⇒ 升级被永久判忙；但反过来
 * 在**短暂断连**时直接全局清空又会误放行真实仍在跑的轮次。
 *
 * 这里用**真实类**驱动：
 *  - 真实 `GatewayClient`（ws 是内存替身）发真实 lifecycle 帧 → 真实 `turn-lifecycle` 模块；
 *  - 真实 `data-handlers` 的 run 队列（releaseHandler / 单飞门）串起来。
 *
 * 四条语义（与复审回归表一一对应）：
 *  ① 永久 destroy/remove ⇒ 只释放**这个网关**的记录，无实际交付后可升级；
 *  ② 短断（socket close，不 destroy）⇒ 软状态保留，不许误放行；
 *  ③ 重连成功 ⇒ 与真实 run 状态核对：已终结的落地、仍在跑的保留；
 *  ④ turn 软状态释放 ≠ 单飞门放行：run 未 claim/取消前 `isArtifactTurnInFlight` 仍为真。
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
  app: { getVersion: () => '0.0.0-test', getPath: () => '/tmp/clawwork-test-userdata' },
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}));

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

const S1 = 'agent:main:clawwork:task-owner-1';
const S2 = 'agent:main:clawwork:task-owner-2';

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

function lifecycle(socket: Socket, sessionKey: string, phase: 'start' | 'end' | 'error'): void {
  socket.emit(
    'message',
    JSON.stringify({ type: 'event', event: 'agent', payload: { sessionKey, stream: 'lifecycle', data: { phase } } }),
  );
}

/** 这个 socket 上发出的第一条 `method` 请求帧（找不到即用例失败）。 */
function frameOf(socket: Socket, method: string): { id: string; method: string } {
  const frames = socket.send.mock.calls.map((call) => JSON.parse(String(call[0])) as { id: string; method: string });
  const found = frames.find((frame) => frame.method === method);
  if (!found) throw new Error(`没有发出 ${method} 帧`);
  return found;
}

function resolveFrame(socket: Socket, id: string, payload: unknown): void {
  socket.emit('message', JSON.stringify({ type: 'res', id, ok: true, payload }));
}

function rejectFrame(socket: Socket, id: string, message = 'abort failed'): void {
  socket.emit('message', JSON.stringify({ type: 'res', id, ok: false, error: { message } }));
}

async function makeClient(id: string, options?: { approvalChannel?: boolean }) {
  const { GatewayClient } = await import('../src/main/ws/gateway-client.js');
  return new GatewayClient({ id, name: id, url: `ws://127.0.0.1:18789`, auth: { token: 't' } }, options);
}

describe('B1：轮次软状态绑定网关 —— 永久移除释放、短断保留、重连核对', () => {
  const clients: Array<{ destroy: () => void }> = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    websocketMock.constructor.mockClear();
    websocketMock.instances.length = 0;
  });

  afterEach(async () => {
    for (const client of clients) client.destroy();
    clients.length = 0;
    const { resetTurnLifecycleForTests } = await import('../src/main/artifact/turn-lifecycle.js');
    resetTurnLifecycleForTests();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('① 永久 destroy/remove：只释放这个网关的记录；另一个网关仍在跑的不许被清', async () => {
    const gw1 = await makeClient('gw-1');
    const gw2 = await makeClient('gw-2');
    clients.push(gw1, gw2);
    const socket1 = await helloOk(gw1);
    const socket2 = await helloOk(gw2);
    const { isLiveTurnSession, hasLiveTurnSessions } = await import('../src/main/artifact/turn-lifecycle.js');

    lifecycle(socket1, S1, 'start');
    lifecycle(socket2, S2, 'start');
    expect(isLiveTurnSession(S1)).toBe(true);
    expect(isLiveTurnSession(S2)).toBe(true);

    // 短断（socket close，不 destroy）：软状态两边都保留 —— 真实轮次可能还在跑。
    socket1.emit('close', 1006, Buffer.from('down'));
    expect(isLiveTurnSession(S1), '短暂断连不许直接清空').toBe(true);

    // 永久移除 gw-1 ⇒ 只释放 gw-1 自己的记录。
    gw1.destroy();
    expect(isLiveTurnSession(S1), '被移除的网关：它的记录必须释放').toBe(false);
    expect(isLiveTurnSession(S2), '另一个网关的记录不许被顺手动').toBe(true);
    expect(hasLiveTurnSessions(), '还有 gw-2 在跑 ⇒ 整体仍忙').toBe(true);

    gw2.destroy();
    expect(hasLiveTurnSessions(), '全部释放后不再判忙（无实际交付时即可升级）').toBe(false);
  });

  it('② 重连耗尽（gaveUp）也是失败终结：释放该网关的记录，不给"永久判忙"留后门', async () => {
    const { MAX_RECONNECT_ATTEMPTS } = await import('@clawwork/shared');
    const gw = await makeClient('gw-1');
    clients.push(gw);
    const socket = await helloOk(gw);
    const { isLiveTurnSession } = await import('../src/main/artifact/turn-lifecycle.js');

    lifecycle(socket, S1, 'start');
    expect(isLiveTurnSession(S1)).toBe(true);

    // 反复断线直到重连次数耗尽（真实 scheduleReconnect 的 gaveUp 出口）。
    for (let attempt = 0; attempt < MAX_RECONNECT_ATTEMPTS + 1; attempt += 1) {
      const current = websocketMock.instances.at(-1)!;
      current.emit('close', 1006, Buffer.from('down'));
      await vi.advanceTimersByTimeAsync(10 * 60_000);
    }

    expect(isLiveTurnSession(S1), '重连彻底失败 = 失败终结，软状态必须落地').toBe(false);
  });

  it('③ 重连成功后与真实 run 状态核对：已终结的落地、仍在跑的保留；未知一律保守保留', async () => {
    const gw = await makeClient('gw-1');
    clients.push(gw);
    const first = await helloOk(gw);
    const { isLiveTurnSession } = await import('../src/main/artifact/turn-lifecycle.js');
    const { registerTurnRunStateProbe, resetTurnLifecycleForTests } =
      await import('../src/main/artifact/turn-lifecycle.js');
    resetTurnLifecycleForTests();

    lifecycle(first, S1, 'start'); // run 已终结（终态丢失，事件在断连里丢了）
    lifecycle(first, S2, 'start'); // 真实仍在跑

    // 断连 → 重连。真实 run 状态由 data-handlers 注册的探针回答（这里直接驱动同一注册面）。
    const probe = vi.fn((sessionKey: string): 'running' | 'ended' => (sessionKey === S2 ? 'running' : 'ended'));
    registerTurnRunStateProbe(probe);
    first.emit('close', 1006, Buffer.from('down'));
    expect(isLiveTurnSession(S1), '断连本身不许释放').toBe(true);

    await helloOk(gw);
    expect(isLiveTurnSession(S1), '重连核对：已终结的轮次软状态落地').toBe(false);
    expect(isLiveTurnSession(S2), '重连核对：真实仍在跑的必须保留').toBe(true);
    expect(probe).toHaveBeenCalledWith(S1, expect.any(Number));

    // 探针回答"未知"（没有 run 记录可判定）⇒ 保守保留，绝不猜着清。
    lifecycle(websocketMock.instances.at(-1)!, S1, 'start');
    registerTurnRunStateProbe(() => 'unknown');
    const current = websocketMock.instances.at(-1)!;
    current.emit('close', 1006, Buffer.from('down'));
    await vi.advanceTimersByTimeAsync(60_000);
    await helloOk(gw);
    expect(isLiveTurnSession(S1), '未知 ⇒ 保守保留（宁可等真实 end 事件）').toBe(true);
  });

  it('④ 软状态释放 ≠ 单飞门放行：run 未 claim/取消前，普通发送仍被拦', async () => {
    const { beginArtifactRun, isArtifactTurnInFlight } = await import('../src/main/ipc/data-handlers.js');
    const { noteGatewayTurnLifecycle, releaseGatewayTurnSessions, hasLiveTurnSessions } =
      await import('../src/main/artifact/turn-lifecycle.js');
    beginArtifactRun('C:\\workspace', 'task-owner-1', S1);
    noteGatewayTurnLifecycle('start', S1, 'gw-1');
    expect(isArtifactTurnInFlight('task-owner-1', S1)).toBe(true);

    releaseGatewayTurnSessions('gw-1', 'destroyed');
    expect(hasLiveTurnSessions()).toBe(false);
    expect(
      isArtifactTurnInFlight('task-owner-1', S1),
      '软状态释放不能提前放行写盘/登记：未 claim 的 run 仍把门关着',
    ).toBe(true);
  });

  it('⑤ 真实 run 队列探针（data-handlers 注册）：在跑保留、已取消落地、无记录保守保留', async () => {
    // 真实 data-handlers（导入即注册真探针 + 真释放句柄）——探测的是真实 run 队列。
    const { beginArtifactRun, cancelArtifactRun } = await import('../src/main/ipc/data-handlers.js');
    const { noteGatewayTurnLifecycle, reconcileGatewayTurnSessions, isLiveTurnSession } =
      await import('../src/main/artifact/turn-lifecycle.js');

    // 真实在跑：run 未取消 ⇒ 重连核对必须保留。
    const token = beginArtifactRun('C:\\workspace', 'task-owner-1', S1);
    noteGatewayTurnLifecycle('start', S1, 'gw-1');
    reconcileGatewayTurnSessions('gw-1');
    expect(isLiveTurnSession(S1), 'run 还在跑：不许被核对清掉').toBe(true);

    // 这一轮被停止（run 被取消 = 真实终态）⇒ 软状态是陈旧的，核对落地。
    cancelArtifactRun('task-owner-1', S1, token);
    reconcileGatewayTurnSessions('gw-1');
    expect(isLiveTurnSession(S1), '这一轮已被停止（run 取消）：软状态落地').toBe(false);

    // 没有任何可判定的记录 ⇒ 保守保留，绝不猜着清。
    noteGatewayTurnLifecycle('start', S2, 'gw-1');
    reconcileGatewayTurnSessions('gw-1');
    expect(isLiveTurnSession(S2), 'unknown ⇒ 保守保留').toBe(true);
  });

  it('⑤b run 自己的 15 分钟 TTL 到点：软状态一并落地；有更新在途工作时不动', async () => {
    const { beginArtifactRun } = await import('../src/main/ipc/data-handlers.js');
    const { noteGatewayTurnLifecycle, hasLiveTurnSessions, isLiveTurnSession } =
      await import('../src/main/artifact/turn-lifecycle.js');

    beginArtifactRun('C:\\workspace', 'task-owner-1', S1);
    noteGatewayTurnLifecycle('start', S1, 'gw-1');
    expect(hasLiveTurnSessions()).toBe(true);

    await vi.advanceTimersByTimeAsync(15 * 60_000 + 1_000);
    expect(isLiveTurnSession(S1), 'TTL 到点 = 真实的有界兜底事件：软状态落地').toBe(false);

    // 该会话还有**更新的**未取消 run ⇒ 旧 run 的 TTL 收尾不许把软状态误清。
    beginArtifactRun('C:\\workspace', 'task-owner-2', S2);
    noteGatewayTurnLifecycle('start', S2, 'gw-1');
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    beginArtifactRun('C:\\workspace', 'task-owner-2', S2); // 更新的 run
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1_000); // 旧 run 的 TTL 到点
    expect(isLiveTurnSession(S2), '还有更新的在途 run：软状态不许被旧收尾误清').toBe(true);

    // 更新的那个也到点：全离线（无终态、无交付）⇒ 软状态落地，不再永久判忙。
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1_000);
    expect(isLiveTurnSession(S2), '所有在途工作到点收尾：软状态落地（有界兜底）').toBe(false);
  });

  // ───────────── B1 复审二轮（2026-10-11）：审批副连接归属 + 停止后的可确认恢复 ─────────────

  it('⑥ 审批副连接（同 gatewayId）的 destroy / 重连耗尽不许释放主连接的轮次', async () => {
    const { MAX_RECONNECT_ATTEMPTS } = await import('@clawwork/shared');
    const main = await makeClient('gw-1');
    const approval = await makeClient('gw-1', { approvalChannel: true });
    clients.push(main, approval);
    const mainSocket = await helloOk(main);
    await helloOk(approval);
    const { isLiveTurnSession, hasLiveTurnSessions } = await import('../src/main/artifact/turn-lifecycle.js');

    // 主连接记录一轮；审批连接从**不**记 start（handleEvent 的 !approvalChannel 门）。
    lifecycle(mainSocket, S1, 'start');
    expect(isLiveTurnSession(S1)).toBe(true);

    // 审批副连接永久移除：主会话这一轮可能还在跑 —— 一个字节都不许动。
    approval.destroy();
    expect(isLiveTurnSession(S1), '审批副连接 destroy 不许清掉主连接的轮次').toBe(true);
    expect(hasLiveTurnSessions()).toBe(true);

    // 审批副连接重连耗尽（gave-up）：同样不许动（复审实测的第二条反例）。
    const approval2 = await makeClient('gw-1', { approvalChannel: true });
    clients.push(approval2);
    await helloOk(approval2);
    for (let attempt = 0; attempt < MAX_RECONNECT_ATTEMPTS + 1; attempt += 1) {
      const current = websocketMock.instances.at(-1)!;
      current.emit('close', 1006, Buffer.from('down'));
      await vi.advanceTimersByTimeAsync(10 * 60_000);
    }
    expect(isLiveTurnSession(S1), '审批副连接 gave-up 不许清掉主连接的轮次').toBe(true);

    // 正对照：主连接自己的 destroy 照常释放。
    main.destroy();
    expect(isLiveTurnSession(S1), '主连接 destroy：它的记录必须释放').toBe(false);
  });

  it('⑥b runtime-down 抑制路径同样只归主连接：审批副连接断连不许释放', async () => {
    const { publishRuntimeBootstrapStatus } = await import('../src/main/runtime/bootstrap-status.js');
    const main = await makeClient('local-runtime');
    const approval = await makeClient('local-runtime', { approvalChannel: true });
    clients.push(main, approval);
    const mainSocket = await helloOk(main);
    const approvalSocket = await helloOk(approval);
    const { isLiveTurnSession } = await import('../src/main/artifact/turn-lifecycle.js');

    lifecycle(mainSocket, S1, 'start');
    expect(isLiveTurnSession(S1)).toBe(true);

    // 本机运行时被判定起不来（非 ready-timeout 的失败类）⇒ 自动重连被抑制。
    publishRuntimeBootstrapStatus({ ok: false, code: 'runtime.gateway-process-exited' });

    // 审批副连接断连走进抑制分支：不许顺手释放主连接的轮次。
    approvalSocket.emit('close', 1006, Buffer.from('down'));
    expect(isLiveTurnSession(S1), '审批副连接 runtime-down 抑制不许清主连接').toBe(true);

    // 正对照：主连接自己的断连进抑制分支才释放。
    mainSocket.emit('close', 1006, Buffer.from('down'));
    expect(isLiveTurnSession(S1), '主连接 runtime-down（失败终结）：它的记录必须释放').toBe(false);
  });

  it('⑦ 停止后重连的真实恢复出口：补发 abort 拿到应答 ⇒ 未确认停止落地；应答失败保留', async () => {
    const gw = await makeClient('gw-1');
    clients.push(gw);
    const first = await helloOk(gw);
    const { isLiveTurnSession, hasLiveTurnSessions, noteGatewayTurnStop } =
      await import('../src/main/artifact/turn-lifecycle.js');
    const { beginArtifactRun, bindArtifactRun, cancelArtifactRunsForSession, isArtifactTurnInFlight } =
      await import('../src/main/ipc/data-handlers.js');

    // 正常 bind 的一轮（复审反例的前半段）。
    const token = beginArtifactRun('C:\\workspace', 'task-owner-1', S1);
    bindArtifactRun('task-owner-1', S1, token, 'run-1');
    lifecycle(first, S1, 'start');
    expect(isLiveTurnSession(S1)).toBe(true);

    // 短断（终态事件丢失）→ 用户停止（真实停止入口先本地取消）→ abort 未确认。
    first.emit('close', 1006, Buffer.from('down'));
    cancelArtifactRunsForSession(S1);
    noteGatewayTurnStop(S1, false);
    expect(isLiveTurnSession(S1), '未确认的停止：不许凭本地删除记录宣称远端已停').toBe(true);
    expect(isArtifactTurnInFlight('task-owner-1', S1), '未确认停止期间单飞门照旧关着').toBe(true);

    // 重连成功 ⇒ 真实客户端的恢复出口自动补发 abort；网关先回失败 —— 仍未确认，保留。
    const second = await helloOk(gw);
    rejectFrame(second, frameOf(second, 'chat.abort').id);
    await vi.advanceTimersByTimeAsync(0);
    expect(isLiveTurnSession(S1), 'abort 应答失败：仍未确认，软状态保留').toBe(true);

    // 再次重连：网关答 aborted:false（本来就没有在跑）⇒ 确认 ⇒ 落地，不再永久判忙。
    const current = websocketMock.instances.at(-1)!;
    current.emit('close', 1006, Buffer.from('down'));
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    const third = await helloOk(gw);
    resolveFrame(third, frameOf(third, 'chat.abort').id, { aborted: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(isLiveTurnSession(S1), '网关应答 = 确认的生命周期证据：软状态落地').toBe(false);
    expect(hasLiveTurnSessions()).toBe(false);
    expect(isArtifactTurnInFlight('task-owner-1', S1), '确认终止后（无 claimed 交付）单飞门放行 ⇒ 可继续/可升级').toBe(
      false,
    );
  });

  it('⑦b 确认的停止只落地那一轮：期间已有新轮次 ⇒ 一个字节都不动', async () => {
    const { noteGatewayTurnLifecycle, noteGatewayTurnStop, isLiveTurnSession, hasLiveTurnSessions } =
      await import('../src/main/artifact/turn-lifecycle.js');

    noteGatewayTurnLifecycle('start', S1, 'gw-1');
    const ticketA = noteGatewayTurnStop(S1, false); // 停止 A 轮（未确认）——调用方捕获这次操作的 ticket
    // 用户又发了一条：新一轮开始 ⇒ 旧的未确认停止记录作废。
    await vi.advanceTimersByTimeAsync(1_000);
    noteGatewayTurnLifecycle('start', S1, 'gw-1');
    // 迟到的 abort 应答：携带 A 操作的 ticket —— 确认的是 A 轮，不许误伤 B 轮。
    noteGatewayTurnStop(S1, true, ticketA);
    expect(isLiveTurnSession(S1), '新轮次不许被旧停止的确认误清').toBe(true);
    expect(hasLiveTurnSessions()).toBe(true);

    // 正对照：同一轮次自己捕获的 ticket 确认照常落地。
    const ticketB = noteGatewayTurnStop(S1, false);
    noteGatewayTurnStop(S1, true, ticketB);
    expect(isLiveTurnSession(S1)).toBe(false);
  });

  // ───────────── B1 复审三轮（2026-10-11）：停止回执必须绑定具体操作 ─────────────

  it('⑧ 旧停止的迟到回执不许误清新轮：B 已开始，且 B 的停止也还未确认', async () => {
    const { noteGatewayTurnLifecycle, noteGatewayTurnStop, isLiveTurnSession, hasLiveTurnSessions } =
      await import('../src/main/artifact/turn-lifecycle.js');

    // A 轮：停止已发出（abort 在途），随后 A 的真实终态先到。
    noteGatewayTurnLifecycle('start', S1, 'gw-1');
    const ticketA = noteGatewayTurnStop(S1, false);
    expect(ticketA, '停止入口必须返回这次操作自己的 ticket').toBeDefined();
    noteGatewayTurnLifecycle('end', S1, 'gw-1');

    // B 轮紧接着开始，用户也停止 B（B 的回执尚未返回）。
    await vi.advanceTimersByTimeAsync(1_000);
    noteGatewayTurnLifecycle('start', S1, 'gw-1');
    noteGatewayTurnStop(S1, false);

    // A 迟到的 abort 回执现在返回 —— 它只能结算 ticketA，不许消费 B 的未确认停止。
    noteGatewayTurnStop(S1, true, ticketA);
    expect(isLiveTurnSession(S1), 'A 的迟到回执不许误清 B 的忙态').toBe(true);
    expect(hasLiveTurnSessions()).toBe(true);
  });

  it('⑧b 无 ticket / 非本操作的 ticket：确认一律不许消费', async () => {
    const { noteGatewayTurnLifecycle, noteGatewayTurnStop, isLiveTurnSession } =
      await import('../src/main/artifact/turn-lifecycle.js');

    noteGatewayTurnLifecycle('start', S1, 'gw-1');
    const ticket = noteGatewayTurnStop(S1, false);
    expect(ticket).toBeDefined();

    // 旧调用形态（没有携带操作身份）：无法证明这条回执属于哪次操作 ⇒ 不许放行。
    noteGatewayTurnStop(S1, true);
    expect(isLiveTurnSession(S1), '没有 ticket 的确认不许消费').toBe(true);
    // 身份不符的 ticket（伪造/过期对象）：一个字节都不许动。
    noteGatewayTurnStop(S1, true, { gatewayId: 'gw-1', since: -1 });
    expect(isLiveTurnSession(S1), '身份不符的 ticket 不许消费').toBe(true);

    // 原操作自己的 ticket ⇒ 正常消费。
    noteGatewayTurnStop(S1, true, ticket);
    expect(isLiveTurnSession(S1)).toBe(false);
  });

  it('⑧c 迟到的重连补发回执不许删掉新轮的恢复记录；新轮自己的补发确认照常落地', async () => {
    const { noteGatewayTurnLifecycle, noteGatewayTurnStop, retryPendingGatewayTurnStops, isLiveTurnSession } =
      await import('../src/main/artifact/turn-lifecycle.js');

    // A 轮停止未确认；重连补发在途（应答挂住不返回）。
    noteGatewayTurnLifecycle('start', S1, 'gw-1');
    noteGatewayTurnStop(S1, false);
    let resolveA!: (value: unknown) => void;
    const inFlightA = retryPendingGatewayTurnStops('gw-1', () => new Promise((resolve) => (resolveA = resolve)));

    // 补发在途期间：A 的真实终态到达；B 开始，用户也停止 B（B 的记录等待下一次补发）。
    await vi.advanceTimersByTimeAsync(1_000);
    noteGatewayTurnLifecycle('end', S1, 'gw-1');
    await vi.advanceTimersByTimeAsync(1_000);
    noteGatewayTurnLifecycle('start', S1, 'gw-1');
    noteGatewayTurnStop(S1, false);

    // A 的迟到应答返回：只能结算它自己的那条记录 —— B 的 live 与恢复记录都不许被动。
    resolveA({ aborted: false });
    await inFlightA;
    expect(isLiveTurnSession(S1), 'A 的迟到应答不许清掉 B 的忙态').toBe(true);

    // B 的恢复记录仍保留：下一次补发能拿到它并确认 B。
    let abortCalls = 0;
    await retryPendingGatewayTurnStops('gw-1', async () => {
      abortCalls += 1;
      return { aborted: false };
    });
    expect(abortCalls, 'B 的未确认停止必须保留给下一次补发（不许被旧应答顺手删掉）').toBe(1);
    expect(isLiveTurnSession(S1), 'B 自己的补发确认（真实应答）照常落地').toBe(false);
  });

  it('⑦c 真实 GatewayClient：旧补发的迟到应答不许清掉 B；B 的补发照常确认', async () => {
    const gw = await makeClient('gw-1');
    clients.push(gw);
    const first = await helloOk(gw);
    const { isLiveTurnSession, noteGatewayTurnStop } = await import('../src/main/artifact/turn-lifecycle.js');

    lifecycle(first, S1, 'start'); // A 轮
    first.emit('close', 1006, Buffer.from('down'));
    noteGatewayTurnStop(S1, false); // A 的停止未确认（真实停止入口的交接形态）

    // 重连成功 ⇒ 真实客户端的恢复出口自动补发 chat.abort —— 先挂住（回执在途）。
    const second = await helloOk(gw);
    const lateAbort = frameOf(second, 'chat.abort');

    // 补发在途期间：A 的真实终态到达；B 开始，用户也停止 B（B 的停止也未确认）。
    lifecycle(second, S1, 'end');
    await vi.advanceTimersByTimeAsync(1_000);
    lifecycle(second, S1, 'start'); // B 轮
    noteGatewayTurnStop(S1, false);

    // A 的迟到回执返回：B 的忙态与记录都不许被动。
    resolveFrame(second, lateAbort.id, { aborted: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(isLiveTurnSession(S1), '旧补发的迟到回执不许清掉 B').toBe(true);

    // 下一次重连 ⇒ 真实客户端补发 B 的停止；真实应答 ⇒ B 落地。
    const current = websocketMock.instances.at(-1)!;
    current.emit('close', 1006, Buffer.from('down'));
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    const third = await helloOk(gw);
    resolveFrame(third, frameOf(third, 'chat.abort').id, { aborted: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(isLiveTurnSession(S1), 'B 自己的补发应答 = 确认 ⇒ 落地').toBe(false);
  });
});
