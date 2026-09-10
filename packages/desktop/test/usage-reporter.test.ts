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
});
