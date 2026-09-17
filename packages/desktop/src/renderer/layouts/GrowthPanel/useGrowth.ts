import { useCallback, useEffect, useState } from 'react';
import { describeGrowthError, normalizeGrowthHistory, normalizeGrowthSummary } from '@clawwork/core';
import type { GrowthEntry, GrowthSummary } from '@clawwork/shared';
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [summaryRes, historyRes] = await Promise.all([
      window.clawwork.growthSummary(),
      window.clawwork.growthHistory({ limit: 50 }),
    ]);

    if (!summaryRes.ok) {
      setError(describeGrowthError(summaryRes.errorCode));
      return;
    }
    setError(null);
    setSummary(normalizeGrowthSummary(summaryRes.result));
    // 明细失败不影响主卡片：只把列表留空，不把整页打成错误态
    setHistory(historyRes.ok ? normalizeGrowthHistory(historyRes.result) : []);
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

  return { summary, history, loading, error, busy, checkIn, reload: load };
}
