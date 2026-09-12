import { create } from 'zustand';
import type { CommercialAccountOverview } from '@clawwork/shared';

type PanelStatus = 'idle' | 'loading' | 'ready' | 'offline';

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
   * 失败时**静默保留旧值**，不翻 offline：一次后台刷新失败不该让账户面板
   * 挂上「离线」横幅，那会吓到用户。真正需要报错的是用户主动触发的那些路径。
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
      if (!res.ok || !res.result) return; // 静默保留旧值
      writeCache(res.result);
      set({ status: 'ready', overview: res.result, errorMessage: '' });
    } catch {
      // 静默失败：后台刷新不该改变用户看到的状态
    }
  },
}));
