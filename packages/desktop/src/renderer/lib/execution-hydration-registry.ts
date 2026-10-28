import type { ExecutionProjection } from '@clawwork/core';
import { useMessageStore } from '../stores/messageStore';

/**
 * ⭐ 2026-10-14 五小时窗（R2/R5 接线）：**恢复（hydrate）标记登记表**。
 * ⭐ 第三轮（I-3，2026-10-14）收口：标记必须**绑定被恢复的投影版本**，不再是裸 run 集合。
 *
 * 本地执行历史的恢复应用是"把旧证据重新装进投影"，**不是现场完成** —— 但投影本身
 * 分辨不出"这条终态是刚刚现场发生、还是刚从磁盘恢复的"（同一条 run、同一个终态）。
 * 旧实现只按 `session|run` 打标、由通知出口"下一次 effect 消费"，若同一 React 批次里
 * 恢复之后又到达真正的 live 终态，hook 会把**最新 live 投影**误当历史定格终态登记，
 * 真正的 live 完成被永久静默（复审 I-HYDRATE-1 实跑反例）。
 *
 * 现语义：`markRunHydrated` 在**恢复应用之后**调用（恢复接线只在接受数 > 0 时调用），
 * 记下当时的**不可变投影对象引用**（core 归约不改旧对象：任何后续变化都会换引用）与
 * 当时轮次开启状态。通知出口只抑制"当前投影仍 === 被记录的历史版本"的那次评估
 * （并把该历史定格终态按已通知入册）；引用不一致（live 已推进）⇒ 照常按 live 评估。
 *
 * 有界：超过上限逐出最旧（正常使用只有激活任务时才会恢复，256 条富余）。
 */
export interface HydratedRunSnapshot {
  /** 恢复应用产生/落定的投影对象（不可变引用；仅作身份比较，不重新读取）。 */
  projection: ExecutionProjection;
  /** 登记时该会话轮次是否开启（历史定格终态的封口条件之一）。 */
  turnOpen: boolean;
}

const MAX_HYDRATED_RUNS = 256;
const snapshots = new Map<string, HydratedRunSnapshot>();

function runKeyOf(sessionKey: string, runId: string): string {
  return `${sessionKey}|${runId}`;
}

/**
 * 登记一次恢复（必须在 hydrate 应用**之后**调用）：绑定当前投影引用与轮次状态。
 * 无投影（无可绑定的历史版本）⇒ 清除同键旧标记、不登记（宁缺勿猜）。
 */
export function markRunHydrated(sessionKey: string, runId: string): void {
  if (!sessionKey || !runId) return;
  const key = runKeyOf(sessionKey, runId);
  const state = useMessageStore.getState();
  const projection = state.executionBySession[sessionKey];
  if (!projection) {
    snapshots.delete(key);
    return;
  }
  snapshots.delete(key); // 重新插入保持 LRU 序
  snapshots.set(key, { projection, turnOpen: Boolean(state.activeTurnBySession[sessionKey]) });
  if (snapshots.size > MAX_HYDRATED_RUNS) {
    const oldest = snapshots.keys().next().value;
    if (oldest !== undefined) snapshots.delete(oldest);
  }
}

export function getRunHydratedSnapshot(sessionKey: string, runId: string): HydratedRunSnapshot | undefined {
  return snapshots.get(runKeyOf(sessionKey, runId));
}

/** 只给测试：清空登记表（模块级状态）。 */
export function resetHydrationRegistryForTests(): void {
  snapshots.clear();
}
