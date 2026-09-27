import { beforeEach, describe, expect, it, vi } from 'vitest';

const clearPairingCodeMock = vi.fn();
const connectMock = vi.fn();
const destroyMock = vi.fn();
const reconnectMock = vi.fn();
const readConfigMock = vi.fn((): unknown => null);

vi.mock('../src/main/workspace/config.js', () => ({
  readConfig: readConfigMock,
  buildGatewayAuth: vi.fn((gateway) => gateway.auth ?? {}),
  clearGatewayPairingCode: clearPairingCodeMock,
}));

vi.mock('../src/main/ws/gateway-client.js', () => ({
  GatewayClient: vi.fn().mockImplementation((_config, opts) => ({
    connect: connectMock,
    destroy: destroyMock,
    reconnect: reconnectMock,
    options: opts,
  })),
}));

describe('gateway index', () => {
  beforeEach(() => {
    vi.resetModules();
    // ⚠️ 必须清 **所有** mock：`GatewayClient` 是模块级构造器 mock，`vi.resetModules()`
    //    只换模块实例、**不清它的 `mock.calls`** ⇒ 上一条测试造出来的连接会残留，
    //    "造了两条"这种计数断言就会读到跨测试的累计值（本项第一版就是这样红的）。
    vi.clearAllMocks();
    clearPairingCodeMock.mockReset();
    connectMock.mockReset();
    destroyMock.mockReset();
    reconnectMock.mockReset();
    readConfigMock.mockReset();
    readConfigMock.mockReturnValue(null);
  });

  it('clears pairing code through workspace config callback', async () => {
    const { addGateway } = await import('../src/main/ws/index.js');

    addGateway({
      id: 'gw-1',
      name: 'Gateway',
      url: 'wss://gateway.example.com/ws',
      auth: { token: 'shared-token' },
    });

    const { GatewayClient } = await import('../src/main/ws/gateway-client.js');
    const instance = vi.mocked(GatewayClient).mock.calls[0]?.[1];

    expect(instance?.onPairingSuccess).toBeTypeOf('function');
    instance?.onPairingSuccess?.('gw-1');
    expect(clearPairingCodeMock).toHaveBeenCalledWith('gw-1');
  });

  const GW = { id: 'gw-1', name: 'Gateway', url: 'wss://gateway.example.com/ws', auth: { token: 't' } };

  /** 每条被构造出来的连接的第二个参数（`opts`）。 */
  async function constructedOpts(): Promise<Array<{ approvalChannel?: boolean } | undefined>> {
    const { GatewayClient } = await import('../src/main/ws/gateway-client.js');
    return vi.mocked(GatewayClient).mock.calls.map((call) => call[1]);
  }

  it('⭐ 一个网关要开出**两条**连接：主连接 + 审批连接（少开它 ≡ exec 审批 17ms 秒死）', async () => {
    const { addGateway } = await import('../src/main/ws/index.js');
    addGateway(GW);

    const opts = await constructedOpts();
    expect(opts).toHaveLength(2);
    expect(opts.filter((o) => o?.approvalChannel === true)).toHaveLength(1);
    // 两条都要真的去连 —— 只构造不 connect 等于没开
    expect(connectMock).toHaveBeenCalledTimes(2);
  });

  it('⭐ 开机自装那条路（initAllGateways）也要开出审批连接', async () => {
    // 这条才是真正的启动路径：只测 addGateway 会漏掉"开机时根本没开"这种整段缺失。
    readConfigMock.mockReturnValue({ gateways: [GW] });
    const { initAllGateways } = await import('../src/main/ws/index.js');
    initAllGateways();

    const opts = await constructedOpts();
    expect(opts).toHaveLength(2);
    expect(opts.some((o) => o?.approvalChannel === true)).toBe(true);
  });

  it('⭐ 审批连接**不进** `getAllGatewayClients` —— 混进去每条请求会发两遍', async () => {
    const { addGateway, getAllGatewayClients } = await import('../src/main/ws/index.js');
    addGateway(GW);
    expect(getAllGatewayClients().size).toBe(1);
  });

  it('removeGateway 把两条一起销毁（漏掉审批连接就是静默泄漏一条 WS + 一个心跳）', async () => {
    const { addGateway, removeGateway } = await import('../src/main/ws/index.js');
    addGateway(GW);
    removeGateway('gw-1');
    expect(destroyMock).toHaveBeenCalledTimes(2);
  });

  it('⭐ reconnectGateway 两条一起重连（审批连接单独断线时**没有人会喊**）', async () => {
    const { addGateway, reconnectGateway } = await import('../src/main/ws/index.js');
    addGateway(GW);
    reconnectMock.mockClear();
    reconnectGateway('gw-1');
    expect(reconnectMock).toHaveBeenCalledTimes(2);
  });

  it('destroyAllGateways 两条一起清掉', async () => {
    const { addGateway, destroyAllGateways } = await import('../src/main/ws/index.js');
    addGateway(GW);
    destroyMock.mockClear();
    destroyAllGateways();
    expect(destroyMock).toHaveBeenCalledTimes(2);
  });
});
