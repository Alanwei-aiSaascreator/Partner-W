import { create } from 'zustand';
import type { CommercialAccountOverview } from '@clawwork/shared';

type PanelStatus = 'idle' | 'loading' | 'ready' | 'offline';

interface CommercialState {
  status: PanelStatus;
  overview: CommercialAccountOverview | null;
  errorMessage: string;
  load: () => Promise<void>;
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
}));
