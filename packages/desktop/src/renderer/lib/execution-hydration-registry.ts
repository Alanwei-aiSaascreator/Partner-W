/**
 * ⭐ 2026-10-14 五小时窗（R2/R5 接线）：**恢复（hydrate）标记登记表**。
 *
 * 本地执行历史的恢复应用是"把旧证据重新装进投影"，**不是现场完成** —— 但投影本身
 * 分辨不出"这条终态是刚刚现场发生、还是刚从磁盘恢复的"（同一条 run、同一个终态）。
 * 通知出口（`useDeliverySettlementNotification`）按本表**一次性消费**恢复标记：
 * 抑制"历史应用直接产生的那次状态变化"的通知，并把该终态按已通知消费（幂等键
 * 入册）—— 而不是把整个 run 永久列入免通知黑名单（第二轮 R2-8 收口：运行中 run
 * 打开历史后，后续真实 live 完成仍须按资格通知一次；历史已 complete 后重复
 * live 终态不得误重报 —— 由消费入册的幂等键挡住）。
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

/**
 * 消费恢复标记：返回 true = 本次评估来自（或紧随）一次恢复应用 ⇒ 抑制通知、
 * 把当前终态按已通知入册；标记随即清除 —— 后续 live 变化照常按资格评估。
 */
export function consumeRunHydrated(sessionKey: string, runId: string): boolean {
  const key = runKeyOf(sessionKey, runId);
  if (!hydrated.has(key)) return false;
  hydrated.delete(key);
  return true;
}

/** 只给测试：清空登记表（模块级状态）。 */
export function resetHydrationRegistryForTests(): void {
  hydrated.clear();
}
