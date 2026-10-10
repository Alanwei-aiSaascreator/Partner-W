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
};

vi.mock('../src/main/commercial/client.js', () => ({
  getCommercialClient: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ name, args });
      if (state.rpcError) return { data: null, error: state.rpcError };
      return { data: { orderNo: 'RYTEST1' }, error: null };
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
