/**
 * ⭐ R5（2026-10-14 五小时窗集中修复）：**"任务完成"通知的唯一消费口** —— 由统一完成资格驱动。
 *
 * 背景：`chat.final` 不再直接弹"任务完成"（core 侧 dispatcher 只留痕
 * `renderer.chat.task_complete_deferred` 并交接）。本 hook 消费 core 的**单一资格真源**
 * `evaluateRunCompletion`（配 `deliveryRequirementsOf`），只对现场转变发通知。
 *
 * ## 封口与登记回执（第二轮 R5 P1 收口）
 *
 * 复审实跑反例证明：`session-sync` 的 promote **先于** create-message 持久化清掉
 * activeTurn ⇒ "模型结束 + activeTurn 空"只代表**轮次关闭**，登记
 * （`finalizeAssistantArtifacts`/交付捕获）还可能在主进程路上。因此：
 *  - 空 operations **不是**"普通聊天"的证据（它只代表登记证据未到）；
 *  - 完成资格必须消费 main 的**登记回执**（`turn-registration` 通道落进
 *    `lib/turn-registration`）：无回执（'unknown'）一律不判 complete；回执到达后，
 *    需求 = 投影中已到达的 operations，全部结算才算 complete；`needs-review`
 *    （已知需求登记失败）永不回退成"明确零需求"。
 *
 * ## 历史恢复静默（旁路三半 / 第二轮 R2-8 收口）
 *
 * 恢复应用（hydrate）会往投影里安装**旧**终态。三层判据保证不误报：
 *  - `execution-hydration-registry`：恢复接线在**确实应用了旧证据**（接受数>0）时打标，
 *    标记**绑定当时被恢复的投影对象引用**（⭐ 第三轮 I-3：不再是一次性裸 run 集合）。
 *    本 hook 仅当**当前投影仍 === 该历史版本引用**时才按历史处理：不发通知、把该历史
 *    定格终态按已通知入册（幂等键）；引用不一致（live 已推进，含恢复与真实完成同批到达）
 *    ⇒ 照常走 live 评估。**不做永久 run 黑名单**：运行中 run 打开历史后，后续真实 live
 *    完成仍按资格通知一次；历史已 complete 后重复 live 终态由幂等键挡住、不重报；
 *  - **现场目击**（first-sight）：本 hook 只为"封口之前亲眼见过"的 run 发通知 ——
 *    挂载时就已经是封口态的 run 一律按历史处理。
 *
 * ## 幂等
 *
 * 去重键 = `sessionKey|idempotencyKey`（`idempotencyKey = runId|status`，由 core 给出）：
 * 同一 run 同一资格只通知一次；`partial → complete` 这类真实升级是新键、允许补报一条。
 *
 * 分档（只认两种，别的**不冒充"完成"**）：complete ⇒「任务完成」；partial ⇒「部分完成」；
 * failed / unconfirmed / not-complete ⇒ 不发 —— 失败/未确认的展示走既有交付通道。
 */
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import type { ExecutionProjection, TurnRegistrationStatus } from '@clawwork/core';
import { deliveryRequirementsOf, evaluateRunCompletion } from '@clawwork/core';
import { parseTaskIdFromSessionKey } from '@clawwork/shared';
import { useMessageStore } from '../stores/messageStore';
import { useTaskStore } from '../stores/taskStore';
import { getRunHydratedSnapshot } from './execution-hydration-registry';
import { getTurnRegistration, getTurnRegistrationVersion, subscribeTurnRegistration } from './turn-registration';

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

/** 封口判据（导出给测试钉死语义）：模型相位结束 且 轮次关闭。**登记回执另见 evaluateRunCompletion**。 */
export function isRunSealed(input: { modelPhase: string; turnOpen: boolean }): boolean {
  return input.modelPhase !== 'active' && !input.turnOpen;
}

/**
 * 历史定格终态（恢复静默入册用）：**只看投影本身**的定格证据，不依赖登记回执
 * （历史 run 的回执可能早已不在表内；这里问的是"从磁盘恢复的这个终态当时算不算完成"）。
 * 返回可通知分档（complete/partial 之一）或 null（未定格/不可通知分档）。
 */
export function historicalSettledNotificationKind(input: {
  projection: ExecutionProjection;
  sealed: boolean;
}): SettlementNotificationKind | null {
  const { projection, sealed } = input;
  if (!sealed) return null;
  if (projection.modelPhase === 'failed') return null; // failed 本就不发通知
  const keys = Object.keys(projection.delivery.operations);
  if (keys.length === 0) {
    return projection.modelPhase === 'ended' ? 'complete' : null;
  }
  const operations = keys.map((key) => projection.delivery.operations[key]);
  if (operations.some((operation) => !operation || operation.outcome === undefined)) return null; // 未结算 ⇒ 不是定格终态
  const outcomes = operations.map((operation) => operation!.outcome!);
  if (outcomes.every((outcome) => outcome === 'complete')) return 'complete';
  if (outcomes.some((outcome) => outcome === 'complete')) return 'partial';
  return null; // failed/unconfirmed 不通知
}

function notificationTitleKey(kind: SettlementNotificationKind): string {
  return kind === 'complete' ? 'notifications.taskComplete' : 'notifications.taskPartiallyComplete';
}

const MAX_TRACKED_RUNS = 512;

export function useDeliverySettlementNotification(): void {
  const { t } = useTranslation();
  const executions = useMessageStore((state) => state.executionBySession);
  const activeTurns = useMessageStore((state) => state.activeTurnBySession);
  // 登记回执到达也要触发重新评估（回执常晚于 promote/投影变化）。
  const registrationVersion = useSyncExternalStore(subscribeTurnRegistration, getTurnRegistrationVersion);
  const notified = useRef(new Set<string>());
  /** runKey → 是否在**封口之前**现场见过（first-sight；历史恢复的旧 run 会是 false）。 */
  const witnessed = useRef(new Map<string, boolean>());
  useEffect(() => {
    void registrationVersion;
    for (const [sessionKey, projection] of Object.entries(executions)) {
      const runId = projection.runId;
      if (!runId) continue;
      const runKey = `${sessionKey}|${runId}`;
      const sealed = isRunSealed({ modelPhase: projection.modelPhase, turnOpen: Boolean(activeTurns[sessionKey]) });
      // 现场目击登记：一旦在未封口状态见过就永久为 true；从未见过（挂载即封口）保持 false。
      witnessed.current.set(runKey, witnessed.current.get(runKey) === true || !sealed);
      // ⭐ 第三轮（I-3）：恢复静默**绑定被恢复的投影版本** —— 仅当当前投影仍是登记时的
      //    那个历史对象引用（`getRunHydratedSnapshot` 的不可变引用比较）才按历史处理：
      //    不发通知、把该历史定格终态按已通知入册。引用不一致（live 已推进，例如恢复与
      //    真实完成落在同一 React 批次）⇒ 不当历史，照常走 live 评估（复审反例的修复点）。
      const hydration = getRunHydratedSnapshot(sessionKey, runId);
      if (hydration && hydration.projection === projection) {
        const historicalKind = historicalSettledNotificationKind({
          projection,
          sealed: isRunSealed({ modelPhase: projection.modelPhase, turnOpen: hydration.turnOpen }),
        });
        if (historicalKind) notified.current.add(`${sessionKey}|${runId}|${historicalKind}`);
        continue;
      }
      if (!sealed) continue;
      if (witnessed.current.get(runKey) !== true) continue; // 历史注入（挂载即封口）⇒ 静默
      // ⭐ 第二轮（R5 P1）：完成资格消费**登记回执**——无回执不得判 complete
      //    （promote 清 activeTurn 时登记可能仍在主进程路上）。
      const registration: TurnRegistrationStatus = getTurnRegistration(sessionKey, runId)?.status ?? 'unknown';
      const verdict = evaluateRunCompletion(projection, deliveryRequirementsOf(projection, sealed, registration));
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
  }, [executions, activeTurns, registrationVersion, t]);
}
