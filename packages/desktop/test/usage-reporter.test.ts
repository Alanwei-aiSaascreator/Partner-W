import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpcMock = vi.fn(async () => ({ data: null, error: null }));
const getUserMock = vi.fn(async () => ({ data: { user: { id: 'user-1' } }, error: null }));
const getCommercialClientMock = vi.fn(() => ({
  rpc: rpcMock,
  auth: { getUser: getUserMock },
}));

vi.mock('../src/main/commercial/client.js', () => ({
  getCommercialClient: getCommercialClientMock,
}));

const getSessionUsageMock = vi.fn();
const getConfigMock = vi.fn();
const getAllGatewayClientsMock = vi.fn();

vi.mock('../src/main/ws/index.js', () => ({
  getAllGatewayClients: getAllGatewayClientsMock,
}));

vi.mock('../src/main/debug/index.js', () => ({
  initDebugLogger: vi.fn(),
  getDebugLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), flush: vi.fn() }),
}));

function gatewayWith() {
  return {
    id: 'gw-1',
    isConnected: true,
    getSessionUsage: getSessionUsageMock,
    getConfig: getConfigMock,
  };
}

/** 网关配置快照的形态：真正的配置在 `.config` 下（见 packages/shared 的 ConfigSnapshot）。 */
function configWithProviders(providers: Record<string, { baseUrl?: string }>) {
  return { hash: 'h1', config: { models: { providers } }, raw: '', path: '' };
}

function oneSession(provider: string) {
  return {
    sessions: [
      {
        key: 'sess-1',
        modelUsage: [
          { provider, model: 'm', count: 1, totals: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 } },
        ],
      },
    ],
  };
}

describe('usage reporter', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    getCommercialClientMock.mockReturnValue({
      rpc: rpcMock,
      auth: { getUser: getUserMock },
    } as never);
    // 默认：没有任何 provider 指向 relay —— 老用例因此保持原行为。
    getConfigMock.mockResolvedValue(configWithProviders({}));
    // ⚠️ 必须在这里重设 rpc 的默认实现：`clearAllMocks` 只清调用记录、
    // **不清实现**，所以上一个用例里 `mockResolvedValue` 设过的「返回错误」
    // 会漏到下一个用例。原来那个设为错误的用例恰好排在最后，所以一直没暴露。
    rpcMock.mockResolvedValue({ data: null, error: null } as never);
  });

  /**
   * ⭐ 2026-09-17 实机日志：上报器 38 次拿到
   * `Multiple agents are configured, but session key "main" has no explicit owner.`
   *
   * 客户端原来只发 `{}`，注释还写着"省略 key 就返回全部会话"—— 那是**猜的协议**。
   * 网关 schema（`SessionsUsageParamsSchema`）里"跨 agent 列表查询"要显式声明
   * `agentScope: "all"`。少了它，网关逐个会话解析归属，碰到没有 owner 的 `main`
   * 就整条失败 ⇒ **上报器整个网关跳过**，用户的非中转用量一分都记不上。
   */
  it('⭐ 查全部会话必须显式带 agentScope:"all"（否则多 agent 网关整条拒绝）', async () => {
    getAllGatewayClientsMock.mockReturnValue(new Map([['gw-1', gatewayWith()]]));
    getSessionUsageMock.mockResolvedValue({ sessions: [] });
    const { runUsageReport } = await import('../src/main/commercial/usage-reporter.js');

    await runUsageReport();

    expect(getSessionUsageMock).toHaveBeenCalledWith({ agentScope: 'all' });
  });

  it('reports each model line of each session as a cumulative total', async () => {
    getSessionUsageMock.mockResolvedValue({
      sessions: [
        {
          key: 'sess-1',
          modelUsage: [
            {
              provider: 'bailian',
              model: 'deepseek-v4-flash',
              count: 3,
              totals: { input: 1000, output: 2000, cacheRead: 400, cacheWrite: 100 },
            },
          ],
        },
      ],
    });
    getAllGatewayClientsMock.mockReturnValue(new Map([['gw-1', gatewayWith()]]));

    const { runUsageReport } = await import('../src/main/commercial/usage-reporter.js');
    const sent = await runUsageReport();

    expect(sent).toBe(1);
    expect(rpcMock).toHaveBeenCalledWith('report_usage', {
      p_session_key: 'sess-1',
      p_provider: 'bailian',
      p_model: 'deepseek-v4-flash',
      p_cum_input: 1000,
      p_cum_output: 2000,
      p_cum_cached: 500,
    });
  });

  it('skips sessions without a usage breakdown', async () => {
    getSessionUsageMock.mockResolvedValue({ sessions: [{ key: 'sess-empty' }] });
    getAllGatewayClientsMock.mockReturnValue(new Map([['gw-1', gatewayWith()]]));

    const { runUsageReport } = await import('../src/main/commercial/usage-reporter.js');
    const sent = await runUsageReport();

    expect(sent).toBe(0);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('does nothing when no gateway is connected', async () => {
    getAllGatewayClientsMock.mockReturnValue(new Map());

    const { runUsageReport } = await import('../src/main/commercial/usage-reporter.js');
    const sent = await runUsageReport();

    expect(sent).toBe(0);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('does not throw when the rpc fails', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'boom' } } as never);
    getSessionUsageMock.mockResolvedValue({
      sessions: [
        {
          key: 'sess-1',
          modelUsage: [
            { provider: 'bailian', model: 'm', count: 1, totals: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
          ],
        },
      ],
    });
    getAllGatewayClientsMock.mockReturnValue(new Map([['gw-1', gatewayWith()]]));

    const { runUsageReport } = await import('../src/main/commercial/usage-reporter.js');
    await expect(runUsageReport()).resolves.toBe(0);
  });

  // ── 中转服务上线后的新契约 ────────────────────────────────────────────────
  //
  // 中转服务在服务端直接测量 token 并落账。同一次调用如果客户端**也**上报，
  // 就是两条独立的账（session key 与 provider 都不同，服务端的差分去重挡不住）
  // —— 用户被扣两次。所以客户端要跳过「已经由中转服务计量的那次调用」。
  //
  // 判据是**配置来源**（baseUrl 指向我们），不是 provider 的名字 ——
  // 名字可以改，改了按名字过滤就失效了。

  it('按 baseUrl 跳过指向 relay 的 provider，而不是按名字猜', async () => {
    const { RELAY_BASE_URL } = await import('../src/main/commercial/relay-config.js');

    getSessionUsageMock.mockResolvedValue({
      sessions: [
        {
          key: 'sess-1',
          modelUsage: [
            // 名字像 relay，但 baseUrl 指向别处 —— **必须照报**，不能凭名字跳过
            {
              provider: 'clawrouter',
              model: 'm1',
              count: 1,
              totals: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
            // 名字完全不像，但 baseUrl 指向我们 —— **必须跳过**
            {
              provider: 'relay-gw',
              model: 'm2',
              count: 1,
              totals: { input: 20, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      ],
    });
    getConfigMock.mockResolvedValue(
      configWithProviders({
        clawrouter: { baseUrl: 'https://example.com/not-ours' },
        'relay-gw': { baseUrl: RELAY_BASE_URL },
      }),
    );
    getAllGatewayClientsMock.mockReturnValue(new Map([['gw-1', gatewayWith()]]));

    const { runUsageReport } = await import('../src/main/commercial/usage-reporter.js');
    const sent = await runUsageReport();

    expect(sent).toBe(1);
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith('report_usage', expect.objectContaining({ p_provider: 'clawrouter' }));
  });

  it('尾斜杠不同也算指向 relay', async () => {
    const { RELAY_BASE_URL } = await import('../src/main/commercial/relay-config.js');
    getSessionUsageMock.mockResolvedValue(oneSession('r'));
    getConfigMock.mockResolvedValue(configWithProviders({ r: { baseUrl: `${RELAY_BASE_URL}/` } }));
    getAllGatewayClientsMock.mockReturnValue(new Map([['gw-1', gatewayWith()]]));

    const { runUsageReport } = await import('../src/main/commercial/usage-reporter.js');

    expect(await runUsageReport()).toBe(0);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('没有 provider 指向 relay 时，行为与以前一字不差（未迁移用户不受影响）', async () => {
    getSessionUsageMock.mockResolvedValue(oneSession('bailian'));
    getConfigMock.mockResolvedValue(
      configWithProviders({ bailian: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' } }),
    );
    getAllGatewayClientsMock.mockReturnValue(new Map([['gw-1', gatewayWith()]]));

    const { runUsageReport } = await import('../src/main/commercial/usage-reporter.js');

    expect(await runUsageReport()).toBe(1);
    expect(rpcMock).toHaveBeenCalledTimes(1);
  });

  it('配置读不到时整条网关跳过 —— 宁可漏记一个 tick，不可双记', async () => {
    // 判据：上报是**累计量**，服务端做差分。漏一个 tick 只是延迟，
    // 下一个 tick 会把完整累计值带上；而双记是立刻多扣用户的钱。
    getSessionUsageMock.mockResolvedValue(oneSession('bailian'));
    getConfigMock.mockRejectedValue(new Error('config unavailable'));
    getAllGatewayClientsMock.mockReturnValue(new Map([['gw-1', gatewayWith()]]));

    const { runUsageReport } = await import('../src/main/commercial/usage-reporter.js');

    expect(await runUsageReport()).toBe(0);
    expect(rpcMock).not.toHaveBeenCalled();
  });
});
