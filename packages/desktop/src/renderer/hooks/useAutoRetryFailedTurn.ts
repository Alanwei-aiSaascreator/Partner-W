import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  activeTurnProducedOutput,
  findRetryTarget,
  type ActiveTurn,
  type AutoRetryFailure,
  type RetryTarget,
} from '@clawwork/core';
import {
  parseTaskIdFromSessionKey,
  type Artifact,
  type ArtifactDeliveryActivity,
  type Message,
} from '@clawwork/shared';
import { composer } from '@/platform';
import { useMessageStore } from '@/stores/messageStore';
import { useTaskStore } from '@/stores/taskStore';
import { useFileStore } from '@/stores/fileStore';
import { useDeliveryActivityStore } from '@/stores/deliveryActivityStore';
import { compareStore } from '../features/compare/compare-store-instance';

/**
 * 「整轮失败自动重发 1 次」（包 D，2026-10-07）。
 *
 * ## 为什么只重发**空转型**失败
 *
 * 本仓对"重试"早有一条写死的结论：重发同一句话，有的失败**换一次就能过**
 * （网络抖动 / 限流 / 上游瞬时异常），有的**再试一百次也一样**（模型拒答、
 * 上下文超长）。前者不重发是白等用户，后者重发是劝用户白花钱 + 可能重复副作用。
 * 分流放在 `gateway-dispatcher` 的登记点（确定性失败根本不登记 `AutoRetryFailure`，
 * 见 `message-store.ts` 的同名字段说明），这里负责第二道闸。
 *
 * ## 第二道闸之一：只有 `transient` 类别才发（BUG-050 收紧）
 *
 * 认不出来的（`unclassified`，含 malformed tool call / unknown / lifecycle 那种
 * 只有一句英文原文的失败）**一律不自动重发**：判不出"重发真能改变结果"就不该替用户
 * 再花一次钱，更不该拿不可逆的副作用去赌。登记照旧（排查现场），门在评估这里。
 *
 * ## 第二道闸之二：「零最终交付」严格判据
 *
 * 只有**这一轮什么也没交付**时才自动重发一次：
 *   - 本轮没有产出（**证据快照** `failure.producedOutput`，见下面 ⚠️）；
 *   - 该任务在本轮之内没有新产物（`artifacts.createdAt` 晚于本轮起点）；
 *   - 该任务没有**已结算**的交付（`succeeded` / `needs-review`）。
 * 三条**全为"零"**才发 —— 判据用"或"的话，一个已经写了一半的轮次也会被重发。
 *
 * ⚠️ **为什么必须读快照**（BUG-050）：dispatcher 的错误分支**先清 activeTurn、
 *    再登记候选**，1.5s 后这里现读 `activeTurnBySession` 恒为 `undefined` ——
 *    一个已经跑过 write/exec 的轮次会被判成"什么都没做"而整轮重发（副作用重复）。
 *    所以证据由 dispatcher 在清理**之前**快照进候选（`failure.producedOutput`）；
 *    这里**额外**再看一眼还活着的 activeTurn —— 迟到帧会把 turn 重新建出来
 *    （`appendStreamDelta` 在无 turn 时会新建），那同样是"已经出过东西"，也不许重发。
 *
 * ## 其余纪律
 *
 * - **1 次上限**：每条失败消息只自动一次（(taskId, messageId) 去重）；而且
 *   **我们自动重发出来的那轮再失败，不会触发第二次自动重发**（按"重发目标内容"
 *   记一笔，防环路——每条失败消息都可能是"新一轮"，只按消息去重挡不住环路）。
 * - **发送前二次校验**：定时器到点后**现读** store（触发时读的那份可能已经过期）：
 *   登记还在吗（有人手动重试过就会清）、该任务所有会话都空闲吗、还是不是临时会话。
 * - **发送走 `composer.send`**（唯一入口纪律，与手动「重试」同一条路）——
 *   计费口径因此天然一致。重发会多一条用户气泡，属**接受行为**（这也是先明示的原因）。
 * - **跳过临时会话**（多模型对比的某一列）：那列的失败只写它自己那一格，
 *   自动重发会以"普通会话"的身份把内容写进时间线。
 *
 * ⚠️ 挂 **App** 不挂 MainArea：打开设置会卸载 MainArea（同款教训见 App.tsx 里
 *    `useClaimGuardToast` / `useDocgenFailureToast` 的注释）。
 */

/**
 * 失败登记之后再等一拍才判。
 *
 * 登记本身已经过 2s 去重窗（dispatcher 那边），这一拍是留给**迟到帧与结算写入**的：
 * 判定"本轮零交付"必须基于已经稳定下来的现场，宁可晚 1.5 秒也不能误判成"什么都没做"。
 */
export const AUTO_RETRY_DELAY_MS = 1500;

export interface AutoRetryProbe {
  taskId: string;
  /** 登记时的类别：只有 `transient` 可能触发自动重发（见文件头「第二道闸之一」）。 */
  kind: AutoRetryFailure['kind'];
  messages: Message[];
  errorMessageId: string;
  /** dispatcher 在 `clearActiveTurn` **之前**取的「本轮已产出」证据快照（BUG-050）。 */
  producedOutput: boolean;
  /** 评估这一刻还活着的 activeTurn（迟到帧会把它重新建出来）——额外的兜底判据。 */
  activeTurn: ActiveTurn | undefined;
  artifacts: readonly Artifact[];
  deliveries: readonly ArtifactDeliveryActivity[];
}

export type AutoRetryVerdict =
  | { send: true; target: RetryTarget }
  | {
      send: false;
      reason: 'not-transient' | 'no-target' | 'no-anchor' | 'turn-output' | 'new-artifact' | 'delivery-settled';
    };

/**
 * 本轮起点 = 这条失败之前**最近一条用户消息**的时间（也就是 `findRetryTarget` 选中的那条）。
 *
 * ⚠️ 与 `findRetryTarget` 走的是同一个回扫：**故意不合并**——那边只负责"选要重发什么"
 *    （它的纪律是别替用户做决定），这里只要一个时间戳当产物窗口的起点。合并会逼着
 *    core 的返回类型多带一个只给自动重试用的字段（唯一的消费者就是本文件）。
 */
function resolveTurnStartMs(messages: Message[], errorMessageId: string): number | null {
  const errorIndex = messages.findIndex((message) => message.id === errorMessageId);
  if (errorIndex < 0) return null;
  for (let index = errorIndex - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (candidate.role !== 'user') continue;
    const at = Date.parse(candidate.timestamp);
    return Number.isFinite(at) ? at : null;
  }
  return null;
}

function hasArtifactSince(artifacts: readonly Artifact[], taskId: string, since: number): boolean {
  return artifacts.some((artifact) => {
    if (artifact.taskId !== taskId) return false;
    // 时间读不出来的产物**不算**新产物：那是数据异常，不是"已交付"的证据。
    const at = Date.parse(artifact.createdAt);
    return Number.isFinite(at) && at >= since;
  });
}

function hasSettledDeliverySince(
  deliveries: readonly ArtifactDeliveryActivity[],
  taskId: string,
  since: number,
): boolean {
  return deliveries.some(
    (entry) =>
      entry.taskId === taskId &&
      entry.startedAt >= since &&
      (entry.status === 'succeeded' || entry.status === 'needs-review'),
  );
}

function evaluateAutoRetry(probe: AutoRetryProbe): AutoRetryVerdict {
  // 类别门（BUG-050）：认不出来的（unclassified，含 malformed / unknown）不自动重发。
  if (probe.kind !== 'transient') return { send: false, reason: 'not-transient' };
  // 重发的目标与手动「重试」同一出口：这条失败之前最近的那条用户消息（附件原样带回）。
  const target = findRetryTarget(probe.messages, probe.errorMessageId);
  if (!target) return { send: false, reason: 'no-target' };
  const turnStartMs = resolveTurnStartMs(probe.messages, probe.errorMessageId);
  if (turnStartMs === null) return { send: false, reason: 'no-anchor' };
  // 产出判据两道：①登记时的证据快照（主判据，store 里已被清掉也读得到，BUG-050）；
  // ②还活着的 activeTurn（迟到帧重建出来的那种，兜底）。
  if (probe.producedOutput || activeTurnProducedOutput(probe.activeTurn)) {
    return { send: false, reason: 'turn-output' };
  }
  if (hasArtifactSince(probe.artifacts, probe.taskId, turnStartMs)) return { send: false, reason: 'new-artifact' };
  if (hasSettledDeliverySince(probe.deliveries, probe.taskId, turnStartMs)) {
    return { send: false, reason: 'delivery-settled' };
  }
  return { send: true, target };
}

export function useAutoRetryFailedTurn(): void {
  const { t } = useTranslation();
  const candidates = useMessageStore((state) => state.autoRetryFailureBySession);

  /** 已排期的重发（键 = taskId|messageId）——同一失败不会排两次。 */
  const scheduled = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  /** 已经处理过的失败消息（无论最终发没发）——每条只尝试一次。 */
  const attempted = useRef(new Set<string>());
  /** 我们已经替哪个任务重发过什么内容 —— 防环路（见头注释"1 次上限"）。 */
  const autoSentTargets = useRef(new Set<string>());

  // 卸载时清掉待发定时器（App 常驻，这条主要是给测试与热重载兜底）。
  useEffect(
    () => () => {
      for (const timer of scheduled.current.values()) clearTimeout(timer);
      scheduled.current.clear();
    },
    [],
  );

  useEffect(() => {
    const attempt = (sessionKey: string, failure: AutoRetryFailure): void => {
      const state = useMessageStore.getState();

      // ① 登记还在吗 —— 有人手动重试过的话，"空闲→忙"那一刻它就被清了。
      const current = state.autoRetryFailureBySession[sessionKey];
      if (!current || current.taskId !== failure.taskId || current.messageId !== failure.messageId) return;

      // ② 该任务**所有**会话都空闲才插手（会议/团队任务是多会话的，别的会话还在跑时不添乱）。
      for (const key of state.processingBySession) {
        if (parseTaskIdFromSessionKey(key) === failure.taskId) return;
      }

      // ③ 对比的临时列永远不自动重发。
      if (compareStore().getState().isEphemeral(sessionKey)) return;

      // ④ 任务得还在（被删掉的任务重发出去只会得到一条"发送失败"）。
      const task = useTaskStore.getState().tasks.find((entry) => entry.id === failure.taskId);
      if (!task) return;

      // ⑤ 类别门 + 零最终交付判据（纯函数，见上）。产出证据读**登记时的快照**
      //    （`failure.producedOutput`）—— 这一刻 store 里的 activeTurn 早被清理过了。
      const verdict = evaluateAutoRetry({
        taskId: failure.taskId,
        kind: failure.kind,
        messages: state.messagesByTask[failure.taskId] ?? [],
        errorMessageId: failure.messageId,
        producedOutput: failure.producedOutput,
        activeTurn: state.activeTurnBySession[sessionKey],
        artifacts: useFileStore.getState().artifacts,
        deliveries: Object.values(useDeliveryActivityStore.getState().records),
      });
      if (!verdict.send) {
        // 判据只进 console：用户面不需要看懂"我们为什么没重发"。
        console.debug('[auto_retry_failed_turn] skipped', {
          taskId: failure.taskId,
          messageId: failure.messageId,
          kind: failure.kind,
          reason: verdict.reason,
        });
        return;
      }

      // ⑥ 我们自己的重发不再重发：这轮失败的"目标用户消息"就是我们上一次重发的那句。
      const targetKey = `${failure.taskId}\n${verdict.target.content}`;
      if (autoSentTargets.current.has(targetKey)) return;
      autoSentTargets.current.add(targetKey);

      // ⑦ 先明示再发：用户马上会看到一条"凭空多出来的"用户气泡，得先说清楚它是谁。
      state.addMessage(failure.taskId, 'system', t('chatMessage.autoRetryNotice'), undefined, {
        sessionKey,
        persist: false,
      });
      void composer
        .send(failure.taskId, {
          content: verdict.target.content,
          ...(verdict.target.attachments?.length ? { messageAttachments: verdict.target.attachments } : {}),
        })
        // `send` 内部已把可预期的失败变成错误消息 + toast；能 reject 出来的是真意外，
        // 别让它变成没人看见的 unhandled rejection。
        .catch((err: unknown) => {
          console.error('[auto_retry_failed_turn_failed]', err);
        });
    };

    for (const [sessionKey, failure] of Object.entries(candidates ?? {})) {
      const id = `${failure.taskId}|${failure.messageId}`;
      if (attempted.current.has(id) || scheduled.current.has(id)) continue;
      const timer = setTimeout(() => {
        scheduled.current.delete(id);
        attempted.current.add(id);
        // 这是无人值守的定时器回调：同步抛出去会变成一条没人处理的全局错误，
        // 而且重发本身失败**不是**用户需要看见的事（发送路径自己有错误展示）。
        try {
          attempt(sessionKey, failure);
        } catch (err: unknown) {
          console.error('[auto_retry_failed_turn_threw]', err);
        }
      }, AUTO_RETRY_DELAY_MS);
      scheduled.current.set(id, timer);
    }
  }, [candidates, t]);
}
