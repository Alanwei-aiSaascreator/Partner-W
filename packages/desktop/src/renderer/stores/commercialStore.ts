import { create } from 'zustand';
import type { CommercialAccountOverview } from '@clawwork/shared';

export type PanelStatus = 'idle' | 'loading' | 'ready' | 'offline';

interface CommercialState {
  status: PanelStatus;
  overview: CommercialAccountOverview | null;
  errorMessage: string;
  load: () => Promise<void>;
  /**
   * 静默重拉额度。与 `load()` 的区别只有一条：**不把 status 翻成 loading**。
   *
   * 为什么需要它：`load()` 会把状态打到 loading，调用方据此渲染骨架屏 ——
   * 每轮对话结束都这么闪一下，顶栏钱包会一直眨。这个版本只更新数字。
   *
   * 失败时保留旧值供界面展示，但把状态翻为 offline。旧快照不能继续充当
   * 当前账号的发送授权，否则切号或网络失败时会误用上一张许可证。
   */
  refresh: () => Promise<void>;
}

const CACHE_KEY = 'cw:commercial-overview';

function readCache(): CommercialAccountOverview | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as CommercialAccountOverview) : null;
  } catch {
    return null;
  }
}

function writeCache(overview: CommercialAccountOverview): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(overview));
  } catch {}
}

export const useCommercialStore = create<CommercialState>((set, get) => ({
  status: 'idle',
  overview: readCache(),
  errorMessage: '',

  load: async () => {
    set({ status: 'loading', errorMessage: '' });
    try {
      const res = await window.clawwork.commercialAccountOverview();
      if (!res.ok || !res.result) {
        set({ status: 'offline', errorMessage: res.error ?? '' });
        return;
      }
      writeCache(res.result);
      set({ status: 'ready', overview: res.result, errorMessage: '' });
    } catch (error) {
      if (!get().overview) set({ overview: readCache() });
      set({ status: 'offline', errorMessage: error instanceof Error ? error.message : String(error) });
    }
  },

  refresh: async () => {
    // 没有已登录的账号就不空跑 —— 未登录时这个面板本来就不显示。
    if (!get().overview?.account) return;
    try {
      const res = await window.clawwork.commercialAccountOverview();
      if (!res.ok || !res.result) {
        set({ status: 'offline' });
        return;
      }
      writeCache(res.result);
      set({ status: 'ready', overview: res.result, errorMessage: '' });
    } catch {
      set({ status: 'offline' });
    }
  },
}));
