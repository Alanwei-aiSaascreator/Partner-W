/**
 * ⭐ R5（2026-10-14 五小时窗集中修复）：**"任务完成"通知的唯一消费口** —— 由统一完成资格驱动。
 *
 * 背景：`chat.final` 不再直接弹"任务完成"（core 侧 dispatcher 只留痕
 * `renderer.chat.task_complete_deferred` 并交接）—— 复审旁路：
 *   ① final 当场看到 `delivery.phase === 'none'` 不能证明这是普通聊天（可信 operation
 *      登记经异步最终交付路径才到 renderer ⇒ 会"完成后又收到 started"）；
 *   ② 同 run 已 settled/failed/unconfirmed 时也不能沿用"完成"；
 *   ③ 需求集合没有"封口"条件。
 * 本 hook 消费 core 的**单一资格真源** `evaluateRunCompletion`（配
 * `deliveryRequirementsOf`），在**封口**后判定并只对现场转变发通知。
 *
 * ## 封口（seal）判据 = 模型相位结束 **且** 轮次关闭（`activeTurnBySession` 为空）
 *
 * 为什么"轮次关闭"是可信的登记窗口关闭信号：终稿路径的登记（`finalizeAssistantArtifacts`）
 * 发生在消息落盘时（`syncSessionMessages` 的 create-message 调用内），该登记广播**先于**
 * 同步响应到达渲染层；而轮次关闭（promote/clear）发生在同步响应之后。所以封口时
 * "这条 run 会不会还有 operation 进来"已经有答案 —— 不会。期间进行的登记（如视频
 * fence 在请求时登记）在封口前就已进投影。
 *
 * ## 历史恢复静默（旁路三半）
 *
 * 恢复应用（hydrate）会往投影里安装**旧**终态。两层判据保证不误报：
 *  - `execution-hydration-registry`：恢复接线在应用前打标，本 hook 见标即静默；
 *  - **现场目击**（first-sight）：本 hook 只为"封口之前亲眼见过"的 run 发通知 ——
 *    挂载时就已经是封口态的 run 一律按历史处理（App 全新启动时 hydrate 恰好先落/后落都不敏感）。
 *
 * ## 幂等
 *
 * 去重键 = `sessionKey|idempotencyKey`（`idempotencyKey = runId|status`，由 core 给出）：
 * 同一 run 同一资格只通知一次；`partial → complete` 这类真实升级是新键、允许补报一条。
 *
 * 分档（只认两种，别的**不冒充"完成"**）：complete ⇒「任务完成」；partial ⇒「部分完成」；
 * failed / unconfirmed / not-complete ⇒ 不发 —— 失败/未确认的展示走既有交付通道。
 */
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { deliveryRequirementsOf, evaluateRunCompletion } from '@clawwork/core';
import { parseTaskIdFromSessionKey } from '@clawwork/shared';
import { useMessageStore } from '../stores/messageStore';
import { useTaskStore } from '../stores/taskStore';
import { isRunHydrated } from './execution-hydration-registry';

export type SettlementNotificationKind = 'complete' | 'partial';

/** 完成资格 status → 该发哪种"任务完成"通知；不发（null）时一个字节都不写。 */
export function settlementNotificationForStatus(status: string | undefined): SettlementNotificationKind | null {
  if (status === 'complete') return 'complete';
  if (status === 'partial') return 'partial';
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

/** 封口判据（导出给测试钉死语义）：模型相位结束 且 轮次关闭。 */
export function isRunSealed(input: { modelPhase: string; turnOpen: boolean }): boolean {
  return input.modelPhase !== 'active' && !input.turnOpen;
}

function notificationTitleKey(kind: SettlementNotificationKind): string {
  return kind === 'complete' ? 'notifications.taskComplete' : 'notifications.taskPartiallyComplete';
}

const MAX_TRACKED_RUNS = 512;

export function useDeliverySettlementNotification(): void {
  const { t } = useTranslation();
  const executions = useMessageStore((state) => state.executionBySession);
  const activeTurns = useMessageStore((state) => state.activeTurnBySession);
  const notified = useRef(new Set<string>());
  /** runKey → 是否在**封口之前**现场见过（first-sight；历史恢复的旧 run 会是 false）。 */
  const witnessed = useRef(new Map<string, boolean>());
  useEffect(() => {
    for (const [sessionKey, projection] of Object.entries(executions)) {
      const runId = projection.runId;
      if (!runId) continue;
      const runKey = `${sessionKey}|${runId}`;
      const sealed = isRunSealed({ modelPhase: projection.modelPhase, turnOpen: Boolean(activeTurns[sessionKey]) });
      // 现场目击登记：一旦在未封口状态见过就永久为 true；从未见过（挂载即封口）保持 false。
      witnessed.current.set(runKey, witnessed.current.get(runKey) === true || !sealed);
      if (!sealed) continue;
      if (witnessed.current.get(runKey) !== true) continue; // 历史注入（挂载即封口）⇒ 静默
      if (isRunHydrated(sessionKey, runId)) continue; // 恢复应用 ⇒ 静默
      const verdict = evaluateRunCompletion(projection, deliveryRequirementsOf(projection, sealed));
      const kind = settlementNotificationForStatus(verdict.status);
      if (!kind) continue;
      const dedupeKey = `${sessionKey}|${verdict.idempotencyKey}`;
      if (notified.current.has(dedupeKey)) continue;
      const taskId = parseTaskIdFromSessionKey(sessionKey);
      if (!taskId) continue;
      if (
        !shouldNotifyDeliverySettlement({
          focused: document.hasFocus(),
          activeTaskId: useTaskStore.getState().activeTaskId,
          taskId,
        })
      )
        continue;
      notified.current.add(dedupeKey);
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
    // 有界（长会话不把两个 ref 表堆成泄漏）。
    if (notified.current.size > MAX_TRACKED_RUNS) {
      const oldest = notified.current.values().next().value;
      if (oldest !== undefined) notified.current.delete(oldest);
    }
    if (witnessed.current.size > MAX_TRACKED_RUNS) {
      const oldest = witnessed.current.keys().next().value;
      if (oldest !== undefined) witnessed.current.delete(oldest);
    }
  }, [executions, activeTurns, t]);
}
