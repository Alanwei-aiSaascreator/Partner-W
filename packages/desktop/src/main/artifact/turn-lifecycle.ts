/**
 * ⚠️ DOCX-205 合同（2026-10-10）B 块：主进程侧「这个会话的这一轮还在跑吗」的软状态。
 *
 * 信号 = 网关 `agent.lifecycle.start/end/error`（每轮都发、带 sessionKey；
 * 与渲染层 `processingBySession` 同源，见 core `gateway-dispatcher` 的同名事件）。
 * 消费方只有一处：`data-handlers.isArtifactTurnInFlight`（普通发送单飞的主进程门）。
 *
 * `end`（或 `error`）之后按 {@link RELEASE_GRACE_MS} 做**一次有界核验**：
 * 该会话里还没被终态消息 claim 的 active run（bare final / 迟到核实留下的僵尸）
 * 会被释放 —— 否则它们要挂到 run 自己的 15 分钟 TTL，把用户卡在
 * 「上一项仍在处理」。正常轮次在 end 之后几十毫秒内终态消息就会 claim，
 * 宽限计时器到点时队列里已没有可释放的 run（no-op）。
 *
 * 释放的其余路径全是真实事件：停止（`ws:abort-chat`）/ 发送失败（ws-handlers catch）/
 * 交付 settled（finalize 的 finally）/ 15 分钟 TTL 兜底（见 data-handlers 的
 * settleLiveTurnOnRunExpiry）。没有固定 sleep。
 *
 * ⭐ B1（2026-10-11 整改）：软状态**绑定网关归属**（Map<sessionKey, gatewayId>）——
 * 升级忙态（`update-handlers.isAppBusy` 的 ②）把它算作"还有真实任务在跑"，所以：
 *  - **永久移除/失败终结**（连接被 destroy、重连彻底 gaveUp）⇒ 必须释放**这个网关**
 *    自己的记录（否则那个永不消失的 true 会把升级永久挡在门外）；
 *  - **短暂断连**（socket close，客户端还在重连）⇒ 绝不直接清空（那一轮可能还在跑）；
 *  - **重连成功** ⇒ 与真实 run 状态核对（{@link reconcileGatewayTurnSessions}），
 *    只有拿到"这一轮已终结"的真实证据才落地，回答"仍在跑/未知"一律保守保留；
 *  - 释放的只是软状态，**不释放 run 单飞门**（未 claim 的 run 仍由
 *    `isArtifactTurnInFlight` 的队列判据挡着，写盘/登记不会被提前放行）。
 */
import { parseTaskIdFromSessionKey } from '@clawwork/shared';
import { getDebugLogger } from '../debug/index.js';
import { emitMainExecutionEvents, type MainExecutionEventInput } from './execution-events.js';

const RELEASE_GRACE_MS = 15_000;

/**
 * ⭐ V3-artifact（2026-10-13/14）：停止事件的**归属上下文**（可选）。
 *
 * `runId` 是投影的硬门槛（runId='' 的事件归约层整条拒收）——主进程的 stop ticket
 * 本身不带 runId，所以由**调用方**（`ws:abort-chat` 等，手里有本轮 run 身份）在
 * 发起停止时显式传入；缺省 ⇒ 本轮不发事件（fail-closed，不猜一个 run 归属）。
 * `taskId` 缺省时按会话键的既定格式派生（`agent:…:<taskId>`）。
 */
export interface TurnStopEventContext {
  runId?: string;
  taskId?: string;
  reason?: string;
}

/**
 * 软状态 = sessionKey → 归属网关（`noteGatewayTurnLifecycle` 随帧带上来）+ 起始时刻。
 *
 * 归属的空串 = "不知道是谁的"（旧调用点/测试直接驱动）。释放接口只认**精确相等**，
 * 所以一个真实网关的 destroy 永远动不到这些匿名记录。
 * `since` 供重连核对用：只有"这一轮开始**之后**"的真实终态记录才算它的收尾证据。
 */
const liveTurnSessions = new Map<string, { gatewayId: string; since: number }>();
const releaseTimers = new Map<string, ReturnType<typeof setTimeout>>();
let releaseHandler: ((sessionKey: string) => void) | null = null;

/**
 * ⭐ B1（2026-10-11 整改 · 复审二轮）：**未确认的停止** —— 「可核对的同轮状态」。
 *
 * 停止入口（`ws:abort-chat` / 会话重置 / 删除）都会**先本地取消 run**（删掉队列与完成
 * 记录）。复审原话：*失败的 abort 不能凭本地删除记录就宣称远端已结束* —— 所以本地取消
 * 之后软状态**保留**，并把"这一轮被停止过、还没确认"记在这里（sessionKey → 归属网关 +
 * 轮次起始时刻）。落地路径全是**确认过的真实证据**：
 *  - 真实终态事件（lifecycle end/error、chat aborted）到达 ⇒ 自然释放；
 *  - 下一次**重连成功** ⇒ {@link retryPendingGatewayTurnStops} 补发一次 abort，网关真的
 *    应答了（aborted true=已中止 / false=本来就没有在跑）⇒ 确认的生命周期证据，落地；
 *  - 重连耗尽 / 连接被移除 ⇒ {@link releaseGatewayTurnSessions} 一并落地（有界）。
 *
 * 身份判据 = **ticket 对象身份**（复审三轮）：每次停止操作在 await 前捕获自己的 ticket
 * （{@link noteGatewayTurnStop} 的返回值），确认时只许消费**同一个对象**（`gatewayId`/
 * `since` 全等只是第二道核对）—— 迟到的旧回执既不能结算新轮，也不能删新轮的恢复记录。
 */
const pendingTurnStops = new Map<string, { gatewayId: string; since: number }>();

/**
 * 会话 → 真实 run 状态（由 `data-handlers` 注册）。重连核对用：
 *  - `running`：run 队列里还有活跃/已 claim 的 run ⇒ 这一轮真实在跑；
 *  - `ended`  ：有真实终态证据（run 被取消、或终态消息已经 claim 过）⇒ 软状态是陈旧的；
 *  - `unknown`：没有可判定的记录 ⇒ 保守保留（宁可等真实 end 事件）。
 * `sinceMs` = 这轮软状态的起始时刻（更早的记录说的不是这一轮）。
 */
export type SessionTurnRunState = 'running' | 'ended' | 'unknown';
let runStateProbe: ((sessionKey: string, sinceMs: number) => SessionTurnRunState) | null = null;

/** 由 `data-handlers` 在模块加载时注册（释放该会话里未被 claim 的 active run）。 */
export function registerTurnReleaseHandler(handler: (sessionKey: string) => void): void {
  releaseHandler = handler;
}

/** 由 `data-handlers` 在模块加载时注册（重连核对：这个会话真实 run 状态）。 */
export function registerTurnRunStateProbe(probe: (sessionKey: string, sinceMs: number) => SessionTurnRunState): void {
  runStateProbe = probe;
}

/** 该会话的宽限计时器落地（半途被新 start/其它释放路径取代时也要清）。 */
function clearReleaseTimer(sessionKey: string): void {
  const timer = releaseTimers.get(sessionKey);
  if (timer) {
    clearTimeout(timer);
    releaseTimers.delete(sessionKey);
  }
}

/**
 * 一轮的软状态整体落地：软状态 + 宽限计时器 + 未确认停止记录（三者说的是同一轮）。
 * ⚠️ 只动软状态，**不取消/放行任何 run**（run 有自己的真实释放路径，见文件头注释）。
 */
function dropLiveTurn(sessionKey: string): void {
  liveTurnSessions.delete(sessionKey);
  pendingTurnStops.delete(sessionKey);
  clearReleaseTimer(sessionKey);
}

/** stop ticket 的稳定 id（投影的 `cancel.*` 用它核对"同一次操作"，见 V3 cancel 族）。 */
function stopTicketId(ticket: Readonly<{ gatewayId: string; since: number }>): string {
  return `${ticket.gatewayId}|${ticket.since}`;
}

/**
 * ⭐ V3-artifact：把一次停止状态变化折回渲染层投影（`cancel.requested/confirmed/unconfirmed`）。
 *
 * fail-closed：拿不到 taskId/runId（调用方没给上下文）⇒ `emitMainExecutionEvents` 直接不发 ——
 * 投影是 run 归属的，宁缺勿猜（旧接线行为 = 不发，UI 走既有 stop ticket 自己的显示）。
 */
function emitCancelEvent(
  sessionKey: string,
  gatewayId: string,
  context: TurnStopEventContext | undefined,
  event: MainExecutionEventInput,
): void {
  const taskId = context?.taskId ?? parseTaskIdFromSessionKey(sessionKey) ?? undefined;
  if (!taskId) return;
  emitMainExecutionEvents({ taskId, sessionKey, runId: context?.runId, gatewayId }, [event]);
}

export function noteGatewayTurnLifecycle(
  phase: 'start' | 'end' | 'error',
  sessionKey: string | undefined,
  gatewayId?: string,
): void {
  if (!sessionKey) return;
  clearReleaseTimer(sessionKey);
  if (phase === 'start') {
    // 新一轮开始 ⇒ 上一轮的"未确认停止"记录作废（它说的不是这一轮）。
    pendingTurnStops.delete(sessionKey);
    // 归属：这一帧的网关优先；没带（旧调用点/测试）就沿用已有归属，最后退回匿名。
    const owner = gatewayId ?? liveTurnSessions.get(sessionKey)?.gatewayId ?? '';
    liveTurnSessions.set(sessionKey, { gatewayId: owner, since: Date.now() });
    return;
  }
  liveTurnSessions.delete(sessionKey);
  pendingTurnStops.delete(sessionKey);
  if (phase === 'error') {
    // 致命错误（chat `error`/`aborted` 或 lifecycle `error`）= 这一轮**不会**再产出终态交付，
    // 队列里的 active run 立刻是僵尸 —— 立即释放（自动重发只等 ~1.5 秒，宽限来不及）。
    // 释放出口自带"会话正在跑就不动"的守卫（见 data-handlers.releaseStaleTurnRuns），
    // 所以紧随其后的重发轮不会被误伤。
    getDebugLogger().warn({
      domain: 'artifact',
      event: 'artifact.turn-release-on-error',
      data: { sessionKey },
    });
    releaseHandler?.(sessionKey);
    return;
  }
  const timerId = setTimeout(() => {
    releaseTimers.delete(sessionKey);
    getDebugLogger().warn({
      domain: 'artifact',
      event: 'artifact.turn-release-grace-elapsed',
      data: { sessionKey },
    });
    releaseHandler?.(sessionKey);
  }, RELEASE_GRACE_MS);
  timerId.unref?.();
  releaseTimers.set(sessionKey, timerId);
}

/** 渲染层探针用（测试/诊断）：这个会话现在是否处于「一轮在跑」。 */
export function isLiveTurnSession(sessionKey: string): boolean {
  return liveTurnSessions.has(sessionKey);
}

/**
 * ⭐ B1：这个网关被**永久移除 / 失败终结**（连接 destroy、重连耗尽 gaveUp）时的释放路径。
 *
 * 只释放**归属是这个网关**的会话（另一个网关仍在跑的记录一个都不许动），并清掉它们的
 * 宽限计时器（计时器属于已经消失的连接，没有意义了）。
 *
 * ⚠️ 只动软状态，**不取消 run**：run 有自己的真实释放路径（终态 claim / cancel / 15 分钟
 *    TTL），留着的 run 继续把普通发送单飞门关着 —— 释放软状态不允许提前放行写盘/登记。
 */
export function releaseGatewayTurnSessions(gatewayId: string, reason: string, context?: TurnStopEventContext): void {
  const released: string[] = [];
  for (const [sessionKey, owner] of [...liveTurnSessions]) {
    if (owner.gatewayId !== gatewayId) continue;
    // ⭐ V3-artifact：这一轮里有"未确认停止"而网关已终结/重连耗尽 ⇒ 再也不可能确认了 ——
    //    如实证 `cancel.unconfirmed`（**不显示"已停止"**），再落软状态。
    const pending = pendingTurnStops.get(sessionKey);
    if (pending && pending.gatewayId === gatewayId) {
      emitCancelEvent(sessionKey, gatewayId, context, {
        type: 'cancel.unconfirmed',
        payload: { stopTicketId: stopTicketId(pending), reason: 'gateway-terminated' },
      });
    }
    dropLiveTurn(sessionKey);
    released.push(sessionKey);
  }
  if (released.length === 0) return;
  getDebugLogger().warn({
    domain: 'artifact',
    event: 'artifact.turn-release-gateway-terminated',
    data: { gatewayId, reason, sessionCount: released.length, sessionKeys: released },
  });
}

/**
 * ⭐ B1：重连成功后的**核对**——短暂断连期间丢掉的终态事件（那一轮其实已经结束）不该
 * 让应用永久判忙；但"仍在跑"（run 队列里还有活跃/已 claim 记录）与"未知"（没有可判定
 * 的记录）一律**保守保留**，绝不清空。判定委托 `data-handlers` 注册的 run 状态探针。
 */
export function reconcileGatewayTurnSessions(gatewayId: string): void {
  if (runStateProbe === null) return;
  const released: string[] = [];
  for (const [sessionKey, owner] of [...liveTurnSessions]) {
    if (owner.gatewayId !== gatewayId) continue;
    if (runStateProbe(sessionKey, owner.since) !== 'ended') continue;
    dropLiveTurn(sessionKey);
    released.push(sessionKey);
  }
  if (released.length === 0) return;
  getDebugLogger().warn({
    domain: 'artifact',
    event: 'artifact.turn-reconcile-released',
    data: { gatewayId, sessionCount: released.length, sessionKeys: released },
  });
}

/**
 * ⭐ B1（复审二轮）：停止入口（`ws:abort-chat` / 会话重置 / 删除）的**本地结论交接**。
 *
 * `confirmed=false`：本地已取消 run，但 abort **还没有**被网关确认（未连上 / 调用失败）——
 * 软状态**保留**为「未确认停止」（见 {@link pendingTurnStops} 注释），等真实终态事件或
 * 重连核对落地。**失败的 abort 不许凭本地删除记录宣称远端已停**，这里就是那条纪律。
 * 返回值 = 这次操作的 **stop ticket**：调用方在 await 之前捕获，确认时原样带回。
 *
 * `confirmed=true`：abort RPC 已被网关处理（aborted true=已中止 / false=本来就没有在跑，
 * 两种应答都算）——**确认的生命周期证据**。⭐ 复审三轮：确认必须携带**发起这次操作时
 * 捕获的 ticket**，只有它与当前 pending 是**同一个对象**、且软状态仍是那一轮
 * （`gatewayId` + `since` 全等）才落地；没有 ticket / ticket 已被替换 ⇒ **一个字节都不动**
 * （迟到的回执只许结算它自己的那次操作，不许误清新轮、也不许删新轮的恢复记录）。
 * 消费成功时返回被消费的 ticket（重连补发用它落"已确认"诊断），否则返回 `undefined`。
 */
export function noteGatewayTurnStop(
  sessionKey: string,
  confirmed: boolean,
  expected?: Readonly<{ gatewayId: string; since: number }>,
  context?: TurnStopEventContext,
): Readonly<{ gatewayId: string; since: number }> | undefined {
  if (confirmed) {
    const pending = pendingTurnStops.get(sessionKey);
    const live = liveTurnSessions.get(sessionKey);
    if (!expected || pending !== expected) return;
    if (!live || live.gatewayId !== expected.gatewayId || live.since !== expected.since) return;
    getDebugLogger().warn({
      domain: 'artifact',
      event: 'artifact.turn-release-stop-confirmed',
      data: { sessionKey, gatewayId: live.gatewayId },
    });
    // ⭐ V3-artifact：网关已处理这次 abort（aborted true/false 都算）⇒ cancel.confirmed。
    //    ticketId 与 requested 那次逐字相同 —— 投影据此核"同一次操作"，旧 ticket 不清新 run。
    emitCancelEvent(sessionKey, live.gatewayId, context, {
      type: 'cancel.confirmed',
      payload: { stopTicketId: stopTicketId(expected) },
    });
    dropLiveTurn(sessionKey);
    return expected;
  }
  const live = liveTurnSessions.get(sessionKey);
  if (!live) return; // 没有在跑的轮次：没有可核对的软状态（已释放/从未建立）。
  const ticket = { gatewayId: live.gatewayId, since: live.since };
  pendingTurnStops.set(sessionKey, ticket);
  getDebugLogger().warn({
    domain: 'artifact',
    event: 'artifact.turn-stop-unconfirmed',
    data: { sessionKey, gatewayId: live.gatewayId },
  });
  // ⭐ V3-artifact：点击停止（本地已取消 run、远端 abort 在途/未达）⇒ cancel.requested。
  emitCancelEvent(sessionKey, live.gatewayId, context, {
    type: 'cancel.requested',
    payload: { stopTicketId: stopTicketId(ticket), ...(context?.reason ? { reason: context.reason } : {}) },
  });
  return ticket;
}

/**
 * ⭐ V3-artifact（2026-10-13/14）：停止的 abort **被拒/超时**时的具名出口（`ws:abort-chat` 的
 * catch / 未连接分支调用；调用方在 await 前捕获 ticket 原样带回）。
 *
 * 语义（计划 §V3 取消红例）：**不显示"已停止"** —— 如实折一条 `cancel.unconfirmed`；
 * 但**不落软状态**：既有"未确认停止"的记录保留，重连补发（`retryPendingGatewayTurnStops`）
 * 或网关终结（`releaseGatewayTurnSessions`）仍是它的收口路径（本条只是把"未确认"这一事实
 * 也告诉投影）。ticket 身份不符（迟到/被替换）⇒ 一个字节都不动。
 */
export function noteGatewayTurnStopRejected(
  sessionKey: string,
  ticket: Readonly<{ gatewayId: string; since: number }>,
  reason: string,
  context?: TurnStopEventContext,
): boolean {
  const pending = pendingTurnStops.get(sessionKey);
  if (!pending || pending !== ticket) return false;
  emitCancelEvent(sessionKey, ticket.gatewayId, context, {
    type: 'cancel.unconfirmed',
    payload: { stopTicketId: stopTicketId(ticket), reason },
  });
  return true;
}

/**
 * ⭐ B1（复审二轮）：重连成功后的**恢复出口** —— 对每个「未确认停止」补发一次 abort
 * （现在网关可达了）。应答（无论 aborted true/false）⇒ 已确认 ⇒ 软状态落地；仍失败 ⇒
 * 保留，等下一次重连或连接终结（{@link releaseGatewayTurnSessions}）有界收口。
 *
 * ⭐ 复审三轮 · 顺序安全性：补发把**捕获到的那条 pending 对象本身**交给确认函数 ——
 * 一次回执只许结算 await 之前捕获的那次操作。期间换了新轮（新 start / 终态 / 其它释放
 * 路径）⇒ 确认不消费（也不删新轮的 pending），B 的恢复记录留给下一次补发。
 * 只动软状态：不取消/放行任何 run（写盘/登记的单飞门语义原样）。
 */
export async function retryPendingGatewayTurnStops(
  gatewayId: string,
  abort: (sessionKey: string) => Promise<unknown>,
): Promise<void> {
  for (const [sessionKey, pending] of [...pendingTurnStops]) {
    // 身份判据：这条记录必须仍是**当时那一份**（期间被替换/落地的一律不动）。
    if (pending.gatewayId !== gatewayId || pendingTurnStops.get(sessionKey) !== pending) continue;
    const live = liveTurnSessions.get(sessionKey);
    // 这一轮已被替换/释放（新 start、真实终态、其它释放路径）⇒ 旧停止记录作废
    // （只在仍是同一条记录时删 —— 绝不动期间换上的新记录）。
    if (!live || live.gatewayId !== pending.gatewayId || live.since !== pending.since) {
      if (pendingTurnStops.get(sessionKey) === pending) pendingTurnStops.delete(sessionKey);
      continue;
    }
    try {
      await abort(sessionKey);
    } catch {
      continue; // 仍未可达：保留待核对。
    }
    // One receipt can only settle the operation captured before await.
    if (noteGatewayTurnStop(sessionKey, true, pending)) {
      getDebugLogger().warn({
        domain: 'artifact',
        event: 'artifact.turn-release-stop-confirmed-on-reconnect',
        data: { sessionKey, gatewayId },
      });
    }
  }
}

/**
 * ⭐ 升级忙态（2026-10-11）：**任一**会话还有一轮在跑（主进程侧软状态）。
 * 消费方 = `update-handlers.isAppBusy` 的边界复查——堵住"渲染层推送尚未到达/已落后"的竞态窗，
 * 保证「生成期间不退出应用、不启动替换」不只挂在 UI 按钮上。
 */
export function hasLiveTurnSessions(): boolean {
  return liveTurnSessions.size > 0;
}

/**
 * 终态消息已经 claim 掉这个会话的 run（执行终态 + 交付链启动）：
 * 软状态立即落地，宽限计时器不再需要（队列里已无可释放的 run）。
 */
export function settleLiveTurn(sessionKey: string): void {
  dropLiveTurn(sessionKey);
}

/** 测试用：整表复位（模块级状态）。 */
export function resetTurnLifecycleForTests(): void {
  for (const timer of releaseTimers.values()) clearTimeout(timer);
  releaseTimers.clear();
  liveTurnSessions.clear();
  pendingTurnStops.clear();
  runStateProbe = null;
}
