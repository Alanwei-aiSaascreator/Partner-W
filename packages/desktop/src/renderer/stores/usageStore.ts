import { create } from 'zustand';
import type { UsageStatus } from '@clawwork/shared';

const REFRESH_INTERVAL_MS = 60_000;
const INSTANCE_CACHE_MS = 30_000;

/**
 * ⚠️ 这个 store 以前每 60 秒还发两条**会话级**请求，2026-09-20 两条都撤了
 * （`usage.cost` 见 T-a23 / `sessions.usage` 见 T-a25）。撤法不同，但**理由是同一个**：
 * 取回的数据在渲染层**只有写没有读**，而请求本身在真实配置下**会失败**。
 *
 * 1. `usage.cost`（T-a23，`5ef96a56`）：不带 `agentScope`/`agentId` 时网关拿 `"main"` 解析归属
 *    （随包运行时 `dist/usage-lCaKvodi.mjs`：`resolveRequestedSessionAgentId(config, "main")`），
 *    多 agent 配置下解析不出来 ⇒ 整条 `INVALID_REQUEST`
 *    「Multiple agents are configured, but session key "main" has no explicit owner」。
 *    本机全档日志（`%APPDATA%/@clawwork/desktop/logs/debug-*.ndjson`）：432 发 / 266 成功 /
 *    **160 失败**，而那 266 次成功**全在 09-07…09-14**（单 agent 时期），此后 0 次成功。
 * 2. `sessions.usage`（T-a25）：`{ key }` 里传的是**客户端自己拼的 task 级会话键**，而 `chat.send`
 *    是**用 key 惰性建会话**的 ⇒ "还没发过消息 / 会话被删 / agent 前缀变过"的 key 在网关上
 *    **不是会话**，报文 `Invalid session reference: agent:…:clawwork:…:task:<uuid>`（全档 **36 次**，
 *    其中 25 次聚在 09-19 17:02–18:01）。同族证据：**同一个会话 id** 在单 agent 时期报 `agent:main:…`、
 *    09-19 报 `agent:rongying-office:…` —— 前缀跟着配置走，而它**两个时期都报错**。
 *
 * ⚠️ **两条都没有消费者**：`cost` 与 `sessionUsage` 两个字段在渲染层都只有写没有读
 * （全仓 grep：读者 **0 处**），顶栏也按产品决定（2026-09-17）不再显示 token 数与美元成本。
 *
 * 将来真要做成本/用量视图，第一步是**重新立项**，并把 owner 的规矩写进那一刀：
 * `usage.cost` 必须带 `agentScope: 'all'` 或 `agentId`；`sessions.usage` 只对**网关上已存在的**会话键有效，
 * 别再拿客户端自己拼的 task 键去问。**不要照着旧代码把不带 owner 的那一版抄回来。**
 */
interface UsageState {
  status: UsageStatus | null;
  loading: boolean;
  error: string | null;

  fetchUsage: (gatewayId: string) => Promise<void>;
  startAutoRefresh: (gatewayId: string) => void;
  stopAutoRefresh: () => void;
  clear: () => void;
}

let refreshTimer: ReturnType<typeof setInterval> | null = null;
let instanceFetchedAt = 0;

export const useUsageStore = create<UsageState>((set, get) => ({
  status: null,
  loading: false,
  error: null,

  fetchUsage: async (gatewayId: string) => {
    if (!gatewayId) return;
    if (typeof window.clawwork.getUsageStatus !== 'function') {
      set({ loading: false, error: null });
      return;
    }
    set({ loading: true, error: null });
    try {
      // 30 秒窗口内实例级查询已被跳过 ⇒ 这条路上**再没有别的请求**可发（会话级两条都已撤掉）。
      if (Date.now() - instanceFetchedAt < INSTANCE_CACHE_MS && get().status != null) {
        set({ loading: false });
        return;
      }

      const statusRes = await window.clawwork.getUsageStatus(gatewayId);
      const updates: Partial<UsageState> = { loading: false };
      if (statusRes.ok && statusRes.result) {
        updates.status = statusRes.result as unknown as UsageStatus;
      }
      if (!statusRes.ok) {
        updates.error = statusRes.error ?? 'fetch failed';
      }
      instanceFetchedAt = Date.now();
      set(updates);
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : 'fetch failed',
      });
    }
  },

  startAutoRefresh: (gatewayId: string) => {
    get().stopAutoRefresh();
    get().fetchUsage(gatewayId);
    refreshTimer = setInterval(() => {
      get().fetchUsage(gatewayId);
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
    set({ status: null, loading: false, error: null });
  },
}));
