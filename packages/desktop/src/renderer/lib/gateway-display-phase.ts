import type { GatewayConnectionStatus } from '@clawwork/core';

/**
 * 网关这一格**该说哪句话** —— 判据是纯函数，界面只负责渲染。
 *
 * 判据的输入里必须有 `everConnected`：能分开"还在启动窗口里"和"连上过又掉了"的
 * 不是"有没有错误"（预热期确实**有**真错误），而是**这一次运行里这个网关连上过没有**。
 * 背景与实机现场见 `test/gateway-display-phase.test.ts` 的文档注释。
 */
export type GatewayDisplayPhase = 'live' | 'starting' | 'retrying' | 'unreachable' | 'disconnected';

export interface GatewayReconnectInfo {
  attempt: number;
  max: number;
  gaveUp: boolean;
}

export interface GatewayDisplayPhaseInput {
  status: GatewayConnectionStatus | undefined;
  /** 这次运行里这个网关**成功连上过**吗（`setGatewayStatusByGateway` 落下的账）。 */
  everConnected: boolean;
  reconnect?: GatewayReconnectInfo | undefined;
}

export function deriveGatewayDisplayPhase({
  status,
  everConnected,
  reconnect,
}: GatewayDisplayPhaseInput): GatewayDisplayPhase {
  if (status === 'connected') return 'live';
  // 网关明确拒绝（pairing required / 1008 之类）—— 那是**结论**，不是预热过程。
  // 老判据在这里一律报 `gaveUp:false`，界面于是永远显示「正在尝试重连…(0/10)」且没有出口。
  if (reconnect?.gaveUp) return 'unreachable';
  // 从没连上过 ⇒ 还在启动窗口里：哪怕中途真失败过一次（首次部署分钟级、第一次 connect
  // 15 秒超时都会留下真错误），对用户来说"程序正在启动"，说"已断开"就是假话。
  if (!everConnected) return 'starting';
  if (status === 'disconnected' && !reconnect) return 'disconnected';
  return 'retrying';
}

/**
 * 「正在启动」这句话最多说多久 —— 超过就把话改成失败 + 给出口。
 *
 * ⚠️ 这是个**兜底**，不是诊断：主进程自己的预算是"首次部署 2–3 分钟 + 等就绪 180 秒"，
 *    所以取 6 分钟（`STARTUP_GRACE_MS`）—— 正常首启不会撞上它，而**已经不可能起来了**
 *    的那种（端口没了、部署坏了）也不至于让用户对着"正在启动"等到地老天荒。
 *    主进程侧现在会把失败**推给渲染层**（`runtime-status` 的公开闭集，含部署失败的
 *    `deploy-failed` 与盘上那份的四类处置），准备页也有 `runtime:bootstrap-retry`
 *    这条"应用内真重跑"的出口 —— 这里的 6 分钟只兜**还没有任何结论**的那种等待。
 */
export const STARTUP_GRACE_MS = 360_000;

/** 输入框那句占位提示该用哪个 key —— `null` = 不上状态文案。 */
export function composerPlaceholderKey(input: {
  phase: GatewayDisplayPhase;
  /** 已知**断了**（`useChatSend` 里的 `isOffline`）。 */
  isOffline: boolean;
  /** 准备还没完成（`startupReadiness.composerBlocked`）。 */
  readinessBlocked: boolean;
}): 'chatInput.offlineReadOnly' | 'chatInput.aiServiceStartingDetail' | 'chatInput.describeTask' {
  // ⭐ 顺序要紧：还在启动窗口里时**不许**说"离线模式 — 只读"。
  //    `isOffline` 是老判据，它把"还不知道"（状态还没有这一条）也算成离线，
  //    于是首次启动那 50 秒里输入框在说一件不是事实的话（2026-09-20 实机截图）。
  if (input.phase === 'starting') return 'chatInput.aiServiceStartingDetail';
  if (input.isOffline) return 'chatInput.offlineReadOnly';
  if (input.readinessBlocked) return 'chatInput.aiServiceStartingDetail';
  return 'chatInput.describeTask';
}
