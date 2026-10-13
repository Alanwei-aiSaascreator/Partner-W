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
import { randomUUID } from 'node:crypto';
import { parseTaskIdFromSessionKey } from '@clawwork/shared';
import { getDebugLogger } from '../debug/index.js';
import { getWorkspaceScope } from '../workspace/scope.js';
import { emitMainExecutionEvents, type MainExecutionEventInput } from './execution-events.js';

const RELEASE_GRACE_MS = 15_000;

/**
 * ⭐ V3-artifact（2026-10-13/14）：停止事件的**归属上下文**（可选）。
 *
 * `runId` 是投影的硬门槛（runId='' 的事件归约层整条拒收）——主进程的 stop ticket
 * 本身不带 runId，所以由**调用方**（`ws:abort-chat` 等，手里有本轮 run 身份）在
 * 发起停止时显式传入；缺省 ⇒ 本轮不发事件（fail-closed，不猜一个 run 归属）。
 * `taskId` 缺省时按会话键的既定格式派生（`agent:…:<taskId>`）。
 *
 * ⭐ R6（2026-10-14 五小时窗）：本上下文只在**创建 stop ticket 那一刻**被读取并**冻结**
 * 进 ticket（见 {@link GatewayTurnStopTicket}）。确认/拒绝/重连补发/网关终结等后续路径
 * 一律从原 ticket 取身份，**不再**从"当前前台 / 新 run / 新调用点"推断 —— 这里的
 * runId/taskId 参数在那些路径上已不参与身份，只为兼容既有调用点保留（reason 仍在
 * `cancel.requested` 的展示载荷里使用）。
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
 * `runId` = 这一轮的**原生 run 身份**（⭐ P-R2-1）：帧/停止入口带上来才有 ——
 * 旧 run 的迟到终态、别的 run 的终态据此拒收（两边都有身份才比较；缺身份不猜）。
 */
const liveTurnSessions = new Map<string, { gatewayId: string; since: number; runId?: string }>();
const releaseTimers = new Map<string, ReturnType<typeof setTimeout>>();
let releaseHandler: ((sessionKey: string) => void) | null = null;

/**
 * ⭐ R6（2026-10-14 五小时窗）：停止 ticket 的**不可变身份** —— 创建（`noteGatewayTurnStop`
 * 的未确认分支）那一刻冻结，之后确认 / 拒绝 / 重连补发 / 网关终结**全部**从原 ticket 取：
 *
 *  - `gatewayId`/`since`：这一轮软状态的归属（对象身份之外的第二道核对）；
 *  - `runId`/`taskId`：**发起停止时**那一轮的交付事件身份（缺 runId ⇒ 取消帧 fail-closed
 *    不发，见文件头）——重连补发不再依赖"当前前台 / 新 run"（那会把确认帧标到错 run 上）；
 *  - `scope`/`revision`：**创建那一刻**的 workspace 捕获代（P-3：帧载荷携带它，接收侧
 *    据此拒换区后的在途帧）；
 *  - `stopTicketId`：唯一化的票据 id（投影的 `cancel.*` 用它核对"同一次操作"）。
 */
export interface GatewayTurnStopTicket {
  readonly gatewayId: string;
  readonly since: number;
  readonly runId?: string;
  readonly taskId?: string;
  readonly scope: string | null;
  readonly revision: number;
  readonly stopTicketId: string;
}

/**
 * ⭐ B1（2026-10-11 整改 · 复审二轮）：**未确认的停止** —— 「可核对的同轮状态」。
 *
 * 停止入口（`ws:abort-chat` / 会话重置 / 删除）都会**先本地取消 run**（删掉队列与完成
 * 记录）。复审原话：*失败的 abort 不能凭本地删除记录就宣称远端已结束* —— 所以本地取消
 * 之后软状态**保留**，并把"这一轮被停止过、还没确认"记在这里（sessionKey → 停止 ticket）。
 * 落地路径全是**确认过的真实证据**：
 *  - 真实终态事件到达（⭐ P-R2-1 改口径，见 `noteGatewayTurnLifecycle`）：本 run 明确
 *    `aborted`（原生 run 身份核过）⇒ `cancel.confirmed`；普通 end/error ⇒ 只说明"该 run
 *    已结束"，如实折 `cancel.unconfirmed{run-terminated}`（不冒充"已停止"）；
 *  - 下一次**重连成功** ⇒ {@link retryPendingGatewayTurnStops} 补发一次 abort，网关真的
 *    应答了（aborted true=已中止 / false=本来就没有在跑）⇒ 确认的生命周期证据，落地；
 *  - 重连耗尽 / 连接被移除 ⇒ {@link releaseGatewayTurnSessions} 一并落地（有界）。
 *
 * 身份判据 = **ticket 对象身份**（复审三轮）：每次停止操作在 await 前捕获自己的 ticket
 * （{@link noteGatewayTurnStop} 的返回值），确认时只许消费**同一个对象**（`gatewayId`/
 * `since` 全等只是第二道核对）—— 迟到的旧回执既不能结算新轮，也不能删新轮的恢复记录。
 * ⭐ P-R2-2：同一 live run 的再次停止**复用原 ticket/id**（不再每次换号 —— 投影按 id 核
 * "同一次操作"，换号会让重试的确认永远进不了投影）；新一轮（live.since 变了）必须换 ticket。
 *
 * ⚠️ 连接死亡**不自动等于远端已停止**（现状保持）：网关终结路径只折
 * `cancel.unconfirmed{gateway-terminated}`（"再也不可能确认"），绝不冒充 confirmed。
 */
const pendingTurnStops = new Map<string, GatewayTurnStopTicket>();

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

/**
 * 创建停止 ticket：**此刻**冻结这一轮的身份与 workspace 捕获代（见 {@link GatewayTurnStopTicket}）。
 * `stopTicketId` 唯一化（gatewayId|since 在毫秒级可重复，追加一次性 UUID 保证"两次停止操作"
 * 永不共号 —— 投影按 id 拒"迟到回执"）。
 */
function createStopTicket(
  sessionKey: string,
  gatewayId: string,
  since: number,
  context?: TurnStopEventContext,
): GatewayTurnStopTicket {
  const scope = getWorkspaceScope();
  const runId = context?.runId?.trim();
  const taskId = context?.taskId ?? parseTaskIdFromSessionKey(sessionKey) ?? undefined;
  return {
    gatewayId,
    since,
    stopTicketId: `${gatewayId}|${since}|${randomUUID()}`,
    ...(runId ? { runId } : {}),
    ...(taskId ? { taskId } : {}),
    scope: scope.scope,
    revision: scope.revision,
  };
}

/**
 * ⭐ V3-artifact：把一次停止状态变化折回渲染层投影（`cancel.requested/confirmed/unconfirmed`）。
 *
 * ⭐ R6（2026-10-14）：身份**只从 ticket 取**（runId/taskId/scope 在创建时冻结）——
 * 不从"当前前台 / 新调用点上下文"推断，重连补发与网关终结因此也能落在原 run 上。
 *
 * fail-closed：ticket 缺 taskId/runId，或捕获 scope 为空 ⇒ `emitMainExecutionEvents`
 * 直接不发 —— 投影是 run 归属的，宁缺勿猜（UI 走既有 stop ticket 自己的显示）。
 */
function emitCancelEvent(sessionKey: string, ticket: GatewayTurnStopTicket, event: MainExecutionEventInput): void {
  if (!ticket.taskId) return;
  emitMainExecutionEvents(
    {
      taskId: ticket.taskId,
      sessionKey,
      runId: ticket.runId,
      gatewayId: ticket.gatewayId,
      workspaceScope: ticket.scope,
      workspaceRevision: ticket.revision,
    },
    [event],
  );
}

export function noteGatewayTurnLifecycle(
  phase: 'start' | 'end' | 'error' | 'aborted',
  sessionKey: string | undefined,
  gatewayId?: string,
  nativeRunId?: string,
): void {
  if (!sessionKey) return;
  const live = liveTurnSessions.get(sessionKey);
  const frameRunId = typeof nativeRunId === 'string' && nativeRunId.trim() ? nativeRunId.trim() : undefined;
  if (phase === 'start') {
    clearReleaseTimer(sessionKey);
    // 新一轮开始 ⇒ 上一轮的"未确认停止"记录作废（它说的不是这一轮）。
    pendingTurnStops.delete(sessionKey);
    // 归属：这一帧的网关优先；没带（旧调用点/测试）就沿用已有归属，最后退回匿名。
    const owner = gatewayId ?? live?.gatewayId ?? '';
    // ⭐ P-R2-1：带上本轮的**原生 run 身份**（帧带才有）—— 旧 run 的迟到终态据此拒收。
    // 新一轮不带身份 ⇒ 旧身份作废（不沿用上一轮的值，那是另一个 run）。
    liveTurnSessions.set(sessionKey, {
      gatewayId: owner,
      since: Date.now(),
      ...(frameRunId !== undefined ? { runId: frameRunId } : {}),
    });
    return;
  }

  // ── ⭐ P-R2-1（2026-10-14 第二轮）：终态先核身份、先给原票据收口，再落软状态 ──
  // 修复前：end/error 直接删 liveTurnSessions + pendingTurnStops，随后的成功回执被拒、
  // 投影永久停在 requested/unconfirmed（"terminal 先到"反例）。
  // ① 网关归属核对：帧**带**网关时必须与这一轮的归属网关精确相等 —— 另一网关的同会话
  //    终态不得删本轮的软状态、不得消费本轮的停止票据（归属空串 = 不知道是谁的，不相等即拒）。
  if (gatewayId !== undefined && live !== undefined && live.gatewayId !== gatewayId) return;
  // ② run 身份核对：两边都有原生身份且不等 ⇒ 这是**别的 run**（旧 run 终态迟到/新 run 抢先）
  //    的终态，一个字节都不动（新 run 的软状态与票据不受影响）。
  if (frameRunId !== undefined && live?.runId !== undefined && live.runId !== frameRunId) return;

  clearReleaseTimer(sessionKey);

  // ③ 在删除原票据之前处理它的真实终结证据（仅当 run 身份**核过**才收口）：
  //    - 本 run 明确 `aborted` ⇒ 停止请求的真实结局就是"已停止" ⇒ cancel.confirmed；
  //    - 普通 end/error ⇒ 只说明"该 run 已结束"，**不等于**"已执行停止请求" ⇒ 如实折
  //      cancel.unconfirmed{run-terminated}（不冒充"已停止"，也不混同断线 —— 断线走
  //      releaseGatewayTurnSessions 的 gateway-terminated）。
  //    身份对不上（帧不带 runId / 与票据的 runId 不同）⇒ 一个事件都不发（fail-closed，
  //    宁缺勿猜；软状态照旧落地，迟到回执按既有 ticket 守卫处理）。
  const pending = pendingTurnStops.get(sessionKey);
  if (pending && live && pending.gatewayId === live.gatewayId && pending.since === live.since) {
    const identityVerified =
      frameRunId !== undefined &&
      pending.runId !== undefined &&
      frameRunId === pending.runId &&
      (gatewayId === undefined || pending.gatewayId === gatewayId);
    if (identityVerified) {
      if (phase === 'aborted') {
        emitCancelEvent(sessionKey, pending, {
          type: 'cancel.confirmed',
          payload: { stopTicketId: pending.stopTicketId },
        });
      } else {
        emitCancelEvent(sessionKey, pending, {
          type: 'cancel.unconfirmed',
          payload: { stopTicketId: pending.stopTicketId, reason: 'run-terminated' },
        });
      }
    }
  }

  liveTurnSessions.delete(sessionKey);
  pendingTurnStops.delete(sessionKey);
  if (phase === 'error' || phase === 'aborted') {
    // 致命错误 / 明确中止（chat `error`/`aborted` 或 lifecycle `error`）= 这一轮**不会**再产出
    // 终态交付，队列里的 active run 立刻是僵尸 —— 立即释放（自动重发只等 ~1.5 秒，宽限来不及）。
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
 *
 * ⭐ R6（2026-10-14）：未确认停止的身份从**原 ticket** 取（runId/scope 是发起停止那一刻捕
 * 获的）—— 呼叫方不再提供上下文也标不错 run；`context` 参数只为兼容既有调用点保留。
 * ⚠️ 连接死亡**不自动等于远端已停止**：这里只折 `cancel.unconfirmed`（绝不冒充 confirmed）。
 */
export function releaseGatewayTurnSessions(gatewayId: string, reason: string, context?: TurnStopEventContext): void {
  void context; // R6：身份已冻结在 ticket 上；本参数不再参与事件归属。
  const released: string[] = [];
  for (const [sessionKey, owner] of [...liveTurnSessions]) {
    if (owner.gatewayId !== gatewayId) continue;
    // ⭐ V3-artifact：这一轮里有"未确认停止"而网关已终结/重连耗尽 ⇒ 再也不可能确认了 ——
    //    如实证 `cancel.unconfirmed`（**不显示"已停止"**），再落软状态。
    const pending = pendingTurnStops.get(sessionKey);
    if (pending && pending.gatewayId === gatewayId) {
      emitCancelEvent(sessionKey, pending, {
        type: 'cancel.unconfirmed',
        payload: { stopTicketId: pending.stopTicketId, reason: 'gateway-terminated' },
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
): GatewayTurnStopTicket | undefined {
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
    //    ⭐ R6：身份（runId/taskId/scope）从**原 ticket**取 —— 重连补发/迟到回执的确认
    //    也落在发起停止的那一轮上，不从"当前前台/新 run"推断。
    //    ticketId 与 requested 那次逐字相同 —— 投影据此核"同一次操作"，旧 ticket 不清新 run。
    emitCancelEvent(sessionKey, pending, {
      type: 'cancel.confirmed',
      payload: { stopTicketId: pending.stopTicketId },
    });
    dropLiveTurn(sessionKey);
    return pending;
  }
  const live = liveTurnSessions.get(sessionKey);
  if (!live) return; // 没有在跑的轮次：没有可核对的软状态（已释放/从未建立）。
  // ⭐ P-R2-2（2026-10-14 第二轮）：**同一 live run 已有有效 pending ⇒ 复用原 ticket/id**。
  //    投影按 id 核"同一次操作"（stop 非 none 时忽略新的 cancel.requested、又按 t1 拒收
  //    confirmed(t2)）—— 再次点击"停止"/重试若换新号，成功的回执永远进不了投影
  //    （requested(t1) → unconfirmed(t1) → requested(t2) 被忽略 → confirmed(t2) 被拒）。
  //    新一轮（live.since 变了）必须换 ticket（旧票据的迟到确认由对象身份守卫挡下）。
  const existing = pendingTurnStops.get(sessionKey);
  if (existing && existing.gatewayId === live.gatewayId && existing.since === live.since) {
    getDebugLogger().warn({
      domain: 'artifact',
      event: 'artifact.turn-stop-reused-pending',
      data: { sessionKey, gatewayId: live.gatewayId },
    });
    return existing;
  }
  // ⭐ R6：ticket 在这里**创建并冻结**身份 + workspace 捕获代（此后不改）。
  const ticket = createStopTicket(sessionKey, live.gatewayId, live.since, context);
  pendingTurnStops.set(sessionKey, ticket);
  // ⭐ P-R2-1：停止入口带来的**本 run 原生身份**也落到软状态 —— 之后到帧的终态据此
  //    拒收别的 run（帧带身份才有比较，缺身份不猜）。
  if (ticket.runId !== undefined) live.runId = ticket.runId;
  getDebugLogger().warn({
    domain: 'artifact',
    event: 'artifact.turn-stop-unconfirmed',
    data: { sessionKey, gatewayId: live.gatewayId },
  });
  // ⭐ V3-artifact：点击停止（本地已取消 run、远端 abort 在途/未达）⇒ cancel.requested。
  emitCancelEvent(sessionKey, ticket, {
    type: 'cancel.requested',
    payload: { stopTicketId: ticket.stopTicketId, ...(context?.reason ? { reason: context.reason } : {}) },
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
 *
 * ⭐ R6：事件身份从**原 ticket** 取（`context` 只为兼容既有调用点保留，不参与归属）。
 */
export function noteGatewayTurnStopRejected(
  sessionKey: string,
  ticket: Readonly<{ gatewayId: string; since: number }>,
  reason: string,
  context?: TurnStopEventContext,
): boolean {
  void context; // R6：身份已冻结在 ticket 上。
  const pending = pendingTurnStops.get(sessionKey);
  if (!pending || pending !== ticket) return false;
  emitCancelEvent(sessionKey, pending, {
    type: 'cancel.unconfirmed',
    payload: { stopTicketId: pending.stopTicketId, reason },
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
