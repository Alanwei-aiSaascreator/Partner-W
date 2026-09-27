import { useCallback, useEffect, useState } from 'react';
import {
  computeCheckInStreak,
  describeGrowthError,
  normalizeBounties,
  normalizeDailyTasks,
  normalizeGrowthHistory,
  normalizeGrowthSummary,
  shanghaiDate,
} from '@clawwork/core';
import type { Bounty, DailyTask, GrowthEntry, GrowthSummary } from '@clawwork/shared';
import { toast } from '@/lib/toast';

/**
 * 明细一次取多少条。
 *
 * ⚠️ 这个数还是**连续签到能不能算**的前提（见下）：只有"取的比上限少"才说明拿到了全量。
 */
const HISTORY_LIMIT = 50;

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
  const [dailyTasks, setDailyTasks] = useState<DailyTask[]>([]);
  /** 连续签到天数。**可能被截断时恒为 0**（见 `computeCheckInStreak` 的说明）。 */
  const [streak, setStreak] = useState(0);
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

    /**
     * 每日任务那一路**同样单独包一层**，理由与悬赏那条一样，但多一条：
     * 它是**新加的 IPC 入口**（`growth:task-list`），旧预加载上压根不存在，
     * 直接调会 TypeError。那是版本差异，不该让成长主卡片跟着崩。
     *
     * ⚠️ 返回空数组时界面**整块不出现**（见 `GrowthPanel`）—— 这一路坏掉的表现
     *    是"今天没有任务"，而不是一个空盒子。用不着为此新加一句文案。
     */
    const loadDailyTasks = async (): Promise<DailyTask[]> => {
      try {
        const res = await window.clawwork.growthDailyTaskList();
        if (!res.ok) return [];
        return normalizeDailyTasks(res.result);
      } catch {
        return [];
      }
    };

    const [summaryRes, historyRes, bounties, tasks] = await Promise.all([
      window.clawwork.growthSummary(),
      window.clawwork.growthHistory({ limit: HISTORY_LIMIT }),
      loadBounties(),
      loadDailyTasks(),
    ]);

    if (!summaryRes.ok) {
      setError(describeGrowthError(summaryRes.errorCode));
      return;
    }
    setError(null);
    setSummary(normalizeGrowthSummary(summaryRes.result));
    // 明细失败不影响主卡片：只把列表留空，不把整页打成错误态
    const history = historyRes.ok ? normalizeGrowthHistory(historyRes.result) : [];
    setHistory(history);
    /**
     * 🔴 **连续签到只有在"确定拿到了全量"时才算。**
     *
     * 取回来正好等于上限 ⇒ 后面很可能还有没取到的流水 ⇒ 签到那几天可能被挤出去了，
     * 那时数出来的天数**是错的**。算错比不显示更糟（用户以为记录断了），
     * 所以这种情况交给 `computeCheckInStreak` 返回 0，界面就不显示这一行。
     */
    setStreak(
      computeCheckInStreak(history, {
        today: shanghaiDate(),
        complete: historyRes.ok && history.length < HISTORY_LIMIT,
      }),
    );
    setMyBounties(bounties);
    setDailyTasks(tasks);
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

  /**
   * 领一个每日任务。
   *
   * ⚠️ 领完必须 `load()`：余额、等级、徽章、明细**四处**都会变，
   *    只把本地那一条标成"已领"会让界面和账本对不上。
   *
   * ⚠️ 界面上只给 `done && !claimed` 的任务画按钮，但**不代表点了就一定成**：
   *    服务端那道闸（迁移 065 的 `task_not_done`）才是判据 ——
   *    用户可能在另一个窗口/另一台机器上先领了。失败照常出中文原因。
   */
  const claimTask = useCallback(
    async (task: string) => {
      setBusy(true);
      try {
        const res = await window.clawwork.growthDailyTaskClaim({ task });
        if (!res.ok) {
          toast.error(describeGrowthError(res.errorCode));
          return;
        }
        await load();
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  return {
    summary,
    history,
    myBounties,
    dailyTasks,
    streak,
    loading,
    error,
    busy,
    checkIn,
    claimTask,
    reload: load,
  };
}
