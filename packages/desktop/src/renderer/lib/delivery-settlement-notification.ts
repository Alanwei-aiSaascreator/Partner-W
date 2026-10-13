/**
 * ⭐ V3-artifact（2026-10-13/14）：延后的"任务完成"通知 —— **由交付结算路径发**。
 *
 * 背景（V3 core 侧已就绪）：`chat.final` 不再直接弹"任务完成"——交付投影里有活动作业
 * （`delivery.phase === 'pending'`）时通知延后并留痕 `renderer.chat.task_complete_deferred`；
 * 普通聊天（无 operation 登记）照旧。补发就落在这里：交付投影走到 `settled` 且 outcome
 * 是 **complete / partial** 时，按与 `maybeNotify` 逐字同构的条件（窗口不聚焦 / 当前任务
 * 不是它）补一条系统通知。
 *
 * 分档（只认这两种，别的**不冒充"完成"**）：
 *  - complete ⇒ 「任务完成」（复用既有 `notifications.taskComplete`）；
 *  - partial  ⇒ 「部分完成」（新键 `notifications.taskPartiallyComplete`，九语言由 I 汇总）；
 *  - failed / unconfirmed ⇒ **不发"任务完成"**——失败/未确认的展示走既有交付失败通道
 *    （claim-guard / delivery-settled 的失败提示），不在这里把坏消息说成好消息。
 *
 * 去重：一次结算只发一次（键 = `sessionKey|runId|outcome`；同一轮的重复投影不重发）。
 *
 * ⚠️ 装配（在 App/Workspace 里调用本 hook）属 I 的公共接线——见报告 patch；本模块
 * 自身不引入新的 IPC、不新造状态（投影与任务标题都读既有 store）。
 */
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { parseTaskIdFromSessionKey } from '@clawwork/shared';
import { useMessageStore } from '../stores/messageStore';
import { useTaskStore } from '../stores/taskStore';

export type SettlementNotificationKind = 'complete' | 'partial';

/** 结算 outcome → 该发哪种"任务完成"通知；不发（null）时一个字节都不写。 */
export function settlementNotificationFor(outcome: string | undefined): SettlementNotificationKind | null {
  if (outcome === 'complete') return 'complete';
  if (outcome === 'partial') return 'partial';
  return null;
}

/** 与 dispatcher `maybeNotify` 同构的补发条件：窗口不聚焦，或当前任务不是它。 */
export function shouldNotifyDeliverySettlement(input: {
  focused: boolean;
  activeTaskId: string | null | undefined;
  taskId: string;
}): boolean {
  return !input.focused || input.activeTaskId !== input.taskId;
}

function notificationTitleKey(kind: SettlementNotificationKind): string {
  return kind === 'complete' ? 'notifications.taskComplete' : 'notifications.taskPartiallyComplete';
}

export function useDeliverySettlementNotification(): void {
  const { t } = useTranslation();
  const executions = useMessageStore((state) => state.executionBySession);
  const notified = useRef(new Set<string>());
  useEffect(() => {
    for (const [sessionKey, projection] of Object.entries(executions)) {
      const delivery = projection.delivery;
      if (delivery.phase !== 'settled') continue;
      const kind = settlementNotificationFor(delivery.outcome);
      if (!kind) continue;
      const taskId = parseTaskIdFromSessionKey(sessionKey);
      if (!taskId) continue;
      const key = `${sessionKey}|${projection.runId}|${delivery.outcome}`;
      if (notified.current.has(key)) continue;
      if (
        !shouldNotifyDeliverySettlement({
          focused: document.hasFocus(),
          activeTaskId: useTaskStore.getState().activeTaskId,
          taskId,
        })
      )
        continue;
      notified.current.add(key);
      const task = useTaskStore.getState().tasks.find((item) => item.id === taskId);
      const title = t(notificationTitleKey(kind));
      void Promise.resolve(window.clawwork.getSettings?.())
        .then((settings) => {
          // 与 maybeNotify 同一条纪律：用户关掉了"任务完成"通知就不发。
          if (settings?.notifications?.taskComplete === false) return;
          void window.clawwork.sendNotification?.({ title, body: task?.title || taskId, taskId });
        })
        .catch(() => {
          // 设置读不到 ⇒ 不发（守卫的旁路配套，不污染错误通道）。
        });
    }
  }, [executions, t]);
}
