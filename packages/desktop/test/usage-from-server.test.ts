import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 统计页服务端数据源的聚合逻辑。
 *
 * 这里锁两件容易静默出错的事：
 *
 *   ① **PostgREST 把 bigint 序列化成字符串**。微积分是 1e-6 分，量级本来就大，
 *      不显式 Number() 的话 `acc += row.cost_micros` 会变成**字符串拼接** ——
 *      结果是 NaN 或者一个天文数字，而且不会有任何报错。
 *
 *   ② **同一模型的跨天行必须合并，不同模型必须分开** —— 这正是
 *      「用户从 qwen-plus 切到 kimi-k3，仪表板分两行」那条需求的落点。
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
    if (table === 'usage_daily_by_model') return tableChain({ data: byModel, error: null });
    if (table === 'usage_daily_by_org') return tableChain({ data: byDay, error: null });
    throw new Error('unexpected table: ' + table);
  });
}

beforeEach(() => {
  fromMock.mockReset();
});

describe('readServerUsage', () => {
  it('⭐ bigint 以字符串返回时被转成数字，不是字符串拼接', async () => {
    mockTables(
      [
        {
          day: '2026-09-12',
          provider: 'bailian',
          model: 'deepseek-v4-flash',
          calls: '3',
          input_tokens: '1000',
          output_tokens: '2000',
          cached_tokens: '0',
          total_tokens: '3000',
          // 6.1e9 远超 int4，PostgREST 会序列化成字符串
          cost_micros: '6100000000',
        },
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
        {
          day: '2026-09-10',
          provider: 'bailian',
          model: 'm1',
          calls: 1,
          input_tokens: 100,
          output_tokens: 0,
          cached_tokens: 0,
          total_tokens: 100,
          cost_micros: 500,
        },
        {
          day: '2026-09-11',
          provider: 'bailian',
          model: 'm1',
          calls: 2,
          input_tokens: 300,
          output_tokens: 0,
          cached_tokens: 0,
          total_tokens: 300,
          cost_micros: 1500,
        },
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
        {
          day: '2026-09-12',
          provider: 'bailian',
          model: 'cheap',
          calls: 1,
          input_tokens: 1,
          output_tokens: 0,
          cached_tokens: 0,
          total_tokens: 1,
          cost_micros: 100,
        },
        {
          day: '2026-09-12',
          provider: 'bailian',
          model: 'pricey',
          calls: 1,
          input_tokens: 1,
          output_tokens: 0,
          cached_tokens: 0,
          total_tokens: 1,
          cost_micros: 9000,
        },
      ],
      [],
    );

    const out = await readServerUsage();
    expect(out!.models.map((m) => m.model)).toEqual(['pricey', 'cheap']);
  });

  it('同一模型名分属两个 provider 时不合并（否则价格会串）', async () => {
    mockTables(
      [
        {
          day: '2026-09-12',
          provider: 'bailian',
          model: 'same',
          calls: 1,
          input_tokens: 1,
          output_tokens: 0,
          cached_tokens: 0,
          total_tokens: 1,
          cost_micros: 100,
        },
        {
          day: '2026-09-12',
          provider: 'ark',
          model: 'same',
          calls: 1,
          input_tokens: 1,
          output_tokens: 0,
          cached_tokens: 0,
          total_tokens: 1,
          cost_micros: 200,
        },
      ],
      [],
    );

    const out = await readServerUsage();
    expect(out!.models).toHaveLength(2);
    expect(out!.models.map((m) => m.provider).sort()).toEqual(['ark', 'bailian']);
  });

  it('按天的查询挂了也不让整个板块消失 —— 用按模型那份重算总计', async () => {
    fromMock.mockImplementation((table: string) => {
      if (table === 'usage_daily_by_model') {
        return tableChain({
          data: [
            {
              day: '2026-09-12',
              provider: 'bailian',
              model: 'm1',
              calls: 1,
              input_tokens: 10,
              output_tokens: 20,
              cached_tokens: 0,
              total_tokens: 30,
              cost_micros: 700,
            },
          ],
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
