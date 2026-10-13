/**
 * ⭐ 2026-10-14 五小时窗（R2/R5 接线）：**恢复（hydrate）标记登记表**。
 *
 * 本地执行历史的恢复应用是"把旧证据重新装进投影"，**不是现场完成** —— 但投影本身
 * 分辨不出"这条终态是刚刚现场发生、还是刚从磁盘恢复的"（同一条 run、同一个终态）。
 * 通知出口（`useDeliverySettlementNotification`）按本表对恢复 run 一律静默：
 * 历史恢复不得触发"任务完成"系统通知（复审 R5 旁路三）。
 *
 * 有界：超过上限逐出最旧（正常使用只有激活任务时才会恢复，256 条富余；即便发生逐出，
 * 通知出口的"现场目击"规则（first-sight：只在**封口之前**见过该 run 才可通知）
 * 仍会拦住从未现场出现过的 run —— 两层判据互为兜底）。
 */
const MAX_HYDRATED_RUNS = 256;
const hydrated = new Set<string>();

function runKeyOf(sessionKey: string, runId: string): string {
  return `${sessionKey}|${runId}`;
}

export function markRunHydrated(sessionKey: string, runId: string): void {
  if (!sessionKey || !runId) return;
  hydrated.add(runKeyOf(sessionKey, runId));
  if (hydrated.size > MAX_HYDRATED_RUNS) {
    const oldest = hydrated.values().next().value;
    if (oldest !== undefined) hydrated.delete(oldest);
  }
}

export function isRunHydrated(sessionKey: string, runId: string): boolean {
  return hydrated.has(runKeyOf(sessionKey, runId));
}

/** 只给测试：清空登记表（模块级状态）。 */
export function resetHydrationRegistryForTests(): void {
  hydrated.clear();
}
