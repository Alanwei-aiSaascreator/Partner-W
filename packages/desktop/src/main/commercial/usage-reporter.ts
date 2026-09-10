import { getCommercialClient } from './client.js';
import { getAllGatewayClients } from '../ws/index.js';
import { getDebugLogger } from '../debug/index.js';

/**
 * Usage reporting.
 *
 * The business layer is server-authoritative: this module only ships cumulative
 * token counters to `report_usage`, which diffs them against what it saw last
 * time. Re-sending an unchanged counter produces no write at all, so a lost or
 * duplicated tick can never double-charge a licence.
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
      let payload: unknown;
      try {
        payload = await gw.getSessionUsage({});
      } catch (error) {
        getDebugLogger().warn({
          domain: 'commercial',
          event: 'commercial.usage.session-usage-failed',
          data: { gatewayId: gw.id, message: error instanceof Error ? error.message : String(error) },
        });
        continue;
      }

      for (const session of readSessions(payload)) {
        const sessionKey = session.key;
        if (!sessionKey) continue;

        for (const line of session.modelUsage ?? []) {
          if (!line.provider || !line.model) continue;

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
