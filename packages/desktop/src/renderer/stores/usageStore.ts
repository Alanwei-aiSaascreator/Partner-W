import { create } from 'zustand';
import type { UsageStatus, SessionCostSummary } from '@clawwork/shared';

const REFRESH_INTERVAL_MS = 60_000;
const INSTANCE_CACHE_MS = 30_000;

/**
 * ⚠️ 这里**曾经**还查一条 `usage.cost`（`getUsageCost(gatewayId, { days: 30 })`）——
 * 2026-09-20 删掉（T-a23）。两个理由，缺一不可：
 *
 * 1. **它注定失败**：不带 `agentScope`/`agentId` 时，网关拿 `"main"` 去解析归属
 *    （随包运行时 `dist/usage-lCaKvodi.mjs`：`resolveRequestedSessionAgentId(config, "main")`），
 *    多 agent 配置下解析不出来 ⇒ 整条 `INVALID_REQUEST`
 *    「Multiple agents are configured, but session key "main" has no explicit owner」。
 *    本机日志存档（`%APPDATA%/@clawwork/desktop/logs/debug-*.ndjson`）里：432 发 / 266 成功 /
 *    **160 失败**，而那 266 次成功**全在 09-07…09-14**（单 agent 时期），09-15 之后 0 次成功。
 *    （同族的 `sessions.usage` 09-17 已用 `agentScope: 'all'` 修好，这条是漏掉的孪生兄弟。）
 * 2. **它取回的数据没人看**：`cost` 在渲染层只有写没有读（`grep -rn "\.cost\b" src/renderer`
 *    唯一命中就是那行赋值），顶栏也按产品决定（2026-09-17）不再显示美元成本。
 *    ⇒ 每分钟一次的无效请求 + 死状态 + 一条**从来没浮到界面上**的错误（旧写法里
 *    `updates.error` 要求 status 与 cost **同时**失败才设）。
 *
 * 将来真要做成本视图，第一步是重新立项，并把 `agentScope: 'all'`（或 `agentId`）写进那一刀；
 * 不要照着旧代码把不带 owner 的那一版抄回来。
 */
interface UsageState {
  status: UsageStatus | null;
  sessionUsage: SessionCostSummary | null;
  loading: boolean;
  error: string | null;

  fetchUsage: (gatewayId: string, sessionKey?: string) => Promise<void>;
  startAutoRefresh: (gatewayId: string, sessionKey?: string) => void;
  stopAutoRefresh: () => void;
  clear: () => void;
}

let refreshTimer: ReturnType<typeof setInterval> | null = null;
let instanceFetchedAt = 0;

export const useUsageStore = create<UsageState>((set, get) => ({
  status: null,
  sessionUsage: null,
  loading: false,
  error: null,

  fetchUsage: async (gatewayId: string, sessionKey?: string) => {
    if (!gatewayId) return;
    if (
      typeof window.clawwork.getUsageStatus !== 'function' ||
      (sessionKey && typeof window.clawwork.getSessionUsage !== 'function')
    ) {
      set({ loading: false, error: null, sessionUsage: null });
      return;
    }
    set({ loading: true, error: null });
    try {
      const skipInstance = Date.now() - instanceFetchedAt < INSTANCE_CACHE_MS && get().status != null;

      const promises: Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }>[] = [];
      if (!skipInstance) {
        promises.push(window.clawwork.getUsageStatus(gatewayId));
      }
      if (sessionKey) {
        promises.push(window.clawwork.getSessionUsage(gatewayId, sessionKey));
      }

      const results = await Promise.all(promises);
      const updates: Partial<UsageState> = { loading: false };

      if (!skipInstance) {
        const [statusRes] = results;
        if (statusRes.ok && statusRes.result) {
          updates.status = statusRes.result as unknown as UsageStatus;
        }
        if (!statusRes.ok) {
          updates.error = statusRes.error ?? 'fetch failed';
        }
        instanceFetchedAt = Date.now();
      }

      const sessionRes = skipInstance ? results[0] : results[1];
      if (sessionRes?.ok && sessionRes.result) {
        const r = sessionRes.result as unknown as { sessions?: { usage: SessionCostSummary | null }[] };
        updates.sessionUsage = r.sessions?.[0]?.usage ?? null;
      } else if (!sessionKey) {
        updates.sessionUsage = null;
      }

      set(updates);
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : 'fetch failed',
      });
    }
  },

  startAutoRefresh: (gatewayId: string, sessionKey?: string) => {
    get().stopAutoRefresh();
    set({ sessionUsage: null });
    get().fetchUsage(gatewayId, sessionKey);
    refreshTimer = setInterval(() => {
      get().fetchUsage(gatewayId, sessionKey);
    }, REFRESH_INTERVAL_MS);
  },

  stopAutoRefresh: () => {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  },

  clear: () => {
    get().stopAutoRefresh();
    instanceFetchedAt = 0;
    set({ status: null, sessionUsage: null, loading: false, error: null });
  },
}));
