import { and, eq } from 'drizzle-orm';
import type { BrowserWindow } from 'electron';
import type { ArtifactDeliverySettled } from '@clawwork/shared';
import { getDb, isDbReady } from '../db/index.js';
import { messages } from '../db/schema.js';

/**
 * r7-1 / F4（BUG-026 **跨重开残余**）：失败去重周期以"可信交付成功"为边界，而这个边界以前
 * 只活在渲染层 hook 的内存 ref 里 —— 应用重开后便签会按原 id/session 水合回来，边界却没了，
 * 于是同因新失败被历史便签吞掉（只通知 1 次，预期 2 次）。
 *
 * 这里落的是**不设窗口**的那份可恢复证据：产物交付**可信结算为 `succeeded`** 时，把
 * "这条消息的交付成功过"就地写进它的库行（`messages.delivery_succeeded`）。渲染层重开
 * 水合时按它（以及 `artifact:get-delivery-activity-snapshot` 的 256 条成功终态）重建边界。
 *
 * 纪律：
 * - **只在成功时**置位（failed / needs-review / canceled 一律不动 —— needs-review 是"未确认"，
 *   不是成功；把它当边界会让未解决的同一失败在中段重新刷屏）；
 * - 幂等：同一 messageId 重复结算（媒体补发等）重复置位无副作用；
 * - 不臆造：消息行不在（老数据/已删）就什么都不发生 —— "查不到"≠"没成功"，
 *   渲染层对找不到的证据一律回退到旧行为（全量扫描去重），不把缺失解释成成功或失败；
 * - 失败不可阻断结算事件本身：标记写不进去只记日志，照常广播。
 */
export function markMessageDeliverySucceeded(taskId: string, messageId: string): boolean {
  if (!taskId || !messageId || !isDbReady()) return false;
  try {
    getDb()
      .update(messages)
      .set({ deliverySucceeded: true })
      .where(and(eq(messages.id, messageId), eq(messages.taskId, taskId)))
      .run();
    return true;
  } catch (error) {
    console.warn('[artifact] delivery success marker unavailable:', error);
    return false;
  }
}

/**
 * 产物交付结算的**唯一出口**：`succeeded` 先落最小成功标记，再广播给所有窗口。
 *
 * 做成唯一出口（而不是在渲染层补一次写）是为了覆盖所有结算来源 —— 主交付链、历史/自动提取、
 * 媒体补发重放，任何一条路径 emit `succeeded` 都自动带上可恢复边界，未来新增结算点也不会漏。
 */
export function sendArtifactDeliverySettled(win: BrowserWindow, settlement: ArtifactDeliverySettled): void {
  if (settlement.status === 'succeeded') markMessageDeliverySucceeded(settlement.taskId, settlement.messageId);
  win.webContents.send('artifact:delivery-settled', settlement);
}
