/**
 * 统计页「模型消耗 / 最近 30 天」的**服务端**数据源。
 *
 * 为什么不再用本机网关的数据：
 *
 *   ① 网关的 `usage.cost` 是它按自己内置价目表估的**美元**，覆盖该网关上
 *      **全部**会话（含不走中转的调用）。而账户页的余额只跟踪走中转、
 *      被服务端计过费的那些调用 —— 两个数字衡量的根本不是同一批调用，
 *      放同一个页面上永远对不上。
 *
 *   ② 网关只知道「会话用哪个模型」，看不到用户中途切模型；网关自己回退到别的
 *      模型时（fallback 事件）客户端更是完全不落库（见 gateway-dispatcher）。
 *
 * 服务端的 `usage_records` 才是权威：relay 在响应结束后**每次调用写一行**，
 * 记的是**实际发到上游的模型名**（请求体原样透传）。下面读的两个视图就是它的聚合。
 *
 * 按模型的聚合读 `usage_billing_by_model`（迁移 32，透明计费层）——
 * 它是 `usage_daily_by_model` 的超集：同样的 calls / tokens / actual cost，
 * 外加**落账当时的价目快照**（官方参考价、目标倍率、实际售价、官方参考费用）。
 *
 * ⚠️ 这是**账号级**（org）数据，与本机 SQLite 的任务/消息数不是一个口径。
 *    界面上必须标出来，否则用户会以为数字对不上。
 *
 * ⚠️ 单位是**微积分**（1e-6 积分），不是美元也不是分。显示走 `formatCredits`。
 *
 * ⚠️ 这一层**只读数、只聚合，不重算任何金额**：
 *    actual cost 直接取账本列，官方参考费用直接取视图算好的增量。
 *    历史 v1 行没有快照 ⇒ 相关字段是 null，**不许当 0**。
 */

import type { DashboardModelUsage } from '@clawwork/shared';
import { getCommercialClient } from '../commercial/client.js';
import { readSessionState } from '../commercial/auth.js';
import { selectOwnerOrg } from '../commercial/owner-org.js';

const QUERY_TIMEOUT_MS = 8_000;
const WINDOW_DAYS = 30;

export interface ServerUsageDailyPoint {
  date: string;
  input: number;
  output: number;
  costMicros: number;
}

export interface ServerUsage {
  /** 按 provider × model 聚合，costMicros 降序。 */
  models: DashboardModelUsage[];
  daily: ServerUsageDailyPoint[];
  totals: { input: number; output: number; costMicros: number };
}

function withTimeoutOrNull<T>(work: PromiseLike<T>, label: string): Promise<T | null> {
  return Promise.race([
    Promise.resolve(work),
    new Promise<null>((resolve) =>
      setTimeout(() => {
        console.error(`[stats] ${label} timed out after ${QUERY_TIMEOUT_MS}ms`);
        resolve(null);
      }, QUERY_TIMEOUT_MS),
    ),
  ]);
}

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

interface ModelRow {
  day: string;
  provider: string | null;
  model: string | null;
  calls: number | string | null;
  input_tokens: number | string | null;
  output_tokens: number | string | null;
  cached_tokens: number | string | null;
  total_tokens: number | string | null;
  actual_cost_micros: number | string | null;

  // ── 透明计费（迁移 32）──
  calls_with_snapshot: number | string | null;
  official_reference_covered_calls: number | string | null;
  official_reference_cost_micros: number | string | null;
  official_reference_complete: boolean | null;
  pricing_variants: number | string | null;
  pricing_rule_revision: string | null;
  official_cache_pricing_mode: string | null;
  official_input_yuan_per_mtok: number | string | null;
  official_output_yuan_per_mtok: number | string | null;
  official_cached_yuan_per_mtok: number | string | null;
  billing_multiplier_ppm: number | string | null;
  billed_input_cents_per_mtok: number | string | null;
  billed_output_cents_per_mtok: number | string | null;
  billed_cached_cents_per_mtok: number | string | null;
}

/**
 * 一档价目的标量快照。用于**跨天比对**：窗口内所有天都指向同一档时才能显示价格，
 * 否则必须显示「多档」而不是某一档的数字。
 *
 * ⚠️ `official_*` 是 numeric，PostgREST 同样可能给字符串 —— 一律过 `numOrNull`。
 * ⚠️ `officialCached` 与 `officialCachePricingMode` 允许是 null（mode=none 时
 *    本来就没有 cached 价）—— 所以这里的 null 是**语义**，不是「没数据」。
 */
interface PriceTuple {
  revision: string | null;
  mode: string | null;
  officialInput: number | null;
  officialOutput: number | null;
  officialCached: number | null;
  multiplier: number | null;
  billedInput: number | null;
  billedOutput: number | null;
  billedCached: number | null;
}

/** 与 `num` 同源，但**保留 null**：这里的 null 有语义（未记录 / 不适用），不能变成 0。 */
function numOrNull(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'string' ? Number(value) : value;
  return Number.isFinite(n) ? n : null;
}

function tupleKey(t: PriceTuple): string {
  return [
    t.revision ?? '-',
    t.mode ?? '-',
    t.officialInput ?? '-',
    t.officialOutput ?? '-',
    t.officialCached ?? '-',
    t.multiplier ?? '-',
    t.billedInput ?? '-',
    t.billedOutput ?? '-',
    t.billedCached ?? '-',
  ].join('|');
}

/** 聚合过程中的累加器：`DashboardModelUsage` 之外再挂两组**只在聚合期存在**的账。 */
interface ModelAcc extends DashboardModelUsage {
  /** 见过的价目档（跨天去重，键是 tupleKey） */
  priceTuples: Map<string, PriceTuple>;
  /** 任一天内部就多档（视图把标量置 NULL，客户端再也拼不出档位） */
  anyMixedWithinDay: boolean;
  /** 官方参考费用的累加（只累加算得出的行） */
  officialCostSum: number;
  hasOfficialCost: boolean;
}

/** 两处聚合共用的初值 —— 集中一处，避免将来加字段时漏掉一个分支。 */
function emptyModelAcc(provider: string, model: string): ModelAcc {
  return {
    provider,
    model,
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
    costMicros: 0,
    saleInputYuanPerMtok: null,
    saleOutputYuanPerMtok: null,
    saleCachedYuanPerMtok: null,
    officialInputYuanPerMtok: null,
    officialOutputYuanPerMtok: null,
    officialCachedYuanPerMtok: null,
    officialCachePricingMode: null,
    targetMultiplier: null,
    pricingVariants: 0,
    pricingMixed: false,
    settledCalls: 0,
    officialReferenceCoveredCalls: 0,
    officialReferenceCostMicros: null,
    officialReferenceComplete: false,
    effectiveMultiplier: null,
    priceTuples: new Map(),
    anyMixedWithinDay: false,
    officialCostSum: 0,
    hasOfficialCost: false,
  };
}

/**
 * 把累加器收敛成对外的 `DashboardModelUsage`。
 *
 * ⚠️ 价目标量**只在窗口内只有一档时**才给值：跨天调过价就置 null 并
 *    置 `pricingMixed`，让界面显示「多档」——**不许拿其中一档冒充整窗口**。
 */
function finalizeModelAcc(acc: ModelAcc): DashboardModelUsage {
  const tuples = Array.from(acc.priceTuples.values());
  const mixed = acc.anyMixedWithinDay || tuples.length > 1;
  const only = !acc.anyMixedWithinDay && tuples.length === 1 ? tuples[0] : null;

  // 每一笔都覆盖到，比值才有意义（分子分母必须是同一批记录）
  const complete = acc.settledCalls > 0 && acc.officialReferenceCoveredCalls === acc.settledCalls;
  const officialCost = acc.hasOfficialCost ? acc.officialCostSum : null;

  return {
    provider: acc.provider,
    model: acc.model,
    calls: acc.calls,
    inputTokens: acc.inputTokens,
    outputTokens: acc.outputTokens,
    cachedTokens: acc.cachedTokens,
    totalTokens: acc.totalTokens,
    costMicros: acc.costMicros,

    saleInputYuanPerMtok: only ? only.billedInput : null,
    saleOutputYuanPerMtok: only ? only.billedOutput : null,
    saleCachedYuanPerMtok: only ? only.billedCached : null,
    officialInputYuanPerMtok: only ? only.officialInput : null,
    officialOutputYuanPerMtok: only ? only.officialOutput : null,
    officialCachedYuanPerMtok: only ? only.officialCached : null,
    officialCachePricingMode: only ? only.mode : null,
    targetMultiplier: only ? only.multiplier : null,
    pricingVariants: tuples.length + (acc.anyMixedWithinDay ? 1 : 0),
    pricingMixed: mixed,

    settledCalls: acc.settledCalls,
    officialReferenceCoveredCalls: acc.officialReferenceCoveredCalls,
    officialReferenceCostMicros: officialCost,
    officialReferenceComplete: complete,
    effectiveMultiplier: complete && officialCost !== null && officialCost > 0 ? acc.costMicros / officialCost : null,
  };
}

interface DayRow {
  day: string;
  input_tokens: number | string | null;
  output_tokens: number | string | null;
  cost_micros: number | string | null;
}

/**
 * PostgREST 把 bigint 序列化成**字符串**（JS 的 number 装不下 int8 的全量程）。
 * 微积分是 1e-6 分，量级本来就大，所以这里必须过一遍 Number()。
 * 不做的话 `sum += row.cost_micros` 会变成字符串拼接 —— 静默出 NaN 或天文数字。
 */
function num(value: number | string | null | undefined): number {
  const n = typeof value === 'string' ? Number(value) : (value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 拿不到就返回 `null`（未登录 / 无商业配置 / 超时 / 查询失败），
 * 让上层优雅降级成「暂无数据」，而不是让整个统计页挂掉。
 */
export async function readServerUsage(): Promise<ServerUsage | null> {
  const supabase = getCommercialClient();
  if (!supabase) return null;

  try {
    const session = await readSessionState();
    if (!session.ok || !session.result) return null;

    const state = session.result;
    if (!state.signedIn) return null;

    // 与 auth.ts / license.ts 一致：走同一个选择器（最早加入的 owner 组织）。
    // 以前这里写的是 `state.orgs[0]`，而那份列表既没排序也没筛角色 ——
    // 「第一个」不确定，且可能是用户只是 member 的组织，统计会显示成别人的账。
    const org = selectOwnerOrg(state.orgs);
    if (!org) return null;

    const since = isoDaysAgo(WINDOW_DAYS);

    const [byModel, byDay] = await Promise.all([
      withTimeoutOrNull(
        supabase
          .from('usage_billing_by_model')
          // ⚠️ 必须写成**一个**字符串字面量，不能用 `+` 拼：
          //    拼接后 supabase-js 的列名推导退化成 GenericStringError[]，
          //    下面的 `as ModelRow[]` 就编译不过（实测 TS2352）。
          .select(
            'day, provider, model, calls, input_tokens, output_tokens, cached_tokens, total_tokens, actual_cost_micros, calls_with_snapshot, official_reference_covered_calls, official_reference_cost_micros, official_reference_complete, pricing_variants, pricing_rule_revision, official_cache_pricing_mode, official_input_yuan_per_mtok, official_output_yuan_per_mtok, official_cached_yuan_per_mtok, billing_multiplier_ppm, billed_input_cents_per_mtok, billed_output_cents_per_mtok, billed_cached_cents_per_mtok',
          )
          .eq('org_id', org.id)
          .gte('day', since),
        'usage_billing_by_model',
      ),
      withTimeoutOrNull(
        supabase
          .from('usage_daily_by_org')
          .select('day, input_tokens, output_tokens, cost_micros')
          .eq('org_id', org.id)
          .gte('day', since),
        'usage_daily_by_org',
      ),
    ]);

    if (!byModel || byModel.error) {
      if (byModel?.error) console.error('[stats] usage_billing_by_model failed:', byModel.error.message);
      return null;
    }

    // 按 provider × model 跨天累加。
    // 键用 `${provider} ${model}`：模型名里不会有 NUL，不会撞键。
    const modelMap = new Map<string, ModelAcc>();
    for (const row of (byModel.data ?? []) as ModelRow[]) {
      const provider = row.provider ?? '';
      const model = row.model ?? '';
      if (!model) continue;
      const key = `${provider} ${model}`;
      const acc = modelMap.get(key) ?? emptyModelAcc(provider, model);

      acc.calls += num(row.calls);
      acc.inputTokens += num(row.input_tokens);
      acc.outputTokens += num(row.output_tokens);
      acc.cachedTokens += num(row.cached_tokens);
      acc.totalTokens += num(row.total_tokens);
      // 账本事实：直接累加，不重算
      acc.costMicros += num(row.actual_cost_micros);

      acc.settledCalls += num(row.calls);
      acc.officialReferenceCoveredCalls += num(row.official_reference_covered_calls);
      const officialDelta = numOrNull(row.official_reference_cost_micros);
      if (officialDelta !== null) {
        acc.officialCostSum += officialDelta;
        acc.hasOfficialCost = true;
      }

      // 价目：只有「这一天内部只有一档」时才拿得到标量；否则只能记下「多档」。
      const variants = num(row.pricing_variants);
      if (variants > 1) {
        acc.anyMixedWithinDay = true;
      } else if (variants === 1) {
        const tuple: PriceTuple = {
          revision: row.pricing_rule_revision ?? null,
          mode: row.official_cache_pricing_mode ?? null,
          officialInput: numOrNull(row.official_input_yuan_per_mtok),
          officialOutput: numOrNull(row.official_output_yuan_per_mtok),
          officialCached: numOrNull(row.official_cached_yuan_per_mtok),
          multiplier:
            numOrNull(row.billing_multiplier_ppm) === null ? null : num(row.billing_multiplier_ppm) / 1_000_000,
          billedInput:
            numOrNull(row.billed_input_cents_per_mtok) === null ? null : num(row.billed_input_cents_per_mtok) / 100,
          billedOutput:
            numOrNull(row.billed_output_cents_per_mtok) === null ? null : num(row.billed_output_cents_per_mtok) / 100,
          billedCached:
            numOrNull(row.billed_cached_cents_per_mtok) === null ? null : num(row.billed_cached_cents_per_mtok) / 100,
        };
        acc.priceTuples.set(tupleKey(tuple), tuple);
      }

      modelMap.set(key, acc);
    }

    const models = Array.from(modelMap.values())
      .map(finalizeModelAcc)
      .sort((a, b) => b.costMicros - a.costMicros);

    const daily: ServerUsageDailyPoint[] = [];
    let input = 0;
    let output = 0;
    let costMicros = 0;
    if (byDay && !byDay.error) {
      for (const row of (byDay.data ?? []) as DayRow[]) {
        const point: ServerUsageDailyPoint = {
          date: String(row.day),
          input: num(row.input_tokens),
          output: num(row.output_tokens),
          costMicros: num(row.cost_micros),
        };
        daily.push(point);
        input += point.input;
        output += point.output;
        costMicros += point.costMicros;
      }
      daily.sort((a, b) => a.date.localeCompare(b.date));
    } else {
      // 按天的查询挂了也不该让整个板块消失 —— 用按模型的那份重算一遍总计。
      // （日折线会是空的，但磁贴上的数字仍然对。）
      if (byDay?.error) console.error('[stats] usage_daily_by_org failed:', byDay.error.message);
      for (const m of models) {
        input += m.inputTokens;
        output += m.outputTokens;
        costMicros += m.costMicros;
      }
    }

    return { models, daily, totals: { input, output, costMicros } };
  } catch (error) {
    console.error('[stats] readServerUsage failed:', error);
    return null;
  }
}
