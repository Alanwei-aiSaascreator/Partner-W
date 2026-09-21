import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { ActivationErrorCode } from '../src/main/commercial/license.js';
import type { RelayKeyFetchErrorCode, RelayGatewayHandle } from '../src/main/commercial/relay-bootstrap.js';

/**
 * `relay-startup` 的**接线层** —— 把 Supabase 的 `activate_license` 接成
 * `RelayBootstrapDeps.fetchRelayKey`。
 *
 * ## 这个文件钉的是那次「塌缩」
 *
 * 取 key 原先返回 `string | null`：服务端**确定性**的拒绝（卡已绑到别的组织 /
 * 卡失效 / 激活数满）、**被抛出的网络/超时**、以及「RPC 成功但没下发 key」，
 * 三件完全不同的事全被压成同一个 `null`。上层因此只能说「没卡」（`unlicensed`）：
 * 用户不知道卡在另一个账号名下，排查的人拿不到 SQLSTATE，而重试策略也无从区分
 * 「等一等会好」和「等一万年也一样」。
 *
 * ## 两条语义边界（刻意划死）
 *
 * - **确定性拒绝 = 这一轮的终局**：4 分钟的网关/会话重试窗口里**绝不**再发一次
 *   `activate_license`（它是幂等的，但重试本身在打服务端，且结论不会变）；
 * - **抛出的网络/超时**正相反：`transport` + `retryable`，交给既有退避。
 *
 * ## 日志纪律
 *
 * 结构化日志里**只能**出现 SQLSTATE 与安全码。原始 message 不进 —— 服务端的文案
 * 可能回显卡密（`activate_license` 的入参就是卡密），异常文案里还可能带 URL 与 token。
 */

const LICENSE = 'RY-TEST-0001';
const RELAY_KEY = 'rly_test_key_should_never_be_logged';
/** 服务端文案里**故意**带上卡密：这正是「别把原始 message 写进日志」的理由。 */
const BOUND_ELSEWHERE_MESSAGE = `activate_license: license ${LICENSE} is already bound to another organization`;

const mocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  rpc: vi.fn(),
  from: vi.fn(),
  getAllGatewayClients: vi.fn(),
  probeAuth: vi.fn(async () => 'authenticated'),
  drain: vi.fn(async () => ({ cleaned: false, pending: false })),
  getCommercialClient: vi.fn(),
}));

vi.mock('../src/main/commercial/client.js', () => ({
  getCommercialClient: mocks.getCommercialClient,
}));

// 接线层会 import 这些模块的全部真身（ws / auth / cleanup → electron、state-config）。
// 本文件只测「边界怎么分类 + 日志写了什么」，这些邻居一律替身。
vi.mock('../src/main/commercial/auth.js', () => ({ probeAuth: mocks.probeAuth }));
vi.mock('../src/main/commercial/relay-cleanup.js', () => ({
  buildCommercialAccessCleanupDeps: () => ({}),
  drainPendingCommercialAccessCleanup: mocks.drain,
}));
vi.mock('../src/main/runtime/state-config.js', () => ({ LOCAL_GATEWAY_ID: 'local-runtime' }));
vi.mock('../src/main/ws/index.js', () => ({ getAllGatewayClients: mocks.getAllGatewayClients }));
vi.mock('../src/main/workspace/config.js', () => ({
  ensureDeviceId: () => 'stable-device-id',
  readConfig: () => ({ commercial: { licenseKey: null } }),
  updateConfig: vi.fn(),
}));
vi.mock('../src/main/debug/index.js', () => ({
  initDebugLogger: vi.fn(),
  getDebugLogger: () => ({ info: mocks.info, warn: mocks.warn, error: vi.fn(), flush: vi.fn() }),
}));

/**
 * 一个可链式、也可直接 `await` 的 PostgREST 查询替身（与 `license-activate.test.ts`
 * 同一份手工替身）：`readLicenseStatus()` 要查表，缺了它读不出卡。
 */
function tableChain(result: unknown) {
  const node: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'order', 'limit', 'not', 'in', 'is', 'filter']) {
    node[method] = vi.fn(() => node);
  }
  node.maybeSingle = vi.fn(async () => result);
  node.single = vi.fn(async () => result);
  node.then = (onFulfilled: (value: unknown) => unknown) => Promise.resolve(result).then(onFulfilled);
  return node;
}

/** 一个假网关：patch 之后回读能看见 provider（applyRelayConfig 要回读校验）。 */
function makeGateway(): {
  gateway: RelayGatewayHandle;
  getConfig: ReturnType<typeof vi.fn>;
  patchConfig: ReturnType<typeof vi.fn>;
} {
  let snapshot: { hash: string; config: Record<string, unknown> } = { hash: 'h1', config: {} };
  const patchConfig = vi.fn(async ({ raw }: { baseHash: string; raw: string }) => {
    snapshot = { hash: 'h2', config: { ...snapshot.config, ...(JSON.parse(raw) as Record<string, unknown>) } };
    return { ok: true };
  });
  const getConfig = vi.fn(async () => ({ ...snapshot }));
  return {
    gateway: { getConfig, patchConfig, runConfigMutation: (work) => work({ getConfig, patchConfig }) },
    getConfig,
    patchConfig,
  };
}

/** 结构化日志的**全部**产出（info + warn），拼成一个串方便做「含/不含」断言。 */
function printedLogs(): string {
  return JSON.stringify([...mocks.info.mock.calls, ...mocks.warn.mock.calls]);
}

describe('fetchRelayKeyForLicense —— 服务端拒绝不再被压成 null', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.getCommercialClient.mockReturnValue({ rpc: mocks.rpc, from: mocks.from });
    mocks.from.mockImplementation((table: string) => {
      if (table === 'org_members') return tableChain({ data: [{ org_id: 'org-1' }] });
      return tableChain({
        data: {
          license_key: LICENSE,
          sku: 'USB-标准版',
          status: 'active',
          expires_at: null,
          max_activations: 1,
          token_quota_micros: 5000,
          token_used_micros: 0,
        },
      });
    });
    mocks.rpc.mockResolvedValue({ data: { relayKey: RELAY_KEY }, error: null });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('⭐ 成功：`{ ok:true, relayKey }`，且仍然带上设备指纹（幂等取同一把 key 的前提）', async () => {
    const { fetchRelayKeyForLicense } = await import('../src/main/commercial/relay-startup.js');

    await expect(fetchRelayKeyForLicense(LICENSE)).resolves.toEqual({ ok: true, relayKey: RELAY_KEY });
    expect(mocks.rpc).toHaveBeenCalledWith('activate_license', {
      p_license_key: LICENSE,
      p_device_fingerprint: expect.any(String),
    });
  });

  it('⭐⭐ 服务端说「卡已绑到别的组织」⇒ { ok:false, errorCode:"license_bound_elsewhere", retryable:false }', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: 'P0001', message: BOUND_ELSEWHERE_MESSAGE } });

    const { fetchRelayKeyForLicense } = await import('../src/main/commercial/relay-startup.js');

    await expect(fetchRelayKeyForLicense(LICENSE)).resolves.toEqual({
      ok: false,
      errorCode: 'license_bound_elsewhere',
      retryable: false,
    });
  });

  it('⭐ 其它确定性拒绝走**同一张**分类表（激活数已达上限 = 23514）', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: '23514', message: '激活数已达上限' } });

    const { fetchRelayKeyForLicense } = await import('../src/main/commercial/relay-startup.js');

    await expect(fetchRelayKeyForLicense(LICENSE)).resolves.toEqual({
      ok: false,
      errorCode: 'activation_limit_reached',
      retryable: false,
    });
  });

  it('⭐⭐ 抛出的网络/超时 ⇒ { ok:false, errorCode:"transport", retryable:true }（等一等真的会好）', async () => {
    mocks.rpc.mockRejectedValue(new Error('fetch failed: ETIMEDOUT'));

    const { fetchRelayKeyForLicense } = await import('../src/main/commercial/relay-startup.js');

    await expect(fetchRelayKeyForLicense(LICENSE)).resolves.toEqual({
      ok: false,
      errorCode: 'transport',
      retryable: true,
    });
  });

  it('⭐⭐ RPC 成功但**没有** relay key ⇒ 确定性 activation_failed，绝不是「成功」', async () => {
    // 旧卡 / RPC 返回形状变了。没有 key 就是列不出模型 —— 报 ok 会让上层
    // 以为拿到了凭证，接着写一个空 apiKey 进网关。
    mocks.rpc.mockResolvedValue({ data: { licenseKey: LICENSE }, error: null });

    const { fetchRelayKeyForLicense } = await import('../src/main/commercial/relay-startup.js');

    await expect(fetchRelayKeyForLicense(LICENSE)).resolves.toEqual({
      ok: false,
      errorCode: 'activation_failed',
      retryable: false,
    });
  });

  it('⭐ 空串 key 与「没有 key」同罪（不是「有一把空 key」）', async () => {
    mocks.rpc.mockResolvedValue({ data: { relayKey: '' }, error: null });

    const { fetchRelayKeyForLicense } = await import('../src/main/commercial/relay-startup.js');

    await expect(fetchRelayKeyForLicense(LICENSE)).resolves.toEqual({
      ok: false,
      errorCode: 'activation_failed',
      retryable: false,
    });
  });

  it('⭐ 没有商业客户端 ⇒ 确定性失败（**不抛**，也不假装成功）', async () => {
    mocks.getCommercialClient.mockReturnValue(null);

    const { fetchRelayKeyForLicense } = await import('../src/main/commercial/relay-startup.js');

    await expect(fetchRelayKeyForLicense(LICENSE)).resolves.toEqual({
      ok: false,
      errorCode: 'activation_failed',
      retryable: false,
    });
  });
});

describe('日志卫生 —— SQLSTATE 与安全码进日志，卡密/原始文案不进', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.getCommercialClient.mockReturnValue({ rpc: mocks.rpc, from: mocks.from });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('⭐⭐ 服务端拒绝：日志里有 SQLSTATE(P0001) 与安全码，没有卡密、没有原始 message', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: 'P0001', message: BOUND_ELSEWHERE_MESSAGE } });

    const { fetchRelayKeyForLicense } = await import('../src/main/commercial/relay-startup.js');
    await fetchRelayKeyForLicense(LICENSE);

    const printed = printedLogs();
    expect(printed, '排查的人要能从日志看出是哪一个 SQLSTATE').toContain('P0001');
    expect(printed, '安全码要进日志 —— 它就是「原因」这一层').toContain('license_bound_elsewhere');
    expect(printed, '卡密绝不进日志').not.toContain(LICENSE);
    expect(printed, '原始 message 绝不进日志（它可能回显卡密）').not.toContain(BOUND_ELSEWHERE_MESSAGE);
  });

  it('⭐⭐ 传输失败：日志里没有原始 message（异常文案可能带 URL / apikey / token）', async () => {
    const leaked = 'https://project.supabase.co/rest/v1/rpc/activate_license?apikey=anon-key-abc';
    mocks.rpc.mockRejectedValue(new Error(`fetch failed: ${leaked}`));

    const { fetchRelayKeyForLicense } = await import('../src/main/commercial/relay-startup.js');
    await fetchRelayKeyForLicense(LICENSE);

    const printed = printedLogs();
    expect(printed, '可重试这一类要说清楚').toContain('transport');
    expect(printed).not.toContain(leaked);
    expect(printed).not.toContain('anon-key-abc');
  });
});

/**
 * 整条链：**真实的**接线（`buildRelayBootstrapDeps`）+ **真实的**重试循环
 * （`bootstrapRelayWithRetry`）。
 *
 * 单测两层各自的分类还不够 —— 「4 分钟窗口里只发一次 activate_license」是
 * **两层合起来**才有的性质，所以这里用 rpc 的调用计数直接钉它。
 */
describe('整条链 —— 永久拒绝在 4 分钟窗口里只发一次 activate_license', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.getCommercialClient.mockReturnValue({ rpc: mocks.rpc, from: mocks.from });
    mocks.from.mockImplementation((table: string) => {
      if (table === 'org_members') return tableChain({ data: [{ org_id: 'org-1' }] });
      return tableChain({
        data: {
          license_key: LICENSE,
          sku: 'USB-标准版',
          status: 'active',
          expires_at: null,
          max_activations: 1,
          token_quota_micros: 5000,
          token_used_micros: 0,
        },
      });
    });
    mocks.rpc.mockResolvedValue({ data: { relayKey: RELAY_KEY }, error: null });
    mocks.probeAuth.mockResolvedValue('authenticated');
    mocks.drain.mockResolvedValue({ cleaned: false, pending: false });
    mocks.getAllGatewayClients.mockReturnValue(new Map());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** 真接线 + 假网关（`resolveDefaultModel` 关掉：本用例不关心默认模型，也不打 catalog）。 */
  async function realDeps() {
    const { buildRelayBootstrapDeps } = await import('../src/main/commercial/relay-startup.js');
    const gw = makeGateway();
    return { gw, deps: { ...buildRelayBootstrapDeps(), getGateway: () => gw.gateway, resolveDefaultModel: undefined } };
  }

  /**
   * 时钟**随 sleep 前进**。
   *
   * ⚠️ 别写 `now: () => 0`：那让 deadline 永远够不到 —— 一旦哪条分支落进
   *    `runtime-not-ready` 轮询，测试就变成真的死循环（第一版把 worker 跑到了 OOM）。
   */
  function advancingClock() {
    let t = 0;
    return {
      now: () => t,
      sleep: vi.fn(async (ms: number) => {
        t += ms;
      }),
    };
  }

  it('⭐⭐ 卡被服务端判定「绑在别的组织」⇒ rpc 恰好一次、零 sleep、安全码保留到结果', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: 'P0001', message: BOUND_ELSEWHERE_MESSAGE } });

    const { bootstrapRelayWithRetry } = await import('../src/main/commercial/relay-bootstrap.js');
    const { gw, deps } = await realDeps();
    const clock = advancingClock();

    const res = await bootstrapRelayWithRetry(deps, { ...clock, waitForGatewayMs: 240_000 });

    expect(mocks.rpc, '确定性拒绝 ⇒ 4 分钟窗口里绝不该再发一次 activate_license').toHaveBeenCalledTimes(1);
    expect(clock.sleep, '既不该轮询，也不该退避').not.toHaveBeenCalled();
    expect(res.status).toBe('entitlement-rejected');
    expect(res.errorCode).toBe('license_bound_elsewhere');
    expect(res.retryable).toBe(false);
    expect(res.relayReady).toBe(false);
    expect(gw.patchConfig, '没有 key 就绝不写网关配置').not.toHaveBeenCalled();
  });

  it('⭐⭐ 第一次超时（抛出）⇒ 走既有退避，第二次成功 ⇒ applied', async () => {
    mocks.rpc
      .mockRejectedValueOnce(new Error('fetch failed: ETIMEDOUT'))
      .mockResolvedValueOnce({ data: { relayKey: RELAY_KEY }, error: null });

    const { bootstrapRelayWithRetry } = await import('../src/main/commercial/relay-bootstrap.js');
    const { gw, deps } = await realDeps();
    const clock = advancingClock();

    const res = await bootstrapRelayWithRetry(deps, { ...clock, waitForGatewayMs: 240_000 });

    expect(mocks.rpc, '传输失败该再试一次').toHaveBeenCalledTimes(2);
    expect(clock.sleep, '走既有的有界退避（第一档 2s）').toHaveBeenCalledWith(2_000);
    expect(res.status).toBe('applied');
    expect(res.relayReady).toBe(true);
    expect(gw.patchConfig).toHaveBeenCalledTimes(1);
  });

  it('⭐ 负对照：网关还没连上根本不发 rpc（别把 unlicensed / runtime-not-ready 的责任推给服务端）', async () => {
    const { bootstrapRelayWithRetry } = await import('../src/main/commercial/relay-bootstrap.js');
    const { buildRelayBootstrapDeps } = await import('../src/main/commercial/relay-startup.js');
    const deps = { ...buildRelayBootstrapDeps(), getGateway: () => null, resolveDefaultModel: undefined };

    // ⚠️ 时钟必须**随 sleep 前进**：`now: () => 0` + 空 sleep 会让轮询永远够不到
    //    deadline —— 那不是"慢"，是真的死循环（第一版就把 worker 跑到 OOM 了）。
    const res = await bootstrapRelayWithRetry(deps, { ...advancingClock(), waitForGatewayMs: 1_000 });

    expect(res.status).toBe('runtime-not-ready');
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

/**
 * 编译期护栏（`pnpm typecheck:tests` 会真的跑它）。
 *
 * 两份闭集各写了一遍字面量：`license.ts` 的 `ActivationErrorCode` 与 relay 边界的
 * `RelayKeyFetchErrorCode`。少一个成员的后果是「边界层永远产不出那个码」——
 * runtime 不报错、lint 看不见，唯一护栏就是这条编译期断言。
 */
describe('errorCode 闭集的护栏', () => {
  it('⭐⭐ relay 边界的闭集必须覆盖 license.ts 的分类结果（编译期 + 运行期各钉一次）', async () => {
    expectTypeOf<ActivationErrorCode>().toExtend<RelayKeyFetchErrorCode>();

    // 运行期那一半：分类器**只会**吐出这七个码里的一个（词表写成可测常量，
    // 而不是散在注释里 —— 见 `docs/agent-rules` 里关于闭集清单的那条元规则）。
    const CODES: RelayKeyFetchErrorCode[] = [
      'license_bound_elsewhere',
      'license_not_found',
      'license_inactive',
      'license_expired',
      'activation_limit_reached',
      'activation_failed',
      'transport',
    ];
    const samples: Array<{ code?: string; message?: string }> = [
      { code: '23514', message: '激活数已达上限' },
      { code: 'P0001', message: BOUND_ELSEWHERE_MESSAGE },
      { code: 'P0001', message: 'license is suspended' },
      { code: 'P0001', message: 'license expired' },
      { code: 'P0002', message: 'no organization for user' },
      { code: 'P0002', message: 'license not found' },
      {},
    ];

    const { mapActivationError } = await import('../src/main/commercial/license.js');
    for (const sample of samples) {
      expect(CODES, `分类器吐出了闭集之外的码：${JSON.stringify(sample)}`).toContain(mapActivationError(sample));
    }
  });
});
