import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RelayKeyFetchErrorCode, RelayGatewayHandle } from '../src/main/commercial/relay-bootstrap.js';
import { advancingClock } from './helpers/advancing-clock.js';

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
 * - **传输失败**正相反：`transport` + `retryable`，交给既有退避。
 *   ⚠️ 传输失败在真库里是 **resolve**（`code === ''` / `status === 0`），不是 throw ——
 *   判据见下面 `SHAPE_*` 那张实测表；把它兜进分类器会让网络抖动变成"卡被拒绝"。
 *
 * ## 日志纪律
 *
 * 结构化日志里**只能**出现 SQLSTATE 与安全码 —— **本文件覆盖的是结构化中继路径**。
 * 原始 message 不进：服务端的文案可能回显卡密（`activate_license` 的入参就是卡密），
 * 异常文案里还可能带 URL 与 token。（手动激活那条 IPC 路径刻意仍把原文给界面看，
 * 见 `license.ts` 的口径说明 —— 这里别写成全局承诺。）
 */

const LICENSE = 'RY-TEST-0001';
const RELAY_KEY = 'rly_test_key_should_never_be_logged';
/** 服务端文案里**故意**带上卡密：这正是「别把原始 message 写进日志」的理由。 */
const BOUND_ELSEWHERE_MESSAGE = `activate_license: license ${LICENSE} is already bound to another organization`;

/**
 * ⭐ 真库的形状（2026-09-21 在钉住的 `@supabase/supabase-js@2.116.0` /
 * `postgrest-js@2.116.0` 上实测，不是推理 —— 探针见报告）。
 *
 * `PostgrestBuilder.then` 装了 `.catch`，而 `shouldThrowOnError` 默认 false、
 * 全仓无人调 `.throwOnError()` ⇒ **fetch 失败 / 超时 / 502 全都是 resolve**，
 * 只有 `error` 不同：
 *
 * | 场景 | 结果 | `error.code` | 响应 `status` |
 * |---|---|---|---|
 * | `TypeError: fetch failed`（连接被拒） | resolve | `''` | `0` |
 * | 被 `AbortSignal.timeout` 中止（生产正是这条路） | resolve | `''` | `0` |
 * | 代理返回 502 HTML | resolve | **没有这个键** | `502` |
 * | 400 + JSON `{code:'P0001'}`（对照组） | resolve | `'P0001'` | `400` |
 *
 * ⚠️ `status` 在**响应**上，不在 `error` 对象里（实测 `error` 的键只有
 * `message/details/hint/code`）—— 所以判据要读响应那个 `status`。
 * ⚠️ 用 `mockRejectedValue` 钉"网络失败"是**真库不会发生的形状**（第一版就栽在这）。
 */
const SHAPE_FETCH_FAILED = {
  data: null,
  error: { message: 'TypeError: fetch failed', code: '', hint: '', details: '' },
  status: 0,
};
const SHAPE_ABORTED_TIMEOUT = {
  data: null,
  error: {
    message: 'TimeoutError: The operation was aborted due to timeout',
    code: '',
    hint: 'Request was aborted',
    details: '',
  },
  status: 0,
};
const SHAPE_HTML_502 = { data: null, error: { message: '<html><body>502 Bad Gateway</body></html>' }, status: 502 };

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
    // ⚠️ `clearAllMocks()` **不清** `mockResolvedValueOnce` 那种一次性队列：红着的用例
    //    如果没把排队的值消费完，剩下的会漏给**下一个**用例（实测：一条按预期红掉的
    //    用例让后一条"硬抛"用例只被调了一次）。`mockReset()` 会把队列一起清掉。
    mocks.rpc.mockReset();
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
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: 'P0001', message: BOUND_ELSEWHERE_MESSAGE },
      status: 400,
    });

    const { fetchRelayKeyForLicense } = await import('../src/main/commercial/relay-startup.js');

    await expect(fetchRelayKeyForLicense(LICENSE)).resolves.toEqual({
      ok: false,
      errorCode: 'license_bound_elsewhere',
      retryable: false,
    });
  });

  it('⭐ 其它确定性拒绝走**同一张**分类表（激活数已达上限 = 23514）', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: '23514', message: '激活数已达上限' }, status: 400 });

    const { fetchRelayKeyForLicense } = await import('../src/main/commercial/relay-startup.js');

    await expect(fetchRelayKeyForLicense(LICENSE)).resolves.toEqual({
      ok: false,
      errorCode: 'activation_limit_reached',
      retryable: false,
    });
  });

  /**
   * ⭐⭐ 真库形状：**完成但失败**的传输尝试。
   *
   * postgrest-js 把 fetch 失败/超时**返回**（resolve）成 `code === ''` / `status === 0`，
   * 而不是抛。这些**不是**"服务端拒绝了这张卡"，而是"这次没问出来" ⇒ 必须可重试。
   * 判据：**确定性的服务端拒绝一定带 SQLSTATE**（迁移 56 的 P0001/P0002/23514/28000），
   * 传输类没有码、或 `status === 0`。
   */
  it('⭐⭐ 真库形状①：被中止（超时）⇒ resolve 出 code:"" + status:0 ⇒ transport 可重试', async () => {
    mocks.rpc.mockResolvedValue(SHAPE_ABORTED_TIMEOUT);

    const { fetchRelayKeyForLicense } = await import('../src/main/commercial/relay-startup.js');

    await expect(fetchRelayKeyForLicense(LICENSE)).resolves.toEqual({
      ok: false,
      errorCode: 'transport',
      retryable: true,
    });
  });

  it('⭐⭐ 真库形状②：HTML-502（error 里只有 message、**没有** code）⇒ transport 可重试', async () => {
    mocks.rpc.mockResolvedValue(SHAPE_HTML_502);

    const { fetchRelayKeyForLicense } = await import('../src/main/commercial/relay-startup.js');

    await expect(fetchRelayKeyForLicense(LICENSE)).resolves.toEqual({
      ok: false,
      errorCode: 'transport',
      retryable: true,
    });
  });

  /**
   * ⭐⭐ 裁决白名单：**只有**迁移 56 / 触发器里故意 raise 的那几个码才算"服务端拒绝了这张卡"。
   *
   * 迁移 56 在卡行上 `for update` + `delete … offset` ⇒ 同一张卡的并发本来就会制造锁等待，
   * 所以 `57014`（statement_timeout）/ `55P03`（lock_not_available）/ `40P01`（deadlock）/
   * `08006`（connection_failure）/ `53300`（too_many_connections）这些**带 code** 的失败
   * 恰恰是"再试一次就会好"的那些 —— 被判成终态就是把网络/并发问题说成"这张卡不行"。
   */
  it('⭐⭐ 非裁决 SQLSTATE（57014 语句超时 / 53300 连接数满 / 08006 连接失败）⇒ transport 可重试', async () => {
    const { fetchRelayKeyForLicense } = await import('../src/main/commercial/relay-startup.js');
    const shapes = [
      { code: '57014', status: 500, message: 'canceling statement due to statement timeout' },
      { code: '53300', status: 503, message: 'sorry, too many clients already' },
      { code: '08006', status: 502, message: 'connection failure' },
    ];

    for (const shape of shapes) {
      mocks.rpc.mockResolvedValue({
        data: null,
        error: { code: shape.code, message: shape.message },
        status: shape.status,
      });
      await expect(fetchRelayKeyForLicense(LICENSE), `${shape.code} 是"这次没成"，不是"这张卡不行"`).resolves.toEqual({
        ok: false,
        errorCode: 'transport',
        retryable: true,
      });
    }
  });

  it('⭐⭐ 真库形状③：fetch failed（连接被拒）⇒ transport 可重试，不是泛化的激活失败', async () => {
    mocks.rpc.mockResolvedValue(SHAPE_FETCH_FAILED);

    const { fetchRelayKeyForLicense } = await import('../src/main/commercial/relay-startup.js');

    await expect(fetchRelayKeyForLicense(LICENSE)).resolves.toEqual({
      ok: false,
      errorCode: 'transport',
      retryable: true,
    });
  });

  it('⭐ 硬抛（postgrest 之外的层抛，例如同步异常/未来换传输层）⇒ 同样是可重试的 transport', async () => {
    // ⚠️ 真库里 fetch 失败是 **resolve** 的（见上面三条真库形状用例）。这一条守的是
    //    `catch` 分支本身：边界函数**不该抛**，但真抛了也不能被压成终态。
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

  it('⭐ 边界自己：没有商业客户端时**不编卡的错**（不是 activation_failed）', async () => {
    mocks.getCommercialClient.mockReturnValue(null);

    const { fetchRelayKeyForLicense } = await import('../src/main/commercial/relay-startup.js');
    const res = await fetchRelayKeyForLicense(LICENSE);

    // 这一层没有能表达"没配置"的码（也不**新增**公开码）⇒ 归到既有的 transport
    // （"这次没问出来"），绝不返回 `activation_failed`（那会渲染成"你的卡不行"）。
    // 生产路径上它不会露头：`hasCommercialClient()` 与这里是同一个判据，
    // 那道门在前面就已经把它收成 `not-configured`（见下一条）。
    expect(res).toEqual({ ok: false, errorCode: 'transport', retryable: true });
  });

  it('⭐⭐ 本地商业后端缺失 ⇒ 系统报 not-configured（**不是**卡的问题，也不是激活失败）', async () => {
    // ⚠️ 这一条在 2026-09-21 改过：边界原先给这个分支编了个 `activation_failed` ——
    //    那会被渲染成"激活失败"，拿用户的开卡说事，而真实原因是**这台机器没接商业层**。
    //    `activate_license` 这一层没有任何码能表达"没配置"（也不该新增公开码）⇒ 语义由
    //    `ensureRelayConfigured` 开头那道 `hasCommercialClient()` 门表达：`not-configured`。
    mocks.getCommercialClient.mockReturnValue(null);

    const { bootstrapRelayWithRetry } = await import('../src/main/commercial/relay-bootstrap.js');
    const { buildRelayBootstrapDeps } = await import('../src/main/commercial/relay-startup.js');
    const res = await bootstrapRelayWithRetry(
      { ...buildRelayBootstrapDeps(), resolveDefaultModel: undefined },
      { ...advancingClock(), waitForGatewayMs: 1_000 },
    );

    expect(res.status).toBe('not-configured');
    expect(res.retryable).toBe(false);
    expect(mocks.rpc, '没接商业层 ⇒ 一个字节都不该往后端发').not.toHaveBeenCalled();
  });
});

describe('日志卫生 —— SQLSTATE 与安全码进日志，卡密/原始文案不进', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    // ⚠️ `clearAllMocks()` **不清** `mockResolvedValueOnce` 那种一次性队列：红着的用例
    //    如果没把排队的值消费完，剩下的会漏给**下一个**用例（实测：一条按预期红掉的
    //    用例让后一条"硬抛"用例只被调了一次）。`mockReset()` 会把队列一起清掉。
    mocks.rpc.mockReset();
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
    // ⚠️ `clearAllMocks()` **不清** `mockResolvedValueOnce` 那种一次性队列：红着的用例
    //    如果没把排队的值消费完，剩下的会漏给**下一个**用例（实测：一条按预期红掉的
    //    用例让后一条"硬抛"用例只被调了一次）。`mockReset()` 会把队列一起清掉。
    mocks.rpc.mockReset();
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
   * 时钟**随 sleep 前进**（`test/helpers/advancing-clock.ts`）。
   *
   * ⚠️ 别写 `now: () => 0`：那让 deadline 永远够不到 —— 一旦哪条分支落进
   *    `runtime-not-ready` 轮询，测试就变成真的死循环（第一版把 worker 跑到了 OOM）。
   */

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

  /**
   * ⭐⭐ C1 的核心：**完成但失败**的传输尝试不得变成终态。
   *
   * 真库里 fetch 失败/超时是 resolve（`code === ''`、`status === 0`），不是 throw。
   * 若把它兜进分类器，就会落成 `activation_failed` ⇒ `entitlement-rejected` +
   * `retryable:false`：用户看到"这张卡不行"，而其实只是网络抖了一下、而且再试一次
   * 就会好。三条断言把"不得是终态"钉死：既不能是 `entitlement-rejected`，
   * 也不能 `retryable:false`，还必须落在既有退避会重试的那个状态上。
   */
  it('⭐⭐ 完成但失败的传输尝试不得变成终态（不是 entitlement-rejected、也不带 retryable:false）', async () => {
    mocks.rpc.mockResolvedValue(SHAPE_FETCH_FAILED);

    const { ensureRelayConfigured } = await import('../src/main/commercial/relay-bootstrap.js');
    const { gw, deps } = await realDeps();

    const res = await ensureRelayConfigured(deps);

    expect(res.status, '一次网络抖动绝不是"卡被拒绝"').not.toBe('entitlement-rejected');
    expect(res.status).toBe('auth-transient');
    expect(res.retryable, '可重试这一类必须能被重试循环捞起来').toBe(true);
    expect(res.errorCode).toBe('transport');
    expect(res.relayReady).toBe(false);
    expect(gw.patchConfig, '没有 key 就绝不写网关配置').not.toHaveBeenCalled();
  });

  /**
   * ⭐ 裁决白名单的**系统级**后果：带 code 的"非裁决"失败不得被渲染成卡的问题。
   *
   * 迁移 56 的 `activate_license` 在卡行上 `for update` 并 `delete … offset` ——
   * 同一张卡的并发会制造锁等待，超时（`57014`）与连接层失败（`53300`/`08006`）都是
   * **重试一次就会好**的那一类。判成终态等于告诉用户"这张卡不行"。
   */
  it('⭐ 库存锁等待超时（57014）不得变成卡的问题', async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: '57014', message: 'canceling statement due to statement timeout' },
      status: 500,
    });

    const { ensureRelayConfigured } = await import('../src/main/commercial/relay-bootstrap.js');
    const { gw, deps } = await realDeps();

    const res = await ensureRelayConfigured(deps);

    expect(res.status, '并发拿不到锁、语句超时 —— 那是"再试一次会好"').not.toBe('entitlement-rejected');
    expect(res.status).toBe('auth-transient');
    expect(res.retryable).toBe(true);
    expect(res.errorCode).toBe('transport');
    expect(res.relayReady).toBe(false);
    expect(gw.patchConfig, '没有 key 就绝不写网关配置').not.toHaveBeenCalled();
  });

  it('⭐ 连接池/连接失败（53300 / 08006）不得变成卡的问题', async () => {
    const { ensureRelayConfigured } = await import('../src/main/commercial/relay-bootstrap.js');

    for (const shape of [
      { code: '53300', status: 503, message: 'sorry, too many clients already' },
      { code: '08006', status: 502, message: 'connection failure' },
    ]) {
      mocks.rpc.mockResolvedValue({
        data: null,
        error: { code: shape.code, message: shape.message },
        status: shape.status,
      });
      const { gw, deps } = await realDeps();

      const res = await ensureRelayConfigured(deps);

      expect(res.status, `${shape.code} 是连接层失败，不是卡的问题`).not.toBe('entitlement-rejected');
      expect(res.status).toBe('auth-transient');
      expect(res.retryable).toBe(true);
      expect(gw.patchConfig).not.toHaveBeenCalled();
    }
  });

  it('⭐⭐ 真库形状：第一次传输失败、第二次成功 ⇒ 走既有退避并 applied', async () => {
    mocks.rpc
      .mockResolvedValueOnce(SHAPE_ABORTED_TIMEOUT)
      .mockResolvedValueOnce({ data: { relayKey: RELAY_KEY }, error: null, status: 200 });

    const { bootstrapRelayWithRetry } = await import('../src/main/commercial/relay-bootstrap.js');
    const { gw, deps } = await realDeps();
    const clock = advancingClock();

    const res = await bootstrapRelayWithRetry(deps, { ...clock, waitForGatewayMs: 240_000 });

    expect(res.status, '传输类失败一次之后**必须**还能恢复').toBe('applied');
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    expect(clock.sleep, '走既有的有界退避（第一档 2s）').toHaveBeenCalledWith(2_000);
    expect(gw.patchConfig).toHaveBeenCalledTimes(1);
  });

  it('⭐⭐ 第一次超时（硬抛）⇒ 走既有退避，第二次成功 ⇒ applied', async () => {
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
 * errorCode 闭集的护栏。
 *
 * ## 真正在守什么（2026-09-21 更正）
 *
 * 第一版这里写的是 `expectTypeOf<ActivationErrorCode>().toExtend<RelayKeyFetchErrorCode>()`，
 * 并声称它在防"两份闭集漂掉" —— **那是同义反复**：`RelayKeyFetchErrorCode` 就是
 * `ActivationErrorCode | 'transport'` 派生的，这条断言恒真，删掉成员也不会红
 * （`relay-bootstrap.ts` 里"宁可要类型依赖"那段注释说的就是这个派生关系）。
 *
 * 真正会漂的是**这份字面量清单**：`Record<RelayKeyFetchErrorCode, true>` 要求
 * 恰好覆盖联合的每一个成员 ——
 *   · 联合**少**一个成员 ⇒ 这里多一个键 ⇒ 编译失败；
 *   · 联合**多**一个成员 ⇒ 这里少一个键 ⇒ 编译失败。
 * 配合运行期那半句（分类器的**每一个**输出都必须落在这份清单里），两头都封住了。
 *
 * 来源：`license.ts` 的 `ActivationErrorCode`（服务端拒绝的分类结果）+ 本地归类的
 * `transport`；两边都不能是开放集（见 `docs/agent-rules` 的闭集元规则）。
 */
describe('errorCode 闭集的护栏', () => {
  it('⭐⭐ 闭集字面量清单：增删成员都会**编译失败**，且分类器只会吐出清单里的码', async () => {
    const ALL: Record<RelayKeyFetchErrorCode, true> = {
      license_bound_elsewhere: true,
      license_not_found: true,
      license_inactive: true,
      license_expired: true,
      activation_limit_reached: true,
      activation_failed: true,
      transport: true,
    };

    const samples: Array<{ code?: string; message?: string }> = [
      { code: '23514', message: '激活数已达上限' },
      { code: 'P0001', message: BOUND_ELSEWHERE_MESSAGE },
      { code: 'P0001', message: 'license is suspended' },
      { code: 'P0001', message: 'license expired' },
      { code: 'P0002', message: 'no organization for user' },
      { code: 'P0002', message: 'license not found' },
      { code: 'P0002', message: 'license key not found' },
      {},
    ];

    const { mapActivationError } = await import('../src/main/commercial/license.js');
    for (const sample of samples) {
      const code = mapActivationError(sample);
      expect(ALL[code], `分类器吐出了闭集之外的码：${code}（${JSON.stringify(sample)}）`).toBe(true);
    }
  });
});
