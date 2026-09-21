import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rpcMock = vi.fn();
const getCommercialClientMock = vi.fn(() => ({ rpc: rpcMock }));

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
    getCommercialClientMock.mockReturnValue({ rpc: rpcMock, from: fromMock } as never);

    fromMock.mockImplementation((table: string) => {
      if (table === 'org_members') return tableChain({ data: [{ org_id: 'org-1' }] });
      // licenses / org_active_license 都走 maybeSingle()，返回一行。
      return tableChain({
        data: {
          license_key: 'RY-AAAA-BBBB',
          sku: 'USB-标准版',
          status: 'active',
          expires_at: null,
          max_activations: 1,
          token_quota_cents: 5000,
          token_used_cents: 0,
        },
      });
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
});
