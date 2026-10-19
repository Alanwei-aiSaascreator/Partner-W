/**
 * 「本次任务累计消耗」（2026-10-17 用户要求：任务结束末尾要看到花了多少积分）。
 *
 * 口径：
 *   · 每轮结束由 `useQuotaRefreshOnTurnEnd` 算出**本轮**微积分（`commercialStore.turnSpend`）；
 *   · 这里只做**按任务累加**，数据源就是那一个 `turnSpend.at` —— 用 `at` 去重，
 *     同一条结算被重放（重渲染 / 事件重放）不会重复计入；
 *   · 只存内存（与 `turnSpend` 同寿命），换任务/重启不影响服务端账本。
 *
 * 为什么不在主进程算：服务端只按许可证记总量，没有"任务"这一维；任务边界只有渲染层知道。
 */
export interface TaskSpendTotals {
  /** taskId → 微积分（1 积分 = 1e6 微积分）。 */
  totals: Record<string, number>;
  /** taskId → 已计入的最后一条 `turnSpend.at`（去重键）。 */
  lastAt: Record<string, number>;
}

export const EMPTY_TASK_SPEND: TaskSpendTotals = { totals: {}, lastAt: {} };

/**
 * 把一条本轮消耗并进累计。返回**同一对象**（引用不变）表示"什么都没变"，
 * 调用方据此跳过 setState —— 避免每轮都触发一次无意义的重渲染。
 */
export function addTurnSpend(
  state: TaskSpendTotals,
  taskId: string | undefined,
  micros: number,
  at: number,
): TaskSpendTotals {
  if (!taskId || !Number.isFinite(micros) || micros <= 0 || !Number.isFinite(at)) return state;
  if (state.lastAt[taskId] !== undefined && at <= state.lastAt[taskId]) return state;
  return {
    totals: { ...state.totals, [taskId]: (state.totals[taskId] ?? 0) + Math.round(micros) },
    lastAt: { ...state.lastAt, [taskId]: at },
  };
}
