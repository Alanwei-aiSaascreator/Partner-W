import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 统计页服务端数据源的聚合逻辑。
 *
 * 这里锁几件容易静默出错的事：
 *
 *   ① **PostgREST 把 bigint 序列化成字符串**。微积分是 1e-6 分，量级本来就大，
 *      不显式 Number() 的话 `acc += row.cost_micros` 会变成**字符串拼接** ——
 *      结果是 NaN 或者一个天文数字，而且不会有任何报错。
 *
 *   ② **同一模型的跨天行必须合并，不同模型必须分开** —— 这正是
 *      「用户从 qwen-plus 切到 kimi-k3，仪表板分两行」那条需求的落点。
 *
 *   ③ **M4 透明计费的口径边界**（迁移 32）：
 *      · actual cost 只累加账本列，**不重算**；
 *      · 官方参考费用只累加**算得出**的那些，覆盖不全时不许冒充总额；
 *      · 价目标量只在**窗口内只有一档**时才给值，多档必须置 null；
 *      · 历史行没有快照 ⇒ 相关字段 null，**不是 0**；
 *      · 实际结算倍率只在**覆盖完整**时才算（分子分母必须同一批记录）。
 */

const fromMock = vi.fn();
const getUserMock = vi.fn();

vi.mock('../src/main/commercial/client.js', () => ({
  getCommercialClient: () => ({ from: fromMock, auth: { getUser: getUserMock } }),
}));

vi.mock('../src/main/commercial/auth.js', () => ({
  readSessionState: async () => ({
    ok: true,
    result: {
      signedIn: true,
      profile: { userId: 'u1', email: null, phone: null, nickname: null, avatar: null },
      orgs: [{ id: 'org-1', name: 'org', slug: 'org', plan: 'pro', role: 'owner' }],
    },
  }),
}));

import { readServerUsage } from '../src/main/stats/usage-from-server.js';

/** 可链式、也可 await 的 PostgREST 查询替身。 */
function tableChain(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  chain.select = self;
  chain.eq = self;
  chain.gte = self;
  chain.limit = self;
  chain.maybeSingle = async () => result;
  (chain as { then?: unknown }).then = (resolve: (v: unknown) => unknown) => resolve(result);
  return chain;
}

function mockTables(byModel: unknown[], byDay: unknown[]) {
  fromMock.mockImplementation((table: string) => {
    if (table === 'usage_billing_by_model') return tableChain({ data: byModel, error: null });
    if (table === 'usage_daily_by_org') return tableChain({ data: byDay, error: null });
    throw new Error('unexpected table: ' + table);
  });
}

/**
 * 一行 `usage_billing_by_model` 的替身。
 *
 * 默认值是「一笔**没有**任何快照的历史行」：这正是历史 v1 行的形状，
 * 逼着每条新测试显式声明自己关心哪一档。要造 v2 行请用 `v2Row()`。
 */
function row(over: Record<string, unknown> = {}) {
  return {
    day: '2026-09-12',
    provider: 'bailian',
    model: 'm1',
    calls: 1,
    input_tokens: 0,
    output_tokens: 0,
    cached_tokens: 0,
    total_tokens: 0,
    actual_cost_micros: 0,
    calls_with_snapshot: 0,
    official_reference_covered_calls: 0,
    official_reference_cost_micros: null,
    official_reference_complete: false,
    pricing_variants: 0,
    pricing_rule_revision: null,
    official_cache_pricing_mode: null,
    official_input_yuan_per_mtok: null,
    official_output_yuan_per_mtok: null,
    official_cached_yuan_per_mtok: null,
    billing_multiplier_ppm: null,
    billed_input_cents_per_mtok: null,
    billed_output_cents_per_mtok: null,
    billed_cached_cents_per_mtok: null,
    ...over,
  };
}

/** 一档「正常」的 v2 价目快照（官方 1/0.2/2 元、售价 1.6/0.32/3.2 元、1.6×）。 */
const V2_TIER = {
  calls_with_snapshot: 1,
  official_reference_covered_calls: 1,
  official_reference_complete: true,
  pricing_variants: 1,
  pricing_rule_revision: 'rev-a',
  official_cache_pricing_mode: 'implicit_hit',
  official_input_yuan_per_mtok: 1,
  official_output_yuan_per_mtok: 2,
  official_cached_yuan_per_mtok: 0.2,
  billing_multiplier_ppm: 1600000,
  billed_input_cents_per_mtok: 160,
  billed_output_cents_per_mtok: 320,
  billed_cached_cents_per_mtok: 32,
};

beforeEach(() => {
  fromMock.mockReset();
});

describe('readServerUsage', () => {
  it('⭐ bigint 以字符串返回时被转成数字，不是字符串拼接', async () => {
    mockTables(
      [
        row({
          model: 'deepseek-v4-flash',
          calls: '3',
          input_tokens: '1000',
          output_tokens: '2000',
          cached_tokens: '0',
          total_tokens: '3000',
          // 6.1e9 远超 int4，PostgREST 会序列化成字符串
          actual_cost_micros: '6100000000',
        }),
      ],
      [{ day: '2026-09-12', input_tokens: '1000', output_tokens: '2000', cost_micros: '6100000000' }],
    );

    const out = await readServerUsage();
    expect(out).not.toBeNull();
    expect(out!.models).toHaveLength(1);
    expect(out!.models[0].costMicros).toBe(6_100_000_000);
    expect(out!.models[0].totalTokens).toBe(3000);
    expect(out!.models[0].calls).toBe(3);
    expect(out!.totals.costMicros).toBe(6_100_000_000);
  });

  it('⭐ 同一模型跨天合并成一行', async () => {
    mockTables(
      [
        row({ day: '2026-09-10', calls: 1, input_tokens: 100, total_tokens: 100, actual_cost_micros: 500 }),
        row({ day: '2026-09-11', calls: 2, input_tokens: 300, total_tokens: 300, actual_cost_micros: 1500 }),
      ],
      [],
    );

    const out = await readServerUsage();
    expect(out!.models).toHaveLength(1);
    expect(out!.models[0].costMicros).toBe(2000);
    expect(out!.models[0].totalTokens).toBe(400);
    expect(out!.models[0].calls).toBe(3);
  });

  it('⭐ 不同模型分成两行，按消耗降序', async () => {
    mockTables(
      [
        row({ model: 'cheap', actual_cost_micros: 100, total_tokens: 1 }),
        row({ model: 'pricey', actual_cost_micros: 9000, total_tokens: 1 }),
      ],
      [],
    );

    const out = await readServerUsage();
    expect(out!.models.map((m) => m.model)).toEqual(['pricey', 'cheap']);
  });

  it('同一模型名分属两个 provider 时不合并（否则价格会串）', async () => {
    mockTables(
      [
        row({ provider: 'bailian', model: 'same', actual_cost_micros: 100, total_tokens: 1 }),
        row({ provider: 'ark', model: 'same', actual_cost_micros: 200, total_tokens: 1 }),
      ],
      [],
    );

    const out = await readServerUsage();
    expect(out!.models).toHaveLength(2);
    expect(out!.models.map((m) => m.provider).sort()).toEqual(['ark', 'bailian']);
  });

  it('按天的查询挂了也不让整个板块消失 —— 用按模型那份重算总计', async () => {
    fromMock.mockImplementation((table: string) => {
      if (table === 'usage_billing_by_model') {
        return tableChain({
          data: [row({ calls: 1, input_tokens: 10, output_tokens: 20, total_tokens: 30, actual_cost_micros: 700 })],
          error: null,
        });
      }
      return tableChain({ data: null, error: { message: 'boom' } });
    });

    const out = await readServerUsage();
    expect(out).not.toBeNull();
    expect(out!.totals.costMicros).toBe(700);
    expect(out!.daily).toEqual([]);
  });

  it('按模型的查询挂了 → 返回 null 让上层降级', async () => {
    fromMock.mockImplementation(() => tableChain({ data: null, error: { message: 'boom' } }));
    expect(await readServerUsage()).toBeNull();
  });

  it('一次调用都没有 → 空数组，不是 null（两者含义不同）', async () => {
    mockTables([], []);
    const out = await readServerUsage();
    expect(out).not.toBeNull();
    expect(out!.models).toEqual([]);
    expect(out!.totals.costMicros).toBe(0);
  });
});

describe('readServerUsage —— M4 透明计费口径', () => {
  it('⭐ 历史行（无快照）⇒ 官方相关字段全 null，不是 0', async () => {
    mockTables([row({ actual_cost_micros: 123456, calls: 1 })], []);

    const m = (await readServerUsage())!.models[0];
    expect(m.costMicros).toBe(123456); // 账本事实照常可用
    expect(m.officialInputYuanPerMtok).toBeNull();
    expect(m.officialOutputYuanPerMtok).toBeNull();
    expect(m.officialCachePricingMode).toBeNull();
    expect(m.targetMultiplier).toBeNull();
    expect(m.saleInputYuanPerMtok).toBeNull();
    expect(m.officialReferenceCostMicros).toBeNull(); // **不是 0**
    expect(m.officialReferenceComplete).toBe(false);
    expect(m.effectiveMultiplier).toBeNull();
    expect(m.settledCalls).toBe(1);
    expect(m.officialReferenceCoveredCalls).toBe(0);
  });

  it('⭐ 单档 v2 行：价目按原单位暴露（官方 元/Mtok、售价 分→元 换算）', async () => {
    mockTables([row({ ...V2_TIER, actual_cost_micros: 160000, official_reference_cost_micros: 100000 })], []);

    const m = (await readServerUsage())!.models[0];
    expect(m.officialInputYuanPerMtok).toBe(1);
    expect(m.officialCachedYuanPerMtok).toBe(0.2);
    expect(m.officialOutputYuanPerMtok).toBe(2);
    // 售价账本列是「分/百万 token」，展示口径统一成元 ⇒ 必须 ÷100
    expect(m.saleInputYuanPerMtok).toBeCloseTo(1.6, 10);
    expect(m.saleCachedYuanPerMtok).toBeCloseTo(0.32, 10);
    expect(m.saleOutputYuanPerMtok).toBeCloseTo(3.2, 10);
    // 倍率账本列是 ppm ⇒ 必须 ÷1e6
    expect(m.targetMultiplier).toBeCloseTo(1.6, 10);
    expect(m.pricingVariants).toBe(1);
    expect(m.pricingMixed).toBe(false);
    expect(m.officialReferenceComplete).toBe(true);
    expect(m.effectiveMultiplier).toBeCloseTo(1.6, 10);
  });

  it('⭐ expected：跨天同一档价目 ⇒ 仍算「一档」，不误报多档', async () => {
    mockTables(
      [
        row({ ...V2_TIER, day: '2026-09-10', actual_cost_micros: 100000, official_reference_cost_micros: 60000 }),
        row({ ...V2_TIER, day: '2026-09-11', actual_cost_micros: 100000, official_reference_cost_micros: 60000 }),
      ],
      [],
    );

    const m = (await readServerUsage())!.models[0];
    expect(m.pricingVariants).toBe(1);
    expect(m.pricingMixed).toBe(false);
    expect(m.officialInputYuanPerMtok).toBe(1);
    expect(m.settledCalls).toBe(2);
    expect(m.officialReferenceCoveredCalls).toBe(2);
    expect(m.officialReferenceCostMicros).toBe(120000);
    expect(m.officialReferenceComplete).toBe(true);
  });

  it('⭐ 窗口内调过价 ⇒ 标量价目置 null 且 pricingMixed，不拿其中一档冒充', async () => {
    mockTables(
      [
        row({ ...V2_TIER, day: '2026-09-10', actual_cost_micros: 100, official_reference_cost_micros: 60 }),
        row({
          ...V2_TIER,
          day: '2026-09-11',
          pricing_rule_revision: 'rev-b',
          official_input_yuan_per_mtok: 2,
          billed_input_cents_per_mtok: 320,
          actual_cost_micros: 100,
          official_reference_cost_micros: 60,
        }),
      ],
      [],
    );

    const m = (await readServerUsage())!.models[0];
    expect(m.pricingMixed).toBe(true);
    expect(m.pricingVariants).toBe(2);
    expect(m.officialInputYuanPerMtok).toBeNull();
    expect(m.saleInputYuanPerMtok).toBeNull();
    expect(m.targetMultiplier).toBeNull();
    // 金额仍然照常累加 —— 多档只影响「标量价目」，不影响账本事实与官方参考
    expect(m.costMicros).toBe(200);
    expect(m.officialReferenceCostMicros).toBe(120);
  });

  it('⭐ 某一天内部就多档（视图已置 null）⇒ 也要标记 mixed', async () => {
    mockTables(
      [
        row({
          ...V2_TIER,
          pricing_variants: 2,
          pricing_rule_revision: null,
          official_input_yuan_per_mtok: null,
          billed_input_cents_per_mtok: null,
          actual_cost_micros: 100,
          official_reference_cost_micros: 60,
        }),
      ],
      [],
    );

    const m = (await readServerUsage())!.models[0];
    expect(m.pricingMixed).toBe(true);
    expect(m.officialInputYuanPerMtok).toBeNull();
    expect(m.costMicros).toBe(100);
  });

  it('⭐ 覆盖不全 ⇒ 官方参考费用只是「已覆盖部分」，且**不给**实际结算倍率', async () => {
    mockTables(
      [
        row({
          ...V2_TIER,
          calls: 3,
          calls_with_snapshot: 2,
          official_reference_covered_calls: 1,
          official_reference_complete: false,
          actual_cost_micros: 300,
          official_reference_cost_micros: 100,
        }),
      ],
      [],
    );

    const m = (await readServerUsage())!.models[0];
    expect(m.settledCalls).toBe(3);
    expect(m.officialReferenceCoveredCalls).toBe(1);
    expect(m.officialReferenceComplete).toBe(false);
    expect(m.officialReferenceCostMicros).toBe(100); // 只累加算得出的
    // 分子分母不是同一批记录 ⇒ 宁可 null，也不给混合口径的比值
    expect(m.effectiveMultiplier).toBeNull();
  });

  it('⭐ 一笔都算不出官方参考 ⇒ 费用 null，不是 0', async () => {
    mockTables(
      [row({ calls: 2, actual_cost_micros: 500, official_reference_cost_micros: null, calls_with_snapshot: 2 })],
      [],
    );

    const m = (await readServerUsage())!.models[0];
    expect(m.officialReferenceCostMicros).toBeNull();
    expect(m.effectiveMultiplier).toBeNull();
    expect(m.costMicros).toBe(500);
  });

  it('官方参考费用为 0 ⇒ 不给倍率（不除零）', async () => {
    mockTables([row({ ...V2_TIER, actual_cost_micros: 160000, official_reference_cost_micros: 0 })], []);

    const m = (await readServerUsage())!.models[0];
    expect(m.officialReferenceCostMicros).toBe(0);
    expect(m.officialReferenceComplete).toBe(true);
    expect(m.effectiveMultiplier).toBeNull();
  });

  it('⭐ mode=none 时 cached 价为 null —— 是语义（不适用），不是缺数据', async () => {
    mockTables(
      [
        row({
          ...V2_TIER,
          official_cache_pricing_mode: 'none',
          official_cached_yuan_per_mtok: null,
          billed_cached_cents_per_mtok: null,
          actual_cost_micros: 100,
          official_reference_cost_micros: 60,
        }),
      ],
      [],
    );

    const m = (await readServerUsage())!.models[0];
    expect(m.officialCachePricingMode).toBe('none');
    expect(m.officialCachedYuanPerMtok).toBeNull();
    expect(m.saleCachedYuanPerMtok).toBeNull();
    // 其余价目仍可用 —— 不能因为 cached 是 null 就把整档丢掉
    expect(m.officialInputYuanPerMtok).toBe(1);
    expect(m.pricingMixed).toBe(false);
  });

  it('actual cost 只累加账本列（数字与字符串混排都不出错）', async () => {
    mockTables(
      [
        row({ day: '2026-09-10', actual_cost_micros: '5352960' }),
        row({ day: '2026-09-11', actual_cost_micros: 12345 }),
      ],
      [],
    );

    const m = (await readServerUsage())!.models[0];
    expect(m.costMicros).toBe(5352960 + 12345);
  });
});
