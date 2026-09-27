import { useCallback, useEffect, useState } from 'react';
import { describeGrowthError, normalizeBounties, normalizeGrowthHistory, normalizeGrowthSummary } from '@clawwork/core';
import type { Bounty, GrowthEntry, GrowthSummary } from '@clawwork/shared';
import { toast } from '@/lib/toast';

/** 读不到时用这个空账户兜底：界面显示 0 / Lv.1，而不是崩或者空白。 */
const EMPTY_SUMMARY: GrowthSummary = {
  balance: 0,
  totalEarned: 0,
  level: 1,
  toNextLevel: 200,
  checkedInToday: false,
  badges: [],
};

export function useGrowth() {
  const [summary, setSummary] = useState<GrowthSummary>(EMPTY_SUMMARY);
  const [history, setHistory] = useState<GrowthEntry[]>([]);
  const [myBounties, setMyBounties] = useState<Bounty[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    /**
     * 悬赏那一路**单独包一层**：它是"与悬赏打通"那一块的数据，缺了只该让那一块空着。
     *
     * ⚠️ 两个理由都成立，缺一不可：
     *   ① 它跑在一屏的三路并发里，抛出去会把**成长主卡片**一起打成错误态；
     *   ② 这条路的**入口**（`bountyList`）在旧夹具/旧预加载上可能压根不存在，
     *      直接调会 `TypeError` —— 那是夹具差异，不该算用户的错。
     */
    const loadBounties = async (): Promise<Bounty[]> => {
      try {
        const res = await window.clawwork.bountyList({ status: null });
        if (!res.ok) return [];
        // ⭐ 只留**我发布**或**我领取**的：成长中心要回答的是"我的成长值从哪来/去哪了"，
        //    别人的悬赏在这里是噪音。判据来自服务端回包（`is_mine` / `is_claimed_by_me`），
        //    前端不自己推算归属。
        return normalizeBounties(res.result).filter((bounty) => bounty.isMine || bounty.isClaimedByMe);
      } catch {
        return [];
      }
    };

    const [summaryRes, historyRes, bounties] = await Promise.all([
      window.clawwork.growthSummary(),
      window.clawwork.growthHistory({ limit: 50 }),
      loadBounties(),
    ]);

    if (!summaryRes.ok) {
      setError(describeGrowthError(summaryRes.errorCode));
      return;
    }
    setError(null);
    setSummary(normalizeGrowthSummary(summaryRes.result));
    // 明细失败不影响主卡片：只把列表留空，不把整页打成错误态
    setHistory(historyRes.ok ? normalizeGrowthHistory(historyRes.result) : []);
    setMyBounties(bounties);
  }, []);

  useEffect(() => {
    void load().finally(() => setLoading(false));
  }, [load]);

  const checkIn = useCallback(async () => {
    setBusy(true);
    try {
      const res = await window.clawwork.growthCheckIn();
      if (!res.ok) {
        toast.error(describeGrowthError(res.errorCode));
        return;
      }
      await load();
    } finally {
      setBusy(false);
    }
  }, [load]);

  return { summary, history, myBounties, loading, error, busy, checkIn, reload: load };
}
