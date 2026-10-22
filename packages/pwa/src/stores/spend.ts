import { create } from 'zustand';
import { gatewayToken, mobileFetch } from '../lib/remote-api';

/**
 * 「本轮消耗 / 本次任务累计消耗」—— 手机端版。
 *
 * 口径与桌面端一致：**每轮结束取一次余额快照，用"上一轮余额 − 这一轮余额"算本轮**，
 * 再按 taskId 累加。数据源必须是同一本账，所以这里打的是桌面主进程的
 * `/api/mobile/quota`（转调 `readQuotaSnapshot()`），不是自己估。
 *
 * 为什么不用 token 数换算：服务端只按微积分记账，token 换算出来的数字对不上账单。
 */
export interface SpendState {
  /** sessionKey → 本轮微积分（1 积分 = 1e6 微积分）。 */
  turnMicros: Record<string, number>;
  /** taskId → 累计微积分。 */
  taskMicros: Record<string, number>;
  /** 上一次读到的 `tokenUsedMicros`（差分基线）。 */
  lastUsedMicros: number | null;
  settle: (input: { sessionKey: string; taskId: string }) => Promise<void>;
}

interface QuotaPayload {
  ok?: boolean;
  result?: { license?: { tokenUsedMicros?: number } | null };
  license?: { tokenUsedMicros?: number } | null;
}

export const useSpendStore = create<SpendState>((set, get) => ({
  turnMicros: {},
  taskMicros: {},
  lastUsedMicros: null,

  settle: async ({ sessionKey, taskId }) => {
    try {
      const token = await gatewayToken();
      if (!token) return;
      const response = await mobileFetch('/api/mobile/quota', token);
      if (!response.ok) return;
      const data = (await response.json()) as QuotaPayload;
      const used = data.result?.license?.tokenUsedMicros ?? data.license?.tokenUsedMicros;
      if (typeof used !== 'number') return;

      const baseline = get().lastUsedMicros;
      set({ lastUsedMicros: used });
      // 第一次只记基线：没有"上一轮余额"，任何差分都是假的。
      if (baseline === null) return;

      const delta = used - baseline;
      if (!Number.isFinite(delta) || delta <= 0) return;

      set((state) => ({
        turnMicros: { ...state.turnMicros, [sessionKey]: delta },
        taskMicros: { ...state.taskMicros, [taskId]: (state.taskMicros[taskId] ?? 0) + delta },
      }));
    } catch {
      /* 取不到就不显示消耗，绝不编数字 */
    }
  },
}));

/** 微积分 → 人类可读的「x.xx 积分」。 */
export function formatCredits(micros: number): string {
  return (micros / 1_000_000).toFixed(2);
}
