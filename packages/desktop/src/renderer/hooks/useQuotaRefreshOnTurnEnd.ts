import { useEffect, useRef } from 'react';
import { useMessageStore } from '../stores/messageStore';
import { useCommercialStore } from '../stores/commercialStore';

/**
 * 余额（积分）的**主动刷新调度**。
 *
 * 名字是历史（2026-09-12 它的职责只有"一轮对话结束后把额度拉新"），
 * 2026-10-15 起扩成四类触发 —— 名字保留是为了不动既有引用：
 *
 *   ① **回合结束**（忙→闲）：先 `commercialUsageReport()` 把本机累计量推上去，
 *      再 `refresh()` 拉服务端额度。**顺序不能反**：走本地 provider 的调用只有
 *      推上去才会计费，反过来的话拉到的还是上一次推送前的旧值。
 *      随后做**有界追读**（见下）。
 *   ② **消费进行中**（busy）：按 `QUOTA_BUSY_POLL_MS` 节奏主动刷新 —— 否则
 *      会长任务一路忙，已经结算的费用一直不更新。空闲即停，**不是**无限轮询。
 *   ③ **回前台**：`visibilitychange` / `focus` 立刻补一次（期间可能已经结算了几笔）。
 *   ④ 支付成功由调用方（充值流程）自己 `refresh()` —— store 的 `refresh` 是单飞的，
 *      多触发点不会堆叠。
 *
 * 三条边界（核查点名）：
 *
 * - **有界**：追读次数上限 `QUOTA_FOLLOW_UP_MAX`；退避上限 `QUOTA_BUSY_POLL_MAX_MS`；
 *   不可见时一个请求都不打。
 * - **单飞**：真正发请求的是 store 的 `refresh()`，它自己在飞的时候只合并（见
 *   `commercialStore`）—— 本 hook 只负责**什么时候**触发，不管"并发怎么挡"。
 * - **不重复上报**：用量上报只在回合结束那一次（本机累计量的增量上报是计费纪律）。
 *   节奏刷新与追读是**只读**的，不触发第二次上报，也不改价格/扣费/账本。
 *
 * ⚠️ 追读存在的原因：服务端是**先结束响应、再写账本**（`report_usage_v3` 在响应
 *    之后）。"回合结束"那一刻账本很可能还没提交 —— 只拉一次就会一直显示旧值，
 *    而用户看到的是"我花了钱但数字没动"。追读用"值有没有变"作为**提前停止**的判据：
 *    一旦读到新值（已结算）就停，最多追 `QUOTA_FOLLOW_UP_MAX` 次。
 *
 * ⚠️ 挂在 `App`（全程在挂），**不再挂 `MainArea`**：打开设置会卸载 MainArea
 *    （`App.tsx` 是 `settingsOpen ? <Settings/> : <MainArea/>`），而"留在账户页
 *    盯后台消费"正是这条刷新要覆盖的场景之一。
 */

/** 回合结束后的第一次读取（原 800ms 防抖，保持不变）。 */
export const QUOTA_SETTLE_MS = 800;
/** 消费进行中的主动刷新节奏。 */
export const QUOTA_BUSY_POLL_MS = 5_000;
/** 失败退避的上限 —— 有界：节奏只会拉长到这条线。 */
export const QUOTA_BUSY_POLL_MAX_MS = 60_000;
/** 追读间隔（覆盖"响应结束早于入账"的窗口）。 */
export const QUOTA_FOLLOW_UP_MS = 2_000;
/** 追读次数上限 —— 追完就停，交给下一轮触发。 */
export const QUOTA_FOLLOW_UP_MAX = 4;

export function useQuotaRefreshOnTurnEnd(): void {
  // 任一会话在跑就算忙。用「集合是否为空」而不是逐个会话比较：
  // 后者在会话切换时会产生假的「结束」跳变。
  const busy = useMessageStore((s) => s.processingBySession.size > 0);
  // 没账号（未登录/已登出）就什么都不排 —— 刷新的前提是有快照可写。
  const signedIn = useCommercialStore((s) => Boolean(s.overview?.account));
  const wasBusy = useRef(false);
  /**
   * 记住"刚刚在跑的会话"。
   *
   * `busy` 翻成 false 的那一刻集合**已经空了** —— 不留一份，"本轮消耗"就不知道该记到
   * 哪个会话名下，切换会话后会显示成别人的。集合只在**开跑/收工**时换引用（不是每个
   * 流式增量），所以这里的订阅不会变成 per-tick 重渲。
   */
  const processingBySession = useMessageStore((s) => s.processingBySession);
  const lastBusySessions = useRef<string[]>([]);
  useEffect(() => {
    if (processingBySession.size > 0) lastBusySessions.current = [...processingBySession];
  }, [processingBySession]);

  useEffect(() => {
    if (!signedIn) {
      // 登出/切号：停掉全部调度。已经飞出去的那些回包由 store 的代次守卫作废
      // （`clearCache` 递增 accountEpoch/readSequence）。
      wasBusy.current = false;
      return;
    }

    let cancelled = false;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const later = (fn: () => void, ms: number): void => {
      const id = setTimeout(() => {
        timers.delete(id);
        if (!cancelled) fn();
      }, ms);
      timers.add(id);
    };
    const refresh = (): Promise<void> => useCommercialStore.getState().refresh();
    const usedMicros = (): number | null => useCommercialStore.getState().overview?.license?.tokenUsedMicros ?? null;
    const visible = (): boolean => typeof document === 'undefined' || document.visibilityState !== 'hidden';

    // ① 回合结束（忙→闲）
    const turnedIdle = !busy && wasBusy.current;
    if (busy) wasBusy.current = true;
    if (turnedIdle) {
      wasBusy.current = false;
      let followUpsLeft = QUOTA_FOLLOW_UP_MAX;
      const readOnce = async (withReport: boolean): Promise<void> => {
        if (cancelled) return;
        const before = usedMicros();
        if (withReport) {
          try {
            await window.clawwork.commercialUsageReport();
          } catch {
            // 上报失败不影响下一步：refresh 仍然可能拿到服务端已经记好的账。
          }
        }
        // Hidden completion must still report usage once, but quota reads wait for
        // foreground. Recheck after the await: logout/hide can happen mid-report.
        if (cancelled || !visible()) return;
        await refresh();
        if (cancelled) return;
        const after = usedMicros();
        // 值涨了 ⇒ 这一轮已入账。差额就是**本轮消耗**，交给 store 去显示。
        // （差额是服务端口径：1 积分 = 1e6 微积分，见 lib/utils.ts 的 MICROS_PER_CREDIT。）
        if (after !== null && before !== null && after > before) {
          useCommercialStore.getState().recordTurnSpend(lastBusySessions.current, after - before);
        }
        // 值变了（含被调整变小）⇒ 已结算，追读到此为止。
        if (after !== before) return;
        // 没变 ⇒ 账本可能还没提交：在配额内再追一次（不可见时不追，回前台会补）。
        if (followUpsLeft <= 0 || !visible()) return;
        followUpsLeft -= 1;
        later(() => void readOnce(false), QUOTA_FOLLOW_UP_MS);
      };
      later(() => void readOnce(true), QUOTA_SETTLE_MS);
    }

    // ② 消费进行中的节奏刷新（有界退避）
    let failures = 0;
    const tick = (): void => {
      if (cancelled) return;
      if (!visible()) {
        // 窗口不可见：不打点，但保持节奏链（回前台那一刻由 ③ 立刻补一次）。
        later(tick, QUOTA_BUSY_POLL_MS);
        return;
      }
      void (async () => {
        await refresh();
        if (cancelled) return;
        failures = useCommercialStore.getState().status === 'ready' ? 0 : failures + 1;
        later(tick, Math.min(QUOTA_BUSY_POLL_MS * 2 ** failures, QUOTA_BUSY_POLL_MAX_MS));
      })();
    };
    if (busy) later(tick, QUOTA_BUSY_POLL_MS);

    // ③ 回前台（连着 alt-tab 不该变成一串读取：同一节奏内只补一次）
    let lastForegroundAt = 0;
    const onForeground = (): void => {
      if (!visible()) return;
      const now = Date.now();
      if (now - lastForegroundAt < QUOTA_BUSY_POLL_MS) return;
      lastForegroundAt = now;
      void refresh();
    };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onForeground);
    if (typeof window !== 'undefined') window.addEventListener('focus', onForeground);

    return () => {
      cancelled = true;
      for (const id of timers) clearTimeout(id);
      timers.clear();
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onForeground);
      if (typeof window !== 'undefined') window.removeEventListener('focus', onForeground);
    };
  }, [busy, signedIn]);
}
