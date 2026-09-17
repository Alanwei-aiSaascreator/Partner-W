import { getCommercialClient } from './client.js';
import { getAllGatewayClients } from '../ws/index.js';
import { getDebugLogger } from '../debug/index.js';
import { relayProviderIds } from './relay-config.js';

/**
 * Usage reporting.
 *
 * The business layer is server-authoritative: this module only ships cumulative
 * token counters to `report_usage`, which diffs them against what it saw last
 * time. Re-sending an unchanged counter produces no write at all, so a lost or
 * duplicated tick can never double-charge a licence.
 *
 * ## 走中转服务的调用要跳过（2026-09-11）
 *
 * 中转服务在**服务端**直接测量 token 并落账。同一次调用如果再从这里上报一次，
 * 就是两条互不相干的账 —— session key 前缀不同（服务端那条是 `relay:<user>:<id>`）、
 * provider 也不同（`bailian` vs 客户端的 provider 名），服务端的差分去重挡不住。
 * 结果是**用户被扣两次**。
 *
 * 所以这里跳过「已经由中转服务计量」的 provider。认它们的方式是**看配置**
 * （baseUrl 是否指向中转服务），不是看名字 —— 理由见 `relay-config.ts`。
 */

const REPORT_INTERVAL_MS = 5 * 60 * 1000;
const RPC_TIMEOUT_MS = 20_000;

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

type ModelUsageLine = {
  provider?: string;
  model?: string;
  totals?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
};

type SessionUsageLine = {
  key?: string;
  modelUsage?: ModelUsageLine[];
};

function readSessions(payload: unknown): SessionUsageLine[] {
  if (!payload || typeof payload !== 'object') return [];
  const sessions = (payload as { sessions?: unknown }).sessions;
  return Array.isArray(sessions) ? (sessions as SessionUsageLine[]) : [];
}

function nonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export async function runUsageReport(): Promise<number> {
  if (running) return 0;
  running = true;

  try {
    const supabase = getCommercialClient();
    if (!supabase) return 0;

    const clients = getAllGatewayClients();
    const connected = Array.from(clients.values()).filter((gw) => gw.isConnected);
    if (connected.length === 0) return 0;

    const rpc = supabase.rpc.bind(supabase);
    let sent = 0;

    for (const gw of connected) {
      // 先认「哪些 provider 走中转」。读不到配置就**整条网关跳过** ——
      // 宁可漏记一个 tick，不可双记：上报是累计量、服务端做差分，
      // 漏一个 tick 只是延迟（下一个 tick 会带完整累计值），
      // 而多报一次是立刻多扣用户的钱。两个方向的代价不对称。
      let relayProviders: Set<string>;
      try {
        relayProviders = relayProviderIds(await gw.getConfig());
      } catch (error) {
        getDebugLogger().warn({
          domain: 'commercial',
          event: 'commercial.usage.gateway-config-failed',
          data: { gatewayId: gw.id, message: error instanceof Error ? error.message : String(error) },
        });
        continue;
      }

      let payload: unknown;
      try {
        // ⚠️ 必须带 `agentScope: 'all'`：只发 `{}` 时网关逐个会话解析归属，
        //    碰到没有 owner 的 `main` 会整条拒绝（实机 38 次），于是**整个网关被跳过**、
        //    非中转用量一分都记不上。见 SessionsUsageParamsSchema 的字段注释。
        payload = await gw.getSessionUsage({ agentScope: 'all' });
      } catch (error) {
        getDebugLogger().warn({
          domain: 'commercial',
          event: 'commercial.usage.session-usage-failed',
          data: { gatewayId: gw.id, message: error instanceof Error ? error.message : String(error) },
        });
        continue;
      }

      // 只用于下面那条「过滤没命中」的告警：如果配置里明明有指向中转的 provider，
      // 却没有一条用量行的 provider 对得上，说明 provider 字段的取值和我们以为的不一样。
      // 那种情况下过滤会**静默失效**，等于没做 —— 所以要喊出来。
      const observedProviders = new Set<string>();
      let skipped = 0;

      for (const session of readSessions(payload)) {
        const sessionKey = session.key;
        if (!sessionKey) continue;

        for (const line of session.modelUsage ?? []) {
          if (!line.provider || !line.model) continue;

          observedProviders.add(line.provider);
          if (relayProviders.has(line.provider)) {
            skipped += 1;
            continue;
          }

          const totals = line.totals ?? {};
          // cacheWrite is billed at 125% and cacheRead at 10%; the pricing table
          // carries a single cached rate, and writes are rare, so they share a column.
          const cached = nonNegative(totals.cacheRead) + nonNegative(totals.cacheWrite);

          const { error } = await withTimeout(
            rpc('report_usage', {
              p_session_key: sessionKey,
              p_provider: line.provider,
              p_model: line.model,
              p_cum_input: nonNegative(totals.input),
              p_cum_output: nonNegative(totals.output),
              p_cum_cached: cached,
            }),
            RPC_TIMEOUT_MS,
          );

          if (error) {
            getDebugLogger().warn({
              domain: 'commercial',
              event: 'commercial.usage.report-failed',
              data: { sessionKey, provider: line.provider, model: line.model, message: error.message },
            });
            continue;
          }

          sent += 1;
        }
      }

      // 配置里明明有指向中转的 provider，却一条用量行都没命中 —— 说明
      // provider 字段的取值和我们以为的不一样，过滤等于没做。喊出来，
      // 不要让它静默失效（静默失效的后果是双记，用户被扣两次）。
      if (relayProviders.size > 0 && skipped === 0 && observedProviders.size > 0) {
        getDebugLogger().warn({
          domain: 'commercial',
          event: 'commercial.usage.relay-filter-missed',
          data: {
            gatewayId: gw.id,
            relayProviders: [...relayProviders],
            observed: [...observedProviders],
          },
        });
      }
    }

    return sent;
  } finally {
    running = false;
  }
}

type RpcOutcome = { error: { message: string } | null };

async function withTimeout<T extends RpcOutcome>(work: PromiseLike<T>, ms: number): Promise<T | RpcOutcome> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<RpcOutcome>((resolve) => {
    handle = setTimeout(() => resolve({ error: { message: 'timeout' } }), ms);
  });
  try {
    return await Promise.race([Promise.resolve(work), timeout]);
  } finally {
    if (handle !== undefined) clearTimeout(handle);
  }
}

export function initUsageReporter(): void {
  if (timer) return;
  void runUsageReport().catch(() => {});
  timer = setInterval(() => {
    void runUsageReport().catch(() => {});
  }, REPORT_INTERVAL_MS);
}

export function destroyUsageReporter(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
