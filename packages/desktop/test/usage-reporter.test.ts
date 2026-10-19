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
  beforeEach(async () => {
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
    // BUG-087（2026-10-16 用量终审）：上报器**默认影子模式** —— 只登记
    // "本应上报什么"，不发送。本文件验的是**解码与归属判据**，所以显式开直发；
    // "默认影子 / 不补报历史"由文件末尾那组专项用例钉住。
    const reporter = await import('../src/main/commercial/usage-reporter.js');
    reporter.setUsageReportingMode('live');
    reporter.setUsageBackfillEnabled(false);
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
    // BUG-087 U2：归属要有**正面证据**（provider 确实配在网关里、端点不是我们的）。
    // 配置里查不到它的观测一律按未知隔离 —— 所以这条正常路径必须把 provider 配上。
    getConfigMock.mockResolvedValue(
      configWithProviders({ bailian: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' } }),
    );
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
    // 同 U2：先给一份正面证据，否则这条会走"未知隔离"，根本到不了 rpc 失败那条路。
    getConfigMock.mockResolvedValue(
      configWithProviders({ bailian: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' } }),
    );
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

  // ── BUG-087（2026-10-16 用量终审 U1/U2/U3）新增契约 ──────────────────────

  it('⭐ U3：随包运行时的**嵌套**形状 session.usage.modelUsage 被正确解码', async () => {
    // 真源：`dist/usage-lCaKvodi.mjs` 的 "sessions.usage" handler 把 summary
    // 放进会话的 `usage` 键；summary 由 `session-cost-usage-*.mjs:1099`
    // 的 `modelUsage: sortedModelUsage(models)` 生成。旧扁平形状解出 0 行。
    getConfigMock.mockResolvedValue(
      configWithProviders({ bailian: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' } }),
    );
    getSessionUsageMock.mockResolvedValue({
      sessions: [
        {
          key: 'sess-1',
          usage: {
            modelUsage: [
              {
                provider: 'bailian',
                model: 'deepseek-v4-flash',
                count: 3,
                totals: { input: 1000, output: 2000, cacheRead: 400, cacheWrite: 100 },
              },
            ],
          },
        },
      ],
    });
    getAllGatewayClientsMock.mockReturnValue(new Map([['gw-1', gatewayWith()]]));

    const { runUsageReport } = await import('../src/main/commercial/usage-reporter.js');

    expect(await runUsageReport()).toBe(1);
    expect(rpcMock).toHaveBeenCalledWith('report_usage', {
      p_session_key: 'sess-1',
      p_provider: 'bailian',
      p_model: 'deepseek-v4-flash',
      p_cum_input: 1000,
      p_cum_output: 2000,
      p_cum_cached: 500,
    });
  });

  it('⭐ U2：账本为空 + 配置里查不到这个 provider ⇒ 归属未知，隔离不上报', async () => {
    // 场景：配置早已被清理（注销/换卡/清账），历史累计量仍在。
    // 「不在 relay 集合里」是个**空集也能满足**的条件 —— 它不是反证。
    getConfigMock.mockResolvedValue(configWithProviders({}));
    getSessionUsageMock.mockResolvedValue(oneSession('claude-archived-provider'));
    getAllGatewayClientsMock.mockReturnValue(new Map([['gw-1', gatewayWith()]]));

    const { runUsageReport } = await import('../src/main/commercial/usage-reporter.js');

    expect(await runUsageReport()).toBe(0);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('⭐ U4：默认模式是 shadow —— 解出用量也只登记影子对账，一个包都不发', async () => {
    const reporter = await import('../src/main/commercial/usage-reporter.js');
    reporter.setUsageReportingMode('shadow');
    getConfigMock.mockResolvedValue(
      configWithProviders({ mine: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' } }),
    );
    getSessionUsageMock.mockResolvedValue(oneSession('mine'));
    getAllGatewayClientsMock.mockReturnValue(new Map([['gw-1', gatewayWith()]]));

    expect(await reporter.runUsageReport()).toBe(0);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('⭐ 两个开关的出厂默认值：shadow + 不补报历史账', async () => {
    vi.resetModules();
    const fresh = await import('../src/main/commercial/usage-reporter.js');
    expect(fresh.getUsageReportingMode()).toBe('shadow');
    expect(fresh.isUsageBackfillEnabled()).toBe(false);
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

/**
 * T07 / BUG-086-087：**`licenseId` 的生产接线**（集成人点名"未闭合项"）。
 *
 * 归属账本落盘时带 `binding.licenseId`（`EvidenceBinding`），身份比较也认它
 * （`identityChanged`：同账号同代次**只换卡**也必须算身份变化）。
 * 但生产路径**从来没把 licenseId 塞进证据** —— `setUsageAttributionIdentityProvider`
 * 全仓只有测试在调，`resolveIdentity()` 的默认分支把 `licenseId` 恒定留成 `null`。
 * 于是"换卡"在两台都读不到 licenseId 的机器上**看起来像没换卡**，旧卡的累计量
 * 会被记到新卡头上（正是 A-2/A-3 要挡的那类）。
 *
 * 这里钉住的是**默认（未注入 provider）路径**：绑定信息从本地持久化配置里取
 * （`license.ts` 的 `persistLicenseBinding` 写入的 `commercial.licenseBinding`），
 * 便宜、同步、且随清卡/换卡一起被改写 —— 不需要 5 分钟一次的 tick 去打后端。
 */
describe('usage reporter · 身份接线（licenseId 生产接线，T07）', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    getCommercialClientMock.mockReturnValue({
      rpc: rpcMock,
      auth: { getUser: getUserMock },
    } as never);
    rpcMock.mockResolvedValue({ data: null, error: null } as never);
    getConfigMock.mockResolvedValue(
      configWithProviders({ mine: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' } }),
    );
    getSessionUsageMock.mockResolvedValue(oneSession('mine'));
    getAllGatewayClientsMock.mockReturnValue(new Map([['gw-1', gatewayWith()]]));
  });

  it('⭐⭐ 默认路径（没注入 provider）也把**本地绑定的卡 id** 写进调用时证据', async () => {
    vi.doMock('../src/main/workspace/config.js', () => ({
      readConfig: () => ({
        commercial: { licenseBinding: { userId: 'user-1', orgId: 'org-1', licenseId: 'lic-42' } },
      }),
      isWorkspaceConfigured: () => true,
      getWorkspacePath: () => 'D:/ws',
    }));
    const attribution = await import('../src/main/commercial/usage-attribution.js');
    const reporter = await import('../src/main/commercial/usage-reporter.js');
    const store = attribution.createMemoryAttributionStore();
    reporter.setUsageAttributionStore(store);
    reporter.setUsageReportingMode('live');

    expect(await reporter.runUsageReport()).toBe(1);

    const record = store.read()?.gateways['gw-1']?.keys[attribution.attributionKey('sess-1', 'mine', 'm')];
    expect(record?.binding).toMatchObject({ licenseId: 'lic-42', workspaceId: 'D:/ws' });
  });

  it('⭐ 本地没有绑定（老盘升级 / 已清卡）⇒ licenseId 保持 null（不猜）', async () => {
    vi.doMock('../src/main/workspace/config.js', () => ({
      readConfig: () => ({ commercial: {} }),
      isWorkspaceConfigured: () => false,
      getWorkspacePath: () => null,
    }));
    const attribution = await import('../src/main/commercial/usage-attribution.js');
    const reporter = await import('../src/main/commercial/usage-reporter.js');
    const store = attribution.createMemoryAttributionStore();
    reporter.setUsageAttributionStore(store);
    reporter.setUsageReportingMode('live');

    await reporter.runUsageReport();

    const record = store.read()?.gateways['gw-1']?.keys[attribution.attributionKey('sess-1', 'mine', 'm')];
    expect(record?.binding?.licenseId).toBeNull();
  });

  it('⭐ 显式注入的 provider 仍然**优先**于本地读（受控启用路径不被削弱）', async () => {
    vi.doMock('../src/main/workspace/config.js', () => ({
      readConfig: () => ({ commercial: { licenseBinding: { userId: 'user-1', orgId: 'org-1', licenseId: 'local' } } }),
      isWorkspaceConfigured: () => true,
      getWorkspacePath: () => 'D:/ws',
    }));
    const attribution = await import('../src/main/commercial/usage-attribution.js');
    const reporter = await import('../src/main/commercial/usage-reporter.js');
    const store = attribution.createMemoryAttributionStore();
    reporter.setUsageAttributionStore(store);
    reporter.setUsageReportingMode('live');
    reporter.setUsageAttributionIdentityProvider(async () => ({ licenseId: 'injected' }));

    await reporter.runUsageReport();

    const record = store.read()?.gateways['gw-1']?.keys[attribution.attributionKey('sess-1', 'mine', 'm')];
    expect(record?.binding?.licenseId).toBe('injected');
    reporter.setUsageAttributionIdentityProvider(null);
  });
});

/**
 * T07：**shadow → live 的基线演练**（总单点名"完善从 shadow 切到 live 的基线方案并本地演练"）。
 *
 * 要证明的性质只有一条，但它决定上线能不能一键翻：
 *   **影子期"本来会发"的量，切到 live 后必须一次不丢地送达** —— 而且因为发的是
 *   **累计量**（服务端自己 `greatest(cum − prev, 0)` 做差分），重复发同一个累计量
 *   差额为 0，不会多扣。
 *
 * 反向（`catch-up` 历史补报）**默认仍然关**：翻 live 不等于"追扣历史账"。
 */
describe('usage reporter · shadow → live 基线演练（T07）', () => {
  const THIRD_PARTY = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    getCommercialClientMock.mockReturnValue({
      rpc: rpcMock,
      auth: { getUser: getUserMock },
    } as never);
    rpcMock.mockResolvedValue({ data: null, error: null } as never);
    getConfigMock.mockResolvedValue(configWithProviders({ mine: { baseUrl: THIRD_PARTY } }));
    getAllGatewayClientsMock.mockReturnValue(new Map([['gw-1', gatewayWith()]]));
  });

  function cumulative(input: number) {
    return {
      sessions: [
        {
          key: 'sess-1',
          modelUsage: [
            { provider: 'mine', model: 'm', count: 1, totals: { input, output: 0, cacheRead: 0, cacheWrite: 0 } },
          ],
        },
      ],
    };
  }

  it('⭐⭐ 影子期观测到的全部用量，切 live 后**一个都不丢**地送达；重复发同一个累计量是对的（服务端差分）', async () => {
    const attribution = await import('../src/main/commercial/usage-attribution.js');
    const reporter = await import('../src/main/commercial/usage-reporter.js');
    const store = attribution.createMemoryAttributionStore();

    // ── 影子期：跑三轮，累计量 100 → 250 → 250 ──────────────────────────
    reporter.setUsageReportingMode('shadow');
    reporter.setUsageBackfillEnabled(false);
    for (const input of [100, 250, 250]) {
      getSessionUsageMock.mockResolvedValue(cumulative(input));
      expect(await reporter.runUsageReport({ store })).toBe(0);
    }
    // 影子期**一个包都没发** —— 这是翻模式之前唯一的安全保证。
    expect(rpcMock).not.toHaveBeenCalled();

    // ── 翻到 live：第一轮就把当前累计量（400，含影子期涨的 250 + 新涨的 150）送出去 ──
    reporter.setUsageReportingMode('live');
    getSessionUsageMock.mockResolvedValue(cumulative(400));
    expect(await reporter.runUsageReport({ store })).toBe(1);
    expect(rpcMock).toHaveBeenLastCalledWith('report_usage', {
      p_session_key: 'sess-1',
      p_provider: 'mine',
      p_model: 'm',
      p_cum_input: 400,
      p_cum_output: 0,
      p_cum_cached: 0,
    });

    // ── 再跑一轮、累计量没变：照发**同一个累计量**（不是差值）⇒ 服务端差分 0，不会多扣 ──
    rpcMock.mockClear();
    expect(await reporter.runUsageReport({ store })).toBe(1);
    expect(rpcMock).toHaveBeenCalledWith(
      'report_usage',
      expect.objectContaining({ p_cum_input: 400, p_cum_output: 0, p_cum_cached: 0 }),
    );

    // 账本交付水位停在最后送出的累计量上。
    const record = store.read()?.gateways['gw-1']?.keys[attribution.attributionKey('sess-1', 'mine', 'm')];
    expect(record?.reported).toEqual({ input: 400, output: 0, cached: 0 });
  });

  it('⭐⭐ 翻 live **不等于**追扣历史：`catch-up` 默认仍然不发；只有显式开 backfill 才发一次', async () => {
    const attribution = await import('../src/main/commercial/usage-attribution.js');
    const reporter = await import('../src/main/commercial/usage-reporter.js');
    const store = attribution.createMemoryAttributionStore();
    reporter.setUsageReportingMode('live');

    // 第一轮：外部归属，报 100（账本记下"已交付 100"）。
    getSessionUsageMock.mockResolvedValue(cumulative(100));
    expect(await reporter.runUsageReport({ store })).toBe(1);

    // 配置改成官方端点：该键转成 relay，欠下一笔"转换前观测值"（catch-up）。
    getConfigMock.mockResolvedValue(configWithProviders({ mine: { baseUrl: 'https://api.rongyinghudong.com/relay' } }));
    getSessionUsageMock.mockResolvedValue(cumulative(500));

    // 默认（backfill 关）：只发 0 —— 历史账**不追扣**。
    rpcMock.mockClear();
    expect(await reporter.runUsageReport({ store })).toBe(0);
    expect(rpcMock).not.toHaveBeenCalled();

    // 显式开 backfill：那一笔补报发一次，且值恒为**转换前观测到的 100**（不是当前 500）。
    reporter.setUsageBackfillEnabled(true);
    expect(await reporter.runUsageReport({ store })).toBe(1);
    expect(rpcMock).toHaveBeenCalledWith(
      'report_usage',
      expect.objectContaining({ p_provider: 'mine', p_cum_input: 100 }),
    );

    // 再跑：补报已结算，不再重复发。
    rpcMock.mockClear();
    expect(await reporter.runUsageReport({ store })).toBe(0);
    expect(rpcMock).not.toHaveBeenCalled();
  });
});
