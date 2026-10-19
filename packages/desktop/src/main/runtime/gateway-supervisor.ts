/**
 * 网关进程的**监督者**（2026-10-18 实机：接飞书后网关永久断开）。
 *
 * ## 为什么必须有
 *
 * 内核在 `OPENCLAW_SUPERVISOR_MODE=external` 下的「重启」是：**自己退出**，把重启
 * 交给外部监督者（也就是我们）。实测链路：
 *   用户接入飞书 → 写 `plugins.entries.feishu` / `channels.feishu`
 *   → 网关判定"需要重启" → `SIGUSR1` → `restart mode: full process restart (supervisor restart)`
 *   → 进程退出。
 * 而桌面端此前只把 `activeGateway` 置空，**从不重启** ⇒ WS 客户端在死端口上按退避
 * 无限重连（3s→96s），用户看到的就是"网关断了、连不上"。
 *
 * ## 纪律
 *
 * - **只在我们自己 spawn 的网关退出时**触发（`reused` 是别人的，不碰）；
 * - 指数退避 + 次数上限，撞上内核 crash-loop 熔断就停手（继续撞只会延长熔断窗口）；
 * - 应用退出时 `stop()`：绝不在收尾过程中把网关又拉起来。
 *
 * 纯逻辑、不 import electron：调度与 bootstrap 都由调用方注入，单测用假时钟。
 */

export interface GatewaySupervisorDeps {
  /** 重新拉起网关（返回与 bootstrap 同形状的结果）。 */
  bootstrap: () => Promise<{ ok: boolean; code?: string }>;
  /** 调度（`setTimeout`）；返回可被 `cancel` 取消的句柄。 */
  schedule: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
  /** 每次真正发起重拉时回调（用于日志）。 */
  onRespawn?: (attempt: number, delayMs: number) => void;
  /** 放弃时回调（次数用尽 / 熔断）。 */
  onGiveUp?: (reason: 'max-attempts' | 'crash-loop-breaker') => void;
  /** 退避表（毫秒）；用尽后停在最后一档。默认 2s/8s/30s/60s。 */
  delaysMs?: readonly number[];
  /** 最多连续触发几次（成功一次即清零）。默认 4。 */
  maxAttempts?: number;
}

export interface GatewaySupervisor {
  /** 子进程退出时调用。重复调用（同一档退避窗口内）只会排一次。 */
  onGatewayExit: () => void;
  /** 停用（应用退出时）：取消未执行的定时器，之后不再重拉。 */
  stop: () => void;
  /**
   * 重新启用（**主动重启**专用，不是退出）。
   *
   * `restartLocalGatewayRuntime` 会先走 `shutdownLocalGatewayRuntime()`，那一步为了
   * 退出安全会把监督者 `stop()` 掉；如果重启后不恢复，**本次会话之后所有网关退出
   * 都不再被拉起**（BUG-157 原样复现）。
   */
  reset: () => void;
  /** 当前连续失败次数（测试/日志用）。 */
  attempts: () => number;
}

const DEFAULT_DELAYS = [2_000, 8_000, 30_000, 60_000] as const;
const DEFAULT_MAX_ATTEMPTS = 4;

export function createGatewaySupervisor(deps: GatewaySupervisorDeps): GatewaySupervisor {
  const delays = deps.delaysMs ?? DEFAULT_DELAYS;
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  let attempts = 0;
  let running = false;
  let stopped = false;
  let pending: { handle: unknown } | null = null;

  function schedule(): void {
    if (stopped || running || pending) return;
    if (attempts >= maxAttempts) {
      deps.onGiveUp?.('max-attempts');
      return;
    }
    const delayMs = delays[Math.min(attempts, delays.length - 1)]!;
    attempts += 1;
    deps.onRespawn?.(attempts, delayMs);
    const slot: { handle: unknown } = { handle: undefined };
    pending = slot;
    slot.handle = deps.schedule(() => {
      if (pending === slot) pending = null;
      void run();
    }, delayMs);
  }

  async function run(): Promise<void> {
    if (stopped || running) return;
    running = true;
    let reschedule = false;
    try {
      const result = await deps.bootstrap();
      if (stopped) return;
      if (result.ok) {
        attempts = 0;
        return;
      }
      if (result.code === 'gateway-crash-loop-breaker') {
        deps.onGiveUp?.('crash-loop-breaker');
        return;
      }
      reschedule = true;
    } finally {
      running = false;
    }
    // ⚠️ 必须在 `running = false` **之后**再排：`schedule()` 的幂等闸会挡住
    //    "正在跑"时的重复排程，跑完立刻排会被自己挡掉（第一版就踩了这个）。
    if (reschedule) schedule();
  }

  return {
    onGatewayExit: schedule,
    stop: () => {
      stopped = true;
      if (pending && deps.cancel) deps.cancel(pending.handle);
      pending = null;
    },
    reset: () => {
      // 主动重启：清掉"退出中"的停用位与连续失败计数，让下一次退出照常被监督。
      // 尚未执行的定时器一并取消 —— 重启路径自己会 bootstrap，不要重复拉起。
      if (pending && deps.cancel) deps.cancel(pending.handle);
      pending = null;
      stopped = false;
      attempts = 0;
    },
    attempts: () => attempts,
  };
}
