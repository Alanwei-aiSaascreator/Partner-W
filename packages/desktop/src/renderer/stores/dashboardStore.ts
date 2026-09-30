import { create } from 'zustand';
import type { ClawDashboardData } from '@clawwork/shared';

const STALE_MS = 60_000;

interface DashboardState {
  data: ClawDashboardData | null;
  loading: boolean;
  error: string | null;
  loadedAt: number | null;
  fetch: (force?: boolean) => Promise<void>;
  clear: () => void;
}

let generation = 0;

export const useDashboardStore = create<DashboardState>((set, get) => ({
  data: null,
  loading: false,
  error: null,
  loadedAt: null,

  fetch: async (force = false) => {
    const state = get();
    if (state.loading) return;
    if (!force && state.loadedAt && Date.now() - state.loadedAt < STALE_MS) return;
    const owner = generation;
    set({ loading: true, error: null });
    try {
      const res = await window.clawwork.loadDashboardStats();
      if (owner !== generation) return;
      if (res.ok && res.result) {
        set({ data: res.result, loading: false, loadedAt: Date.now() });
      } else {
        console.error('[dashboardStore] fetch failed:', res.error);
        set({ loading: false, error: res.error ?? 'fetch failed' });
      }
    } catch (err) {
      if (owner !== generation) return;
      console.error('[dashboardStore] fetch threw:', err);
      set({ loading: false, error: err instanceof Error ? err.message : 'fetch failed' });
    }
  },

  clear: () => {
    generation++;
    set({ data: null, loading: false, error: null, loadedAt: null });
  },
}));
