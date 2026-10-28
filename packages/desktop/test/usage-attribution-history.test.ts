import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CallTimeEvidence,
  UsageAttributionStore,
  UsageObservation,
  UsagePlan,
} from '../src/main/commercial/usage-attribution.js';

/**
 * BUG-087（F2）：**历史用量归属** —— 判据必须是"这次调用当时是不是我们计量的"，
 * 不能是"现在配置里怎么说"。
 *
 * ## 为什么当前判据错（P01 独审 F2 的两条真实反例）
 *
 * `usage-reporter` 现在完全按**当前配置快照**分类：`relayOwnedProviderIds(getConfig())`
 * 命中就跳过。而网关给的是**每个会话的累计量**，服务端 `report_usage` 用
 * `greatest(cum − prev, 0)` 做差分（`supabase/migrations/20260921000057_*.sql:190`）。
 * 累计量落到哪个键上（`org_id, session_key, provider, model`）**不随配置变化**，
 * 于是"配置变了"就等于"同一批 token 换了收费身份"：
 *
 *   - **触发 A（重复计费）**：旧端点 provider 的历史累计量还在 → 这个 tick 因为
 *     "是我们的"被跳过（报 0）→ 清账补丁把该 provider 删掉 → **下一个 tick
 *     对同一批历史累计量调用 `report_usage`**（服务端此前从没见过这个键 ⇒
 *     差额 = 全量）⇒ relay 已经计过一次的 token **再扣一次**。
 *   - **触发 B（漏报）**：原本非 relay 的 provider 改名/改址成官方端点后，
 *     连续 tick 都判 0，配置不再变化就永远不补报。
 *
 * ## 修法（本文件钉住的语义）
 *
 * 归属**粘滞**并**持久化**：一个 provider 名一旦被观测为"由中转计量"
 * （当轮配置判它是我们的，且有它的用量行），此后**永久**跳过 —— 即使它被删除、
 * 改名、改址、改回来。反向（非 relay → relay）在转换那一轮**补报一次转换前
 * 观测到的累计量**：那个值是在"非 relay 归属"下读到的，**不含 relay 计量的 token**，
 * 所以补报不会双扣；而当前值不能补报（它已经掺进了 relay 计量的部分）。
 *
 * ## 约定方向（写在测试里，防止后人放宽）
 *
 * **宁可少报（下一 tick 补），不可双扣。** 任何不确定一律按"已由中转计量"处理。
 * 代价是保守漏报（例如同一个名字被用户"改名后再用"），收益是绝不会多扣用户的钱。
 */

const LEGACY_RELAY_BASE_URL = 'https://api.rongyinghudong.com/relay';
const NEW_RELAY_BASE_URL = 'https://api.rongyinghudong.com/relay-108';
const THIRD_PARTY_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

// ── usage-reporter 的真实入口夹具（与 test/usage-reporter.test.ts 同款） ──────────
const rpcMock = vi.fn(async (..._args: unknown[]) => ({ data: null, error: null }) as unknown);
const getCommercialClientMock = vi.fn(() => ({
  rpc: rpcMock,
  auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'user-1' } }, error: null })) },
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
  return { id: 'gw-1', isConnected: true, getSessionUsage: getSessionUsageMock, getConfig: getConfigMock };
}

function configWith(providers: Record<string, { baseUrl?: string }>) {
  return { hash: 'h1', config: { models: { providers } }, raw: '', path: '' };
}

type Totals = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };

/** 一条会话用量行（网关 `sessions.usage` 的会话结构）。 */
function usagePayload(lines: Array<{ provider: string; totals: Totals; key?: string; model?: string }>) {
  const sessions = new Map<string, { key: string; modelUsage: unknown[] }>();
  for (const line of lines) {
    const key = line.key ?? 'sess-1';
    const session = sessions.get(key) ?? { key, modelUsage: [] };
    session.modelUsage.push({
      provider: line.provider,
      model: line.model ?? 'm',
      count: 1,
      totals: line.totals,
    });
    sessions.set(key, session);
  }
  return { sessions: [...sessions.values()] };
}

/** 每轮 tick 都重新 import：单测之间的模块级状态（含默认 store）必须分开。 */
async function reporterWith(store: UsageAttributionStore) {
  const { runUsageReport } = await import('../src/main/commercial/usage-reporter.js');
  return (): Promise<number> => runUsageReport({ store });
}

async function memoryStore(): Promise<UsageAttributionStore> {
  const attribution = await import('../src/main/commercial/usage-attribution.js');
  return attribution.createMemoryAttributionStore();
}

async function setActiveEndpoint(baseUrl: string | null): Promise<void> {
  const relayConfig = await import('../src/main/commercial/relay-config.js');
  relayConfig.setActiveRelayBaseUrl(baseUrl);
}

/** `rpc('report_usage', payload)` 的第 N 次调用的载荷。 */
function reportCalls(): Array<Record<string, unknown>> {
  return rpcMock.mock.calls
    .filter((call) => call[0] === 'report_usage')
    .map((call) => call[1] as Record<string, unknown>);
}

const tempDirs: string[] = [];

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  getCommercialClientMock.mockReturnValue({
    rpc: rpcMock,
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'user-1' } }, error: null })) },
  } as never);
  rpcMock.mockResolvedValue({ data: null, error: null } as never);
  getConfigMock.mockResolvedValue(configWith({}));
  getSessionUsageMock.mockResolvedValue({ sessions: [] });
  getAllGatewayClientsMock.mockReturnValue(new Map([['gw-1', gatewayWith()]]));
  // BUG-087（2026-10-16 用量终审）：上报器**默认影子模式**（只登记不发送）。
  // 本文件验的是**归属判据本身**，所以显式打开直发；历史补报仍默认关，
  // 只有需要验它那组（触发 B）才在自己的 beforeEach 里打开。
  const reporter = await import('../src/main/commercial/usage-reporter.js');
  reporter.setUsageReportingMode('live');
  reporter.setUsageBackfillEnabled(false);
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响断言 */
    }
  }
});

describe('BUG-087 · 触发 A：删除/清账后不得对同一批历史累计量重报', () => {
  it('⭐ relay provider 从配置里被删掉后，历史累计量绝不能再上报（否则用户被扣两次）', async () => {
    const store = await memoryStore();
    await setActiveEndpoint(LEGACY_RELAY_BASE_URL);
    const run = await reporterWith(store);

    // tick 1：配置里它还是我们的 ⇒ 跳过（这一步现有实现也是对的）
    getConfigMock.mockResolvedValue(configWith({ clawrouter: { baseUrl: LEGACY_RELAY_BASE_URL } }));
    getSessionUsageMock.mockResolvedValue(usagePayload([{ provider: 'clawrouter', totals: { input: 10 } }]));
    expect(await run()).toBe(0);

    // 清账补丁（注销/换卡/换端点）把 provider 删掉 —— 历史累计量仍然会返回
    getConfigMock.mockResolvedValue(configWith({}));
    expect(await run()).toBe(0);

    expect(reportCalls()).toEqual([]);
    // 同一批历史累计量被上报一次就等于 relay 已计量的那批 token 再扣一次。
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('⭐ 换端点方向同理：旧端点 provider 被清账后仍不得重报', async () => {
    const store = await memoryStore();
    await setActiveEndpoint(NEW_RELAY_BASE_URL);
    const run = await reporterWith(store);

    getConfigMock.mockResolvedValue(configWith({ clawrouter: { baseUrl: LEGACY_RELAY_BASE_URL } }));
    getSessionUsageMock.mockResolvedValue(usagePayload([{ provider: 'clawrouter', totals: { input: 10 } }]));
    expect(await run()).toBe(0);

    getConfigMock.mockResolvedValue(configWith({}));
    expect(await run()).toBe(0);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('⭐ 同名改址：同一个 provider 名改指第三方端点后，历史累计量仍不得上报', async () => {
    const store = await memoryStore();
    await setActiveEndpoint(LEGACY_RELAY_BASE_URL);
    const run = await reporterWith(store);

    getConfigMock.mockResolvedValue(configWith({ relay: { baseUrl: LEGACY_RELAY_BASE_URL } }));
    getSessionUsageMock.mockResolvedValue(usagePayload([{ provider: 'relay', totals: { input: 10 } }]));
    expect(await run()).toBe(0);

    // 同一个名字改指第三方：名字底下的累计量里**混着** relay 计过的 token，
    // 整批报上去就是把那部分再扣一次 ⇒ 只能整批弃报。
    getConfigMock.mockResolvedValue(configWith({ relay: { baseUrl: THIRD_PARTY_BASE_URL } }));
    getSessionUsageMock.mockResolvedValue(usagePayload([{ provider: 'relay', totals: { input: 99 } }]));
    expect(await run()).toBe(0);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('⭐ provider ID 复用：名字改回来（第三方 → 官方）也还是不得上报', async () => {
    const store = await memoryStore();
    await setActiveEndpoint(LEGACY_RELAY_BASE_URL);
    const run = await reporterWith(store);

    getConfigMock.mockResolvedValue(configWith({ P: { baseUrl: LEGACY_RELAY_BASE_URL } }));
    getSessionUsageMock.mockResolvedValue(usagePayload([{ provider: 'P', totals: { input: 10 } }]));
    expect(await run()).toBe(0);

    getConfigMock.mockResolvedValue(configWith({ P: { baseUrl: THIRD_PARTY_BASE_URL } }));
    expect(await run()).toBe(0);

    getConfigMock.mockResolvedValue(configWith({ P: { baseUrl: NEW_RELAY_BASE_URL } }));
    expect(await run()).toBe(0);

    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('⭐ 两个方向（旧→新、新→旧）都不得上报：端点回滚也一样', async () => {
    const store = await memoryStore();
    const run = await reporterWith(store);

    // 方向一：活动端点=新，配置里还是旧端点
    await setActiveEndpoint(NEW_RELAY_BASE_URL);
    getConfigMock.mockResolvedValue(configWith({ clawrouter: { baseUrl: LEGACY_RELAY_BASE_URL } }));
    getSessionUsageMock.mockResolvedValue(usagePayload([{ provider: 'clawrouter', totals: { input: 10 } }]));
    expect(await run()).toBe(0);

    // 方向二（回滚）：活动端点退回旧，配置里已经写成新端点
    await setActiveEndpoint(null);
    getConfigMock.mockResolvedValue(configWith({ clawrouter: { baseUrl: NEW_RELAY_BASE_URL } }));
    expect(await run()).toBe(0);

    // 清账之后仍然不得上报
    getConfigMock.mockResolvedValue(configWith({}));
    expect(await run()).toBe(0);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('⭐ 改名：改名前后两个名字都不得上报', async () => {
    const store = await memoryStore();
    await setActiveEndpoint(LEGACY_RELAY_BASE_URL);
    const run = await reporterWith(store);

    getConfigMock.mockResolvedValue(configWith({ 'old-name': { baseUrl: LEGACY_RELAY_BASE_URL } }));
    getSessionUsageMock.mockResolvedValue(usagePayload([{ provider: 'old-name', totals: { input: 10 } }]));
    expect(await run()).toBe(0);

    getConfigMock.mockResolvedValue(configWith({ 'new-name': { baseUrl: LEGACY_RELAY_BASE_URL } }));
    getSessionUsageMock.mockResolvedValue(
      usagePayload([
        { provider: 'old-name', totals: { input: 10 } },
        { provider: 'new-name', totals: { input: 20 } },
      ]),
    );
    expect(await run()).toBe(0);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('⭐ 在途 tick：同一轮里配置被改，判据仍取 tick 开始时的快照，且不产生第二个动作', async () => {
    const store = await memoryStore();
    await setActiveEndpoint(LEGACY_RELAY_BASE_URL);
    const run = await reporterWith(store);

    // 配置读取发生在本轮开始；用量读取期间配置被改成第三方 —— 本轮不能用新配置重新分类。
    getConfigMock.mockResolvedValue(configWith({ clawrouter: { baseUrl: LEGACY_RELAY_BASE_URL } }));
    getSessionUsageMock.mockImplementation(async () => {
      getConfigMock.mockResolvedValue(configWith({ clawrouter: { baseUrl: THIRD_PARTY_BASE_URL } }));
      return usagePayload([{ provider: 'clawrouter', totals: { input: 10 } }]);
    });

    expect(await run()).toBe(0);
    expect(getConfigMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).not.toHaveBeenCalled();

    // 下一轮：配置已经是第三方，但归属粘滞 ⇒ 仍然不得上报。
    expect(await run()).toBe(0);
    expect(rpcMock).not.toHaveBeenCalled();
  });
});

describe('BUG-087 · 触发 B：非 relay → relay 的转换必须补报，且绝不含 relay 计量部分', () => {
  // ⚠️ 历史补报（`catch-up`）**默认关闭**（不追扣历史账，2026-10-16 终审）。
  //    这一组验的是补报**算得对不对**，所以显式打开那个受控开关。
  beforeEach(async () => {
    const reporter = await import('../src/main/commercial/usage-reporter.js');
    reporter.setUsageBackfillEnabled(true);
  });

  it('⭐ 改成官方端点后补报的是**转换前观测到的**累计量，不是当前值', async () => {
    const store = await memoryStore();
    await setActiveEndpoint(LEGACY_RELAY_BASE_URL);
    const run = await reporterWith(store);

    // 轮 1：非 relay，正常上报 10。服务端水位随之到 10。
    getConfigMock.mockResolvedValue(configWith({ P: { baseUrl: THIRD_PARTY_BASE_URL } }));
    getSessionUsageMock.mockResolvedValue(usagePayload([{ provider: 'P', totals: { input: 10 } }]));
    expect(await run()).toBe(1);
    expect(reportCalls()[0]).toMatchObject({ p_provider: 'P', p_cum_input: 10 });

    // 轮 2：改指官方端点，累计量已经涨到 99（其中 89 由 relay 服务端计量过）。
    rpcMock.mockClear();
    getConfigMock.mockResolvedValue(configWith({ P: { baseUrl: LEGACY_RELAY_BASE_URL } }));
    getSessionUsageMock.mockResolvedValue(usagePayload([{ provider: 'P', totals: { input: 99 } }]));
    expect(await run()).toBe(1);

    // 补报必须是转换前的那个值：报 99 就等于把 relay 计量的 89 再扣一次。
    expect(reportCalls()).toEqual([expect.objectContaining({ p_provider: 'P', p_cum_input: 10 })]);
  });

  it('⭐ 上一轮上报失败时，转换补报把那笔找回来（服务端水位仍停在 0）', async () => {
    const store = await memoryStore();
    await setActiveEndpoint(LEGACY_RELAY_BASE_URL);
    const run = await reporterWith(store);

    rpcMock.mockResolvedValue({ data: null, error: { message: 'timeout' } } as never);
    getConfigMock.mockResolvedValue(configWith({ P: { baseUrl: THIRD_PARTY_BASE_URL } }));
    getSessionUsageMock.mockResolvedValue(usagePayload([{ provider: 'P', totals: { input: 10 } }]));
    expect(await run()).toBe(0); // 上报失败

    rpcMock.mockReset();
    rpcMock.mockResolvedValue({ data: null, error: null } as never);
    getConfigMock.mockResolvedValue(configWith({ P: { baseUrl: LEGACY_RELAY_BASE_URL } }));
    getSessionUsageMock.mockResolvedValue(usagePayload([{ provider: 'P', totals: { input: 99 } }]));
    expect(await run()).toBe(1);
    expect(reportCalls()).toEqual([expect.objectContaining({ p_provider: 'P', p_cum_input: 10 })]);
  });

  it('⭐ 补报失败会重试，且永远只补报那个转换前的观测值', async () => {
    const store = await memoryStore();
    await setActiveEndpoint(LEGACY_RELAY_BASE_URL);
    const run = await reporterWith(store);

    getConfigMock.mockResolvedValue(configWith({ P: { baseUrl: THIRD_PARTY_BASE_URL } }));
    getSessionUsageMock.mockResolvedValue(usagePayload([{ provider: 'P', totals: { input: 10 } }]));
    expect(await run()).toBe(1);

    rpcMock.mockResolvedValue({ data: null, error: { message: 'timeout' } } as never);
    getConfigMock.mockResolvedValue(configWith({ P: { baseUrl: LEGACY_RELAY_BASE_URL } }));
    getSessionUsageMock.mockResolvedValue(usagePayload([{ provider: 'P', totals: { input: 99 } }]));
    expect(await run()).toBe(0); // 补报失败

    rpcMock.mockClear();
    rpcMock.mockResolvedValue({ data: null, error: null } as never);
    getSessionUsageMock.mockResolvedValue(usagePayload([{ provider: 'P', totals: { input: 120 } }]));
    expect(await run()).toBe(1);

    expect(reportCalls()).toEqual([expect.objectContaining({ p_provider: 'P', p_cum_input: 10 })]);

    // 补报成功之后不再重复（不是每轮都发一次）。
    rpcMock.mockClear();
    expect(await run()).toBe(0);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('⭐ 从未在非 relay 归属下观测过的 provider，改成官方端点后不得凭空补报', async () => {
    const store = await memoryStore();
    await setActiveEndpoint(LEGACY_RELAY_BASE_URL);
    const run = await reporterWith(store);

    // 第一次见到它时就已经是官方端点 ⇒ 没有"转换前观测值"可补，只能弃报。
    getConfigMock.mockResolvedValue(configWith({ P: { baseUrl: LEGACY_RELAY_BASE_URL } }));
    getSessionUsageMock.mockResolvedValue(usagePayload([{ provider: 'P', totals: { input: 99 } }]));
    expect(await run()).toBe(0);
    expect(rpcMock).not.toHaveBeenCalled();
  });
});

describe('BUG-087 · 控制项：不得把用户自建的用量一并吞掉', () => {
  it('⭐ 真正由 relay 计量的用量绝不重复上报（连续多轮 + 累计增长 + 清账后）', async () => {
    const store = await memoryStore();
    await setActiveEndpoint(LEGACY_RELAY_BASE_URL);
    const run = await reporterWith(store);

    getConfigMock.mockResolvedValue(configWith({ clawrouter: { baseUrl: LEGACY_RELAY_BASE_URL } }));
    for (const input of [10, 50, 200, 900]) {
      getSessionUsageMock.mockResolvedValue(usagePayload([{ provider: 'clawrouter', totals: { input } }]));
      expect(await run()).toBe(0);
    }
    // 清账之后同一批历史累计量还在
    getConfigMock.mockResolvedValue(configWith({}));
    getSessionUsageMock.mockResolvedValue(usagePayload([{ provider: 'clawrouter', totals: { input: 900 } }]));
    expect(await run()).toBe(0);

    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('⭐ 用户自建 provider 照常上报（跨轮累计增长，一点都不许少）', async () => {
    const store = await memoryStore();
    await setActiveEndpoint(LEGACY_RELAY_BASE_URL);
    const run = await reporterWith(store);

    getConfigMock.mockResolvedValue(configWith({ mine: { baseUrl: THIRD_PARTY_BASE_URL } }));
    getSessionUsageMock.mockResolvedValue(usagePayload([{ provider: 'mine', totals: { input: 10, output: 1 } }]));
    expect(await run()).toBe(1);

    getSessionUsageMock.mockResolvedValue(usagePayload([{ provider: 'mine', totals: { input: 30, output: 1 } }]));
    expect(await run()).toBe(1);

    expect(reportCalls()).toEqual([
      expect.objectContaining({ p_provider: 'mine', p_cum_input: 10, p_cum_output: 1 }),
      expect.objectContaining({ p_provider: 'mine', p_cum_input: 30, p_cum_output: 1 }),
    ]);
  });

  it('⭐ 用户自建的 provider 从配置里删掉之后，历史累计量仍要上报（不能一刀切弃报）', async () => {
    const store = await memoryStore();
    await setActiveEndpoint(LEGACY_RELAY_BASE_URL);
    const run = await reporterWith(store);

    getConfigMock.mockResolvedValue(configWith({ mine: { baseUrl: THIRD_PARTY_BASE_URL } }));
    getSessionUsageMock.mockResolvedValue(usagePayload([{ provider: 'mine', totals: { input: 10 } }]));
    expect(await run()).toBe(1);

    rpcMock.mockClear();
    getConfigMock.mockResolvedValue(configWith({}));
    getSessionUsageMock.mockResolvedValue(usagePayload([{ provider: 'mine', totals: { input: 30 } }]));
    expect(await run()).toBe(1);
    expect(reportCalls()).toEqual([expect.objectContaining({ p_provider: 'mine', p_cum_input: 30 })]);
  });

  it('⭐ 同 origin、**相邻路径**的自建 provider 照常上报（不能被归属判据误伤）', async () => {
    const store = await memoryStore();
    await setActiveEndpoint(LEGACY_RELAY_BASE_URL);
    const run = await reporterWith(store);

    // 判据是「端点是不是**我们写的那个**」，不是「同不同 origin」：
    // `.../relay-other` 必须保持"不是我们的"，否则用户自建的 provider 会被静默吞掉。
    // ⚠️ 正面证据要求 provider **确实配在配置里** —— 所以这条夹具必须把它写进配置。
    getConfigMock.mockResolvedValue(
      configWith({ neighbor: { baseUrl: 'https://api.rongyinghudong.com/relay-other' } }),
    );
    getSessionUsageMock.mockResolvedValue(
      usagePayload([{ provider: 'neighbor', totals: { input: 7 }, key: 'sess-2' }]),
    );
    expect(await run()).toBe(1);
    expect(reportCalls()).toEqual([expect.objectContaining({ p_provider: 'neighbor', p_cum_input: 7 })]);
  });
});

describe('BUG-087 · 归属记录必须跨重启持久化', () => {
  it('⭐ 重启后（模块重新加载 + 同一份落盘记录）不得重报 relay 历史', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'usage-attribution-'));
    tempDirs.push(dir);
    const attribution = await import('../src/main/commercial/usage-attribution.js');

    await setActiveEndpoint(LEGACY_RELAY_BASE_URL);
    const firstRun = await reporterWith(attribution.createFileAttributionStore(dir));
    getConfigMock.mockResolvedValue(configWith({ clawrouter: { baseUrl: LEGACY_RELAY_BASE_URL } }));
    getSessionUsageMock.mockResolvedValue(usagePayload([{ provider: 'clawrouter', totals: { input: 10 } }]));
    expect(await firstRun()).toBe(0);

    // 记录真的落盘了
    const onDisk = readFileSync(join(dir, 'usage-attribution.json'), 'utf8');
    expect(onDisk).toContain('clawrouter');

    // 重启：模块状态全丢，只靠落盘记录
    vi.resetModules();
    getCommercialClientMock.mockReturnValue({
      rpc: rpcMock,
      auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'user-1' } }, error: null })) },
    } as never);
    // 重启会带上模块级开关的出厂默认（shadow）—— 这条验的是**落盘归属**，
    // 所以在新实例上重新打开直发，断言才有意义。
    const restartedReporter = await import('../src/main/commercial/usage-reporter.js');
    restartedReporter.setUsageReportingMode('live');
    const restarted = await import('../src/main/commercial/usage-attribution.js');
    const secondRun = await reporterWith(restarted.createFileAttributionStore(dir));

    getConfigMock.mockResolvedValue(configWith({}));
    getSessionUsageMock.mockResolvedValue(usagePayload([{ provider: 'clawrouter', totals: { input: 10 } }]));
    expect(await secondRun()).toBe(0);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('归属记录落盘损坏时保守回退为空记录（不抛，也不据此放宽）', async () => {
    const attribution = await import('../src/main/commercial/usage-attribution.js');
    expect(attribution.parseAttributionState('{ not json')).toEqual(attribution.emptyAttributionState());
    expect(attribution.parseAttributionState({ formatVersion: 999 })).toEqual(attribution.emptyAttributionState());
  });
});

describe('BUG-087 · 兼容与降级', () => {
  it('runUsageReport() 不带 store 也能跑（测试/开发环境不落盘、不抛）', async () => {
    await setActiveEndpoint(LEGACY_RELAY_BASE_URL);
    const { runUsageReport } = await import('../src/main/commercial/usage-reporter.js');

    getConfigMock.mockResolvedValue(configWith({ P: { baseUrl: THIRD_PARTY_BASE_URL } }));
    getSessionUsageMock.mockResolvedValue(usagePayload([{ provider: 'P', totals: { input: 3 } }]));
    expect(await runUsageReport()).toBe(1);
  });
});

describe('BUG-087 · U1：归属绑定调用时证据（账号 / 许可证代次 / 工作区 / 配置代次）', () => {
  it('⭐ provider 名被复用后，**新 session** 的合法外部用量必须能重新分类（不得被永久吞掉）', async () => {
    const store = await memoryStore();
    await setActiveEndpoint(LEGACY_RELAY_BASE_URL);
    const run = await reporterWith(store);

    // 轮 1：P 在**旧会话**里由 relay 计量。
    getConfigMock.mockResolvedValue(configWith({ P: { baseUrl: LEGACY_RELAY_BASE_URL } }));
    getSessionUsageMock.mockResolvedValue(usagePayload([{ provider: 'P', totals: { input: 10 }, key: 'old-sess' }]));
    expect(await run()).toBe(0);

    // 轮 2：同名 provider 改成外部端点，在**全新 session** 产生 20。
    // 新会话名下没有 relay 计量的历史，也不是 relay 端点 ⇒ 必须照报。
    // （旧实现把"曾由 relay 计量"记在 **provider 名**上 ⇒ 这里永久吞掉。）
    getConfigMock.mockResolvedValue(configWith({ P: { baseUrl: THIRD_PARTY_BASE_URL } }));
    getSessionUsageMock.mockResolvedValue(usagePayload([{ provider: 'P', totals: { input: 20 }, key: 'new-sess' }]));
    expect(await run()).toBe(1);
    expect(reportCalls()).toEqual([expect.objectContaining({ p_provider: 'P', p_cum_input: 20 })]);
  });

  it('⭐ 身份（账号 / 许可证代次 / 工作区）变了 ⇒ 该键按未知隔离，旧账不跟着搬', async () => {
    const store = await memoryStore();
    await setActiveEndpoint(LEGACY_RELAY_BASE_URL);
    const run = await reporterWith(store);

    getConfigMock.mockResolvedValue(configWith({ mine: { baseUrl: THIRD_PARTY_BASE_URL } }));
    getSessionUsageMock.mockResolvedValue(usagePayload([{ provider: 'mine', totals: { input: 10 } }]));
    expect(await run()).toBe(1);

    // 换了账号：同一份共享盘上的累计量仍带着**上一个账号**的历史，
    // 直接按累计量上报就是把这批 token 记到新账号头上 ⇒ 只能隔离。
    getCommercialClientMock.mockReturnValue({
      rpc: rpcMock,
      auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'user-2' } }, error: null })) },
    } as never);
    rpcMock.mockClear();
    getSessionUsageMock.mockResolvedValue(usagePayload([{ provider: 'mine', totals: { input: 40 } }]));
    expect(await run()).toBe(0);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('⭐ 配置代次进证据：换配置不改归属结论（relay 粘滞只按观测键，不按 provider 名）', async () => {
    const attribution = await import('../src/main/commercial/usage-attribution.js');
    const state = attribution.emptyAttributionState();
    const plan = (snapshot: string, ids: string[], observations: unknown[]) =>
      attribution.planUsageReports({
        state,
        gatewayId: 'gw-1',
        relayOwnedProviderIds: new Set(ids),
        evidence: {
          accountId: 'acct-1',
          licenseId: 'lic-1',
          licenseEpoch: 3,
          workspaceId: 'ws-1',
          generation: snapshot,
          attestedExternalProviderIds: new Set(['P']),
        },
        observations,
        now: 1,
      } as never);

    const obs = (key: string, provider: string, input: number) => ({
      sessionKey: key,
      provider,
      model: 'm',
      totals: { input, output: 0, cached: 0 },
    });

    // 代次 A：P 由 relay 计量。
    plan('gen-A', ['P'], [obs('sess-A', 'P', 10)]);
    // 代次 B：P 改指外部；新键按 B 的证据重新分类，旧键保持隔离。
    const next = plan('gen-B', [], [obs('sess-B', 'P', 20)]);
    expect(next.reports.map((r: { sessionKey: string }) => r.sessionKey)).toEqual(['sess-B']);
  });
});

describe('BUG-087 · U2：落盘失败不得静默地"下一轮重读旧记录"', () => {
  it('⭐ 写失败 ⇒ 状态留在内存、本轮收费 fail-closed，且下一轮**不回读**旧记录', async () => {
    await setActiveEndpoint(LEGACY_RELAY_BASE_URL);
    const attribution = await import('../src/main/commercial/usage-attribution.js');

    // 一个永远写不进去的账本：磁盘上永远是空的（= 旧记录）。
    let stored: unknown = null;
    const readSpy = vi.fn(() => (stored ? attribution.parseAttributionState(stored) : null) as never);
    const readCheck = readSpy as unknown as () => never;
    const flakyStore: UsageAttributionStore = {
      read: readCheck,
      write: () => {
        throw new Error('disk full');
      },
    };

    const { runUsageReport } = await import('../src/main/commercial/usage-reporter.js');
    getConfigMock.mockResolvedValue(configWith({ P: { baseUrl: THIRD_PARTY_BASE_URL } }));
    getSessionUsageMock.mockResolvedValue(usagePayload([{ provider: 'P', totals: { input: 10 } }]));

    // 轮 1：上报成功但落盘失败 ⇒ 内存里记着水位，磁盘上什么都没有。
    expect(await runUsageReport({ store: flakyStore })).toBe(1);
    rpcMock.mockClear();
    readSpy.mockClear();

    // 轮 2：**不得**回读那份旧记录来决定归属（旧实现正是这么做的：
    // 回读到空账本 ⇒ 水位退回 0 ⇒ 同一批累计量被重复上报）。
    // 同时落盘还没修好，收费方向 fail-closed。
    getSessionUsageMock.mockResolvedValue(usagePayload([{ provider: 'P', totals: { input: 30 } }]));
    expect(await runUsageReport({ store: flakyStore })).toBe(0);
    expect(readSpy).not.toHaveBeenCalled();
    expect(rpcMock).not.toHaveBeenCalled();

    stored = null;
  });

  it('⭐ 落盘恢复之后上报继续（降级不是"永远不上报"）', async () => {
    await setActiveEndpoint(LEGACY_RELAY_BASE_URL);
    const attribution = await import('../src/main/commercial/usage-attribution.js');
    let stored: unknown = null;
    let failNextWrite = true;
    const store: UsageAttributionStore = {
      read: () => (stored ? (attribution.parseAttributionState(stored) as never) : null),
      write: (next) => {
        if (failNextWrite) {
          failNextWrite = false;
          throw new Error('disk full');
        }
        stored = JSON.parse(JSON.stringify(next));
      },
    };

    const { runUsageReport } = await import('../src/main/commercial/usage-reporter.js');
    getConfigMock.mockResolvedValue(configWith({ P: { baseUrl: THIRD_PARTY_BASE_URL } }));

    getSessionUsageMock.mockResolvedValue(usagePayload([{ provider: 'P', totals: { input: 10 } }]));
    expect(await runUsageReport({ store })).toBe(1); // 上报成功，落盘失败 ⇒ 降级
    rpcMock.mockClear();

    getSessionUsageMock.mockResolvedValue(usagePayload([{ provider: 'P', totals: { input: 20 } }]));
    expect(await runUsageReport({ store })).toBe(0); // 降级期 fail-closed

    getSessionUsageMock.mockResolvedValue(usagePayload([{ provider: 'P', totals: { input: 30 } }]));
    expect(await runUsageReport({ store })).toBe(1); // 落盘恢复 ⇒ 照常上报
    expect(reportCalls()).toEqual([expect.objectContaining({ p_provider: 'P', p_cum_input: 30 })]);
  });

  it('⭐ 未知归属（配置查不到这个 provider）⇒ 隔离并保留可恢复诊断，不进可扣费上报', async () => {
    await setActiveEndpoint(LEGACY_RELAY_BASE_URL);
    const attribution = await import('../src/main/commercial/usage-attribution.js');
    const state = attribution.emptyAttributionState();

    const result = attribution.planUsageReports({
      state,
      gatewayId: 'gw-1',
      relayOwnedProviderIds: new Set<string>(),
      evidence: {
        accountId: 'acct-1',
        licenseId: null,
        licenseEpoch: 0,
        workspaceId: 'ws-1',
        generation: 'gen-A',
        attestedExternalProviderIds: new Set<string>(),
      },
      observations: [{ sessionKey: 's', provider: 'gone', model: 'm', totals: { input: 10, output: 0, cached: 0 } }],
      now: 1,
    } as never);

    expect(result.reports).toEqual([]);
    expect(result.unknown).toBe(1);
    // 诊断可恢复：记录留存下来了，但**没有**被标成"账本已建立"。
    expect(Object.keys(result.state.gateways['gw-1']?.keys ?? {})).toHaveLength(1);
    expect(result.state.gateways['gw-1']?.established).toBe(false);
  });
});

/**
 * 2026-10-16 r14 复审 A-1（P2，计费启用前阻断）。
 *
 * 旧实现：`usage-attribution.ts` 先把**任何**已知 relay 观测置成 `gateway.established=true`，
 * 随后用 `attested || gateway.established` 放行新键 —— 于是"这个网关见过任何用量"
 * 被当成了"所有未知 provider 都归外部"的证明。同轮先见已知 relay、再见配置已删的
 * 旧 provider 100，后者被计划成 external 100；账本重载后另一个未知历史 200 同样放行。
 *
 * 修法：信任只落在**该观测键自身**的正面证据（`externalAttested`）上。
 */
describe('BUG-087 · r14 A-1：网关建立标记不得放行无正面证据的未知键', () => {
  const obs = (sessionKey: string, provider: string, input: number): UsageObservation => ({
    sessionKey,
    provider,
    model: 'm',
    totals: { input, output: 0, cached: 0 },
  });
  /** 完整身份 + **空**外部白名单：这些观测没有一条被告知"它归外部"。 */
  const emptyEvidence = (): CallTimeEvidence => ({
    accountId: 'acct-1',
    licenseId: 'card-1',
    licenseEpoch: 1,
    workspaceId: 'ws-1',
    generation: 'gen-1',
    attestedExternalProviderIds: new Set<string>(),
  });
  const plan = (
    attribution: typeof import('../src/main/commercial/usage-attribution.js'),
    state: ReturnType<typeof import('../src/main/commercial/usage-attribution.js').emptyAttributionState>,
    ids: string[],
    observations: UsageObservation[],
    ev: CallTimeEvidence,
  ): UsagePlan =>
    attribution.planUsageReports({
      state,
      gatewayId: 'gw-1',
      relayOwnedProviderIds: new Set(ids),
      evidence: ev,
      observations,
      now: 1,
    });

  it('⭐ 同轮「已知 relay + 配置已删的旧 provider」：后者必须隔离，不得跟着放行', async () => {
    const attribution = await import('../src/main/commercial/usage-attribution.js');
    const state = attribution.emptyAttributionState();

    const mixed = plan(
      attribution,
      state,
      ['KnownRelay'],
      [obs('known', 'KnownRelay', 10), obs('deleted-relay-history', 'DeletedProvider', 100)],
      emptyEvidence(),
    );

    expect(mixed.reports).toEqual([]);
    expect(mixed.unknown).toBe(1);

    // 账本重载之后另一个未知历史也不得被放行（旧实现正是靠网关级标记放行的）。
    const reloaded = attribution.parseAttributionState(JSON.parse(JSON.stringify(state)));
    const persisted = plan(
      attribution,
      reloaded,
      ['KnownRelay'],
      [obs('another-deleted-history', 'MissingProvider', 200)],
      emptyEvidence(),
    );

    expect(persisted.reports).toEqual([]);
    expect(persisted.unknown).toBe(1);
  });

  it('对照：该观测键**自己**拿到过正面证据 ⇒ 配置删掉后仍照报（不是一刀切弃报）', async () => {
    const attribution = await import('../src/main/commercial/usage-attribution.js');
    const state = attribution.emptyAttributionState();
    const attested = (ids: string[]): CallTimeEvidence => ({
      ...emptyEvidence(),
      attestedExternalProviderIds: new Set(ids),
    });

    // 轮 1：配置里正面证实 mine 是外部端点。
    expect(plan(attribution, state, [], [obs('sess-1', 'mine', 10)], attested(['mine'])).reports).toHaveLength(1);

    // 轮 2：配置被删（没有正面证据了），但**这个键自己**有正面历史 ⇒ 仍要上报。
    const next = plan(attribution, state, [], [obs('sess-1', 'mine', 30)], emptyEvidence());
    expect(next.reports.map((r) => r.totals.input)).toEqual([30]);
    expect(next.unknown).toBe(0);
  });
});

/**
 * 2026-10-16 r14 复审 A-2（P2，计费启用前阻断）。
 *
 * 旧实现：身份变更那一轮拒报之后，**仍把该键的 `binding` 改写成新身份** ⇒
 * 下一轮 `identityChanged` 变 false，旧累计量被当成新身份的用量上报
 * （同 session 累计 30：账号 B 第一轮 0、第二轮直接 external 30）。
 * 且 `licenseId` 没参与比较，同账号同代次只换卡也会直接上报 50。
 *
 * 修法：身份变更隔离该键，**不改写**该键的归属身份；`licenseId` 进身份比较；
 * 且该键从此被标记**污染** ⇒ 任何身份（含回头的原身份）都不再直报（r14 集成复核 A-3）。
 */
describe('BUG-087 · r14 A-2/A-3：身份变更不改写该键归属；污染键任何身份都不直报', () => {
  type Identity = {
    accountId: string;
    licenseId: string;
    licenseEpoch: number;
    workspaceId: string;
  };
  const obs = (sessionKey: string, provider: string, input: number): UsageObservation => ({
    sessionKey,
    provider,
    model: 'm',
    totals: { input, output: 0, cached: 0 },
  });
  const planWith = (
    attribution: typeof import('../src/main/commercial/usage-attribution.js'),
    state: ReturnType<typeof import('../src/main/commercial/usage-attribution.js').emptyAttributionState>,
    identity: Identity,
    observations: UsageObservation[],
  ): UsagePlan =>
    attribution.planUsageReports({
      state,
      gatewayId: 'gw-1',
      relayOwnedProviderIds: new Set<string>(),
      evidence: { ...identity, generation: 'gen-1', attestedExternalProviderIds: new Set(['P']) },
      observations,
      now: 1,
    });

  const accountA: Identity = { accountId: 'A', licenseId: 'card-A', licenseEpoch: 1, workspaceId: 'ws-A' };
  const accountB: Identity = { accountId: 'B', licenseId: 'card-B', licenseEpoch: 2, workspaceId: 'ws-B' };

  it('⭐ 换账号：第二轮（累计量没变）仍不得认领给新账号', async () => {
    const attribution = await import('../src/main/commercial/usage-attribution.js');
    const state = attribution.emptyAttributionState();
    const run = (identity: Identity) => planWith(attribution, state, identity, [obs('same-shared-session', 'P', 30)]);

    // 账号 A：这 30 是 A 的。
    expect(run(accountA).reports.map((r) => r.totals.input)).toEqual([30]);

    // 账号 B：第一轮隔离（累计量里带着上一个账号的历史）。
    expect(run(accountB).reports).toEqual([]);
    // 第二轮仍必须隔离 —— 旧实现这里把 30 直接认领给 B。
    expect(run(accountB).reports).toEqual([]);
    expect(run(accountB).unknown).toBe(1);

    // 旧身份回来：这个键已被两个身份看过 ⇒ 累计量里混着 B 那一段，
    // **A 也不许**再按当前累计量直报（只隔离外来身份、放行原本身份是不够的）。
    expect(run(accountA).reports).toEqual([]);
    expect(run(accountA).unknown).toBe(1);
  });

  it('⭐ A→B→A：回来的 A 不得认领夹在中间的 B 的用量（累计 30 → 50 → 70）', async () => {
    const attribution = await import('../src/main/commercial/usage-attribution.js');
    const state = attribution.emptyAttributionState();
    const run = (identity: Identity, input: number) =>
      planWith(attribution, state, identity, [obs('shared-key', 'P', input)]);

    // A 观测到累计 30：这 30 是 A 的，正常上报，服务端 (org_A, key) 水位到 30。
    expect(run(accountA, 30).reports.map((r) => r.totals.input)).toEqual([30]);

    // 切到 B：B 把同一个会话的累计量涨到 50（其中 20 是 **B** 产生的）。
    expect(run(accountB, 50).reports).toEqual([]);

    // A 回来，累计量已经 70。⚠️ 直报 70 的话服务端按 (org_A, key) 差分
    // `70 − 30 = 40` ⇒ **A 被扣掉 B 的那 20**。所以这一轮必须隔离。
    const back = run(accountA, 70);
    expect(back.reports).toEqual([]);
    expect(back.unknown).toBe(1);
    // 不能留下任何把 50→70（或 30→70）算到 A 头上的 external 残留。
    expect(back.reports.filter((r) => r.reason === 'external')).toEqual([]);
  });

  it('污染是键级的：另一个键（新会话）不受牵连', async () => {
    const attribution = await import('../src/main/commercial/usage-attribution.js');
    const state = attribution.emptyAttributionState();
    const plan = (identity: Identity, observations: UsageObservation[]) =>
      planWith(attribution, state, identity, observations);

    // 键 K 被两个身份看过 ⇒ 污染。
    plan(accountA, [obs('K', 'P', 30)]);
    plan(accountB, [obs('K', 'P', 50)]);

    // 另一个键（新会话）只在 A 名下出现过一次 ⇒ 不污染，照常上报。
    expect(plan(accountA, [obs('K2', 'P', 10)]).reports.map((r) => r.totals.input)).toEqual([10]);
    // 污染的键不会因此"顺便被放行"。
    expect(plan(accountA, [obs('K', 'P', 70)]).reports).toEqual([]);
  });

  it('⭐ 同账号同代次、只换许可证 id ⇒ 同样按身份变更隔离', async () => {
    const attribution = await import('../src/main/commercial/usage-attribution.js');
    const state = attribution.emptyAttributionState();
    const run = (licenseId: string) => planWith(attribution, state, { ...accountA, licenseId }, [obs('same', 'P', 50)]);

    expect(run('card-A').reports.map((r) => r.totals.input)).toEqual([50]);
    // 换卡 = 换付费身份：同一批累计量不得记到新卡上。
    expect(run('other-card').reports).toEqual([]);
    expect(run('other-card').unknown).toBe(1);
  });
});
