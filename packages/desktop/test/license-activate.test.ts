import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rpcMock = vi.fn();
const getUserMock = vi.fn(async () => ({ data: { user: { id: 'user-1' } }, error: null }));
const getCommercialClientMock = vi.fn(() => ({ auth: { getUser: getUserMock }, rpc: rpcMock }));

vi.mock('../src/main/commercial/client.js', () => ({
  getCommercialClient: getCommercialClientMock,
}));

vi.mock('../src/main/workspace/config.js', () => ({
  ensureDeviceId: () => 'stable-device-id',
  readConfig: () => ({ commercial: { licenseKey: null } }),
  updateConfig: vi.fn(),
}));

vi.mock('../src/main/debug/index.js', () => ({
  initDebugLogger: vi.fn(),
  getDebugLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), flush: vi.fn() }),
}));

// 激活之后要把中转配置写进网关，所以网关模块必须被 mock ——
// 否则会去加载真实的 ws 层。
const getConfigMock = vi.fn();
const patchConfigMock = vi.fn();
const getAllGatewayClientsMock = vi.fn();

vi.mock('../src/main/ws/index.js', () => ({
  getAllGatewayClients: getAllGatewayClientsMock,
}));

/**
 * 一个可链式、也可直接 `await` 的 PostgREST 查询替身。
 *
 * ⚠️ 这个 mock 是补上来的：本文件原先只 mock 了 `rpc`，**没有 `from`** ——
 * 而 activateLicense 结尾会调 readLicenseStatus()，它要查表，
 * 于是每条用例都倒在 `supabase.from is not a function` 上。
 * 也就是说这个文件在补 mock 之前**一直是红的**（属于既存的失败用例），
 * 只是没人注意到 —— 因为激活主流程的断言在最后一行，先看到的是「激活失败」。
 */
function tableChain(result: unknown) {
  const node: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'order', 'limit', 'not', 'in', 'is', 'filter']) {
    node[method] = vi.fn(() => node);
  }
  node.maybeSingle = vi.fn(async () => result);
  node.single = vi.fn(async () => result);
  // 让链本身可以被 await（firstOwnerOrg 就是 await 到 .limit(1) 为止）
  node.then = (onFulfilled: (value: unknown) => unknown) => Promise.resolve(result).then(onFulfilled);
  return node;
}

const fromMock = vi.fn();

/**
 * 服务端的原话（**故意带卡密**）：本轮要保留的是它对应的**码**，
 * 界面只认 `errorCode`（`ActivationSection` 的 `ERROR_KEYS`），不依赖这段文案。
 */
const BOUND_ELSEWHERE_MESSAGE = 'activate_license: license RY-AAAA-BBBB is already bound to another organization';

/** 断言 ok:true；失败时把整个 payload 原样打出来 —— vitest 的属性 diff 会省略字段，不好排查。 */
function assertOk(res: unknown): void {
  if (!(res as { ok?: boolean } | null)?.ok) {
    throw new Error(`expected ok:true, got ${JSON.stringify(res)}`);
  }
}

describe('activateLicense', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    getCommercialClientMock.mockReturnValue({ auth: { getUser: getUserMock }, rpc: rpcMock, from: fromMock } as never);

    fromMock.mockImplementation((table: string) => {
      if (table === 'org_members') {
        return tableChain({
          data: [{ user_id: 'user-1', org_id: 'org-1', role: 'owner', joined_at: '2026-01-01T00:00:00Z' }],
          error: null,
        });
      }
      if (table === 'org_active_license') {
        return tableChain({
          data: [
            {
              id: 'license-1',
              org_id: 'org-1',
              license_key: 'RY-AAAA-BBBB',
              sku: 'USB-标准版',
              status: 'active',
              expires_at: null,
              issued_at: '2026-01-01T00:00:00Z',
              max_activations: 1,
              token_quota_micros: 5_000_000_000,
              token_used_micros: 0,
            },
          ],
          error: null,
        });
      }
      throw new Error(`unexpected table: ${table}`);
    });

    // 模拟一个「写入真的生效」的网关：patchConfig 之后 getConfig 能读回结果。
    let applied: Record<string, unknown> = {};
    getConfigMock.mockImplementation(async () => ({
      hash: `h${Object.keys(applied).length}`,
      config: applied,
      raw: '',
      path: '',
    }));
    patchConfigMock.mockImplementation(async (params: { raw: string }) => {
      applied = JSON.parse(params.raw) as Record<string, unknown>;
      return { ok: true };
    });
    getAllGatewayClientsMock.mockReturnValue(
      new Map([
        [
          'gw-1',
          {
            id: 'gw-1',
            isConnected: true,
            getConfig: getConfigMock,
            patchConfig: patchConfigMock,
            runConfigMutation: async <T>(
              work: (tx: { getConfig: typeof getConfigMock; patchConfig: typeof patchConfigMock }) => Promise<T>,
            ) => work({ getConfig: getConfigMock, patchConfig: patchConfigMock }),
          },
        ],
      ]),
    );

    rpcMock.mockResolvedValue({
      data: {
        licenseKey: 'RY-AAAA-BBBB',
        sku: 'USB-标准版',
        status: 'active',
        expiresAt: null,
        maxActivations: 1,
        tokenQuotaCents: 5000,
        tokenUsedCents: 0,
        relayKey: 'rly_TESTKEY',
      },
      error: null,
    });

    // 激活流程里会去拉一次 catalog 解析默认模型 —— 单元测试绝不打真网络。
    // 这里让它失败（拿不到模型），默认模型那一段自然跳过；
    // 那段逻辑本身在 relay-config.test.ts 里单独覆盖。
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, json: async () => ({}) })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls the activate_license rpc with the device fingerprint', async () => {
    const { activateLicense } = await import('../src/main/commercial/license.js');
    const res = await activateLicense('RY-AAAA-BBBB');

    expect(rpcMock).toHaveBeenCalledWith('activate_license', {
      p_license_key: 'RY-AAAA-BBBB',
      p_device_fingerprint: expect.any(String),
    });
    assertOk(res);
  });

  it('激活成功后把中转配置写进网关', async () => {
    const { activateLicense } = await import('../src/main/commercial/license.js');
    const res = await activateLicense('RY-AAAA-BBBB');

    expect(patchConfigMock).toHaveBeenCalledTimes(1);
    const written = JSON.parse((patchConfigMock.mock.calls[0]?.[0] as { raw: string }).raw) as {
      models: { providers: Record<string, { apiKey: string }> };
    };
    expect(written.models.providers.clawrouter?.apiKey).toBe('rly_TESTKEY');
    assertOk(res);
    expect(res.result?.relayConfigured).toBe(true);
  });

  it('激活时只按 relay 的逐卡 capabilities 接入视频能力', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/v1/capabilities')
          ? { ok: true, json: async () => ({ image: { enabled: false }, video: { enabled: true } }) }
          : { ok: false, status: 503, json: async () => ({}) },
      ),
    );

    const { activateLicense } = await import('../src/main/commercial/license.js');
    const res = await activateLicense('RY-AAAA-BBBB');

    assertOk(res);
    const written = JSON.parse((patchConfigMock.mock.calls[0]?.[0] as { raw: string }).raw) as {
      models: { providers: Record<string, { baseUrl?: string }> };
      agents: { defaults: { mediaModels: { video: { primary: string } } } };
    };
    expect(written.models.providers.xai?.baseUrl).toBe('https://api.rongyinghudong.com/relay/v1');
    expect(written.agents.defaults.mediaModels.video.primary).toBe('xai/grok-imagine-video');
    expect(written.models.providers.openai).toBeUndefined();
  });

  it('网关写失败**不影响激活成功** —— 授权已经绑好了，不该让用户重新激活', async () => {
    patchConfigMock.mockRejectedValue(new Error('invalid config: unknown field'));

    const { activateLicense } = await import('../src/main/commercial/license.js');
    const res = await activateLicense('RY-AAAA-BBBB');

    assertOk(res);
    expect(res.result?.relayConfigured).toBe(false);
  });

  it('rejects an empty key before hitting the network', async () => {
    const { activateLicense } = await import('../src/main/commercial/license.js');
    const res = await activateLicense('   ');

    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('empty_key');
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('maps the activation limit error to its own code', async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: '激活数已达上限' },
    });
    const { activateLicense } = await import('../src/main/commercial/license.js');
    const res = await activateLicense('RY-AAAA-BBBB');

    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('activation_limit_reached');
  });

  /**
   * ⭐ 分类器必须是**唯一**一份，而且**被导出**。
   *
   * 这是本轮要拆掉那次塌缩的关键一环：取中转 key 的边界（`relay-startup.ts`）
   * 原先没有任何分类 —— 服务端**确定性**的拒绝（卡已绑到别的组织 / 卡失效）被
   * 一律压成 `null`，上层于是只能报"没卡"。而激活入口这里早就有一张分得很细的表
   * （`mapActivationError`），只是它原先**是私有的** ⇒ 边界层用不上，早晚会各自
   * 再写一份 message 匹配，然后两边开始漂。
   *
   * ⇒ 钉两件事：它**被导出**（边界复用它），以及 `P0001 / already bound to another
   * organization` 这个码经 `activateLicense` **原样送到界面**（界面靠它说"这张卡绑在
   * 别的账号名下"，而不是泛化成"激活失败"）。
   */
  it('⭐⭐ 分类器被导出：relay 取 key 的边界复用同一份，不另写 message 匹配', async () => {
    const { mapActivationError } = await import('../src/main/commercial/license.js');

    expect(typeof mapActivationError, '未导出 ⇒ 边界层只能自己再写一份匹配，两边必将漂').toBe('function');
  });

  it('⭐⭐ P0001「已绑到别的组织」⇒ license_bound_elsewhere，并经 activateLicense 原样送到界面', async () => {
    const { activateLicense, mapActivationError } = await import('../src/main/commercial/license.js');

    expect(mapActivationError({ code: 'P0001', message: BOUND_ELSEWHERE_MESSAGE })).toBe('license_bound_elsewhere');

    rpcMock.mockResolvedValue({ data: null, error: { code: 'P0001', message: BOUND_ELSEWHERE_MESSAGE } });
    const res = await activateLicense('RY-AAAA-BBBB');

    expect(res.ok).toBe(false);
    expect(res.errorCode, '泛化成 activation_failed = 把"换个账号/先解绑"这条出口藏起来').toBe(
      'license_bound_elsewhere',
    );
  });

  /**
   * ⭐ P0002 那一支的**两个**出口各钉一次。
   *
   * P0002 同时盖住「这个用户没有组织」（账号本身坏了）与「卡号查不到」（卡的问题）——
   * 前者**不能**说成"你的卡不对"，否则用户会拿着好卡反复重试。这是一支三元表达式，
   * 只断言其中之一等于让它有一半可以悄悄退化。
   */
  it('⭐ P0002 的两支：没有组织 ⇒ activation_failed；卡查不到 ⇒ license_not_found', async () => {
    const { mapActivationError } = await import('../src/main/commercial/license.js');

    expect(mapActivationError({ code: 'P0002', message: 'no organization for user' })).toBe('activation_failed');
    expect(mapActivationError({ code: 'P0002', message: 'license key not found' })).toBe('license_not_found');
  });
});
