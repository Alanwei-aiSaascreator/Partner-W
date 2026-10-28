/**
 * C2（2026-10-10 基线审查 P1）：充值订单必须固化**当前应计费卡**。
 *
 * 旧链：下单不带目标（SQL 按最早 owner org + 履约按余额最大卡选），而扣费按
 * 当前卡（report_usage_v3 的 p_license_id）⇒ 钱可能加到另一张卡、当前卡继续 402。
 * 本测钉住桌面侧：两条下单路径都必须把解析出的 licenseId 作为 p_license_id 传给 RPC；
 * 解析不到当前卡时不发 RPC、直接失败（宁缺毋错，绝不拿别的卡凑目标）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = {
  license: { ok: true, result: { licenseId: 'LIC-TARGET' } } as {
    ok: boolean;
    result?: { licenseId: string | null };
  },
  rpcCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
  rpcError: null as { message: string } | null,
  /** 下单 RPC 回显的订单 jsonb。`amountCents` 缺省 = 老 SQL 不回显。 */
  rpcOrder: undefined as Record<string, unknown> | undefined,
};

vi.mock('../src/main/commercial/client.js', () => ({
  getCommercialClient: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ name, args });
      if (state.rpcError) return { data: null, error: state.rpcError };
      return { data: state.rpcOrder ?? { orderNo: 'RYTEST1' }, error: null };
    },
    auth: { getSession: async () => ({ data: { session: { access_token: 'fixture-token' } } }) },
  }),
}));
vi.mock('../src/main/commercial/license.js', () => ({
  readLicenseStatus: async () => state.license,
}));
vi.mock('../src/main/workspace/config.js', () => ({
  readConfig: () => undefined,
}));

import { createCustomRechargeOrder, createRechargeOrder } from '../src/main/commercial/payment.js';

beforeEach(() => {
  state.rpcCalls = [];
  state.rpcError = null;
  state.rpcOrder = undefined;
  state.license = { ok: true, result: { licenseId: 'LIC-TARGET' } };
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({ orderNo: 'RYTEST1', amountCents: 1000, payUrl: 'https://pay.example/x', expiresAt: null }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    ),
  );
});

describe('C2：充值订单固化当前应计费卡', () => {
  it('档位路径：p_license_id = 当前解析出的卡（与扣费身份一致）', async () => {
    const result = await createRechargeOrder('topup-10');
    expect(state.rpcCalls).toHaveLength(1);
    expect(state.rpcCalls[0]).toEqual({
      name: 'create_recharge_order',
      args: { p_sku: 'topup-10', p_license_id: 'LIC-TARGET' },
    });
    expect(result.ok).toBe(true);
  });

  it('自定义金额路径：同样必须带 p_license_id', async () => {
    // ⚠️ T08 金额对齐门之后，夹具必须自洽：请求 ¥12.34 ⇒ 收银台也必须回 ¥12.34
    //    （此前默认 fetch 回 ¥10.00，在旧实现下不会被发现）。断言**一字未改**。
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ orderNo: 'RYTEST1', amountCents: 1234, payUrl: 'https://pay.example/x', expiresAt: null }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      ),
    );
    const result = await createCustomRechargeOrder(1234);
    expect(state.rpcCalls).toHaveLength(1);
    expect(state.rpcCalls[0]).toEqual({
      name: 'create_recharge_order_custom',
      args: { p_amount_cents: 1234, p_license_id: 'LIC-TARGET' },
    });
    expect(result.ok).toBe(true);
  });

  it('解析不到当前卡 ⇒ 不发 RPC、明确失败（绝不拿别的卡凑目标）', async () => {
    state.license = { ok: true, result: { licenseId: null } };
    const result = await createRechargeOrder('topup-10');
    expect(state.rpcCalls).toHaveLength(0);
    expect(result).toEqual({
      ok: false,
      error: 'Recharge needs an active license target',
      errorCode: 'recharge_no_license_target',
    });
  });

  it('授权状态读取失败（ok=false）同样不发 RPC', async () => {
    state.license = { ok: false };
    const result = await createCustomRechargeOrder(500);
    expect(state.rpcCalls).toHaveLength(0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('recharge_no_license_target');
  });
});

/**
 * C2（R1 终审 §9，2026-10-10）：migration 58 的目标卡错误（raise 文案）必须被
 * classifyCreateError **逐条**映射成语义码 —— renderer 才能翻成可行动的本地化入口，
 * 而不是统一吞成"发起支付失败，请重试"。
 */
describe('§9：充值失败文案 → 语义码（renderer 可本地化）', () => {
  it.each([
    ['license target is expired', 'recharge_card_unavailable'],
    ['license target is not active', 'recharge_card_unavailable'],
    ['license target is not owned by this user', 'recharge_card_unavailable'],
    ['unknown license target', 'recharge_card_unavailable'],
    ['license target is required', 'recharge_no_license_target'],
    ['client-upgrade-required: recharge order must bind p_license_id', 'client_upgrade_required'],
  ])('%s ⇒ %s', async (message, errorCode) => {
    state.rpcError = { message };
    const result = await createRechargeOrder('topup-10');
    expect(state.rpcCalls).toHaveLength(1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe(errorCode);
  });

  it('自定义金额路径同样分类（不是只修档位路径）', async () => {
    state.rpcError = { message: 'license target is expired' };
    const result = await createCustomRechargeOrder(500);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('recharge_card_unavailable');
  });
});

/**
 * T08：**金额对齐门** —— 客户端只放行"三层金额一致"的那一笔。
 *
 * 定价权在服务端（档位路径从 `recharge_skus` 取、自定义路径收 `p_amount_cents`），
 * 客户端**不参与定价**。但要保证"界面上显示的金额"就是"订单/收银台里的金额"，
 * 否则用户会被引导去付一个他没同意的数。三层必须对齐：
 *   ① 用户请求（自定义路径的入参）；② 下单 RPC 回显的订单金额；③ 收银台返回的金额。
 * 任何一处不一致 ⇒ **拒绝**（不把 payUrl 交给界面）。
 */
describe('T08：金额对齐门（请求 / 订单 / 收银台 三层一致）', () => {
  const rpcEcho = (amountCents: unknown) => {
    state.rpcOrder = { orderNo: 'RYTEST1', amountCents };
  };
  const checkoutAmount = (amountCents: number) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ orderNo: 'RYTEST1', amountCents, payUrl: 'https://pay.example/x', expiresAt: null }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      ),
    );
  };

  it('⭐ 自定义金额：订单回显与请求一致 ⇒ 照常放行', async () => {
    rpcEcho(1234);
    checkoutAmount(1234);
    expect((await createCustomRechargeOrder(1234)).ok).toBe(true);
  });

  it('⭐⭐ 自定义金额：**订单回显与请求不一致** ⇒ 拒绝，且不交出 payUrl', async () => {
    rpcEcho(50000);
    checkoutAmount(50000);
    const result = await createCustomRechargeOrder(1234);
    expect(result).toMatchObject({ ok: false, errorCode: 'recharge_amount_mismatch' });
    expect(result).not.toHaveProperty('result');
  });

  it('⭐⭐ 自定义金额：**收银台金额与订单/请求不一致** ⇒ 同样拒绝', async () => {
    rpcEcho(1234);
    checkoutAmount(50000);
    expect(await createCustomRechargeOrder(1234)).toMatchObject({
      ok: false,
      errorCode: 'recharge_amount_mismatch',
    });
  });

  it('⭐⭐ 档位路径：订单回显与收银台不一致 ⇒ 拒绝（价签被改过也不能蒙混过关）', async () => {
    rpcEcho(1000);
    checkoutAmount(2000);
    expect(await createRechargeOrder('topup-10')).toMatchObject({
      ok: false,
      errorCode: 'recharge_amount_mismatch',
    });
  });

  it('⭐ 档位路径：订单回显与收银台一致 ⇒ 放行', async () => {
    rpcEcho(1000);
    checkoutAmount(1000);
    expect((await createRechargeOrder('topup-10')).ok).toBe(true);
  });

  it('⭐ 老 SQL 不回显金额（订单 jsonb 里没有 amountCents）⇒ 不因此误拦（只看收银台读数）', async () => {
    rpcEcho(undefined);
    checkoutAmount(1000);
    expect((await createRechargeOrder('topup-10')).ok).toBe(true);
  });

  it('⭐⭐ 收银台金额非法（0）⇒ 拒绝（绝不把"0 元"的收银台交给用户）', async () => {
    rpcEcho(1234);
    checkoutAmount(0);
    expect(await createCustomRechargeOrder(1234)).toMatchObject({
      ok: false,
      errorCode: 'recharge_amount_mismatch',
    });
  });
});
