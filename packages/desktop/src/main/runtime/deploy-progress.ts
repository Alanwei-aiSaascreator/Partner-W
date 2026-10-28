/**
 * 「本机运行时部署到哪儿了」这件事，**能过 IPC 的那一部分**。
 *
 * `deploy.ts` 本来就在真实阶段上发 `DeployProgress`，但那条信号在编排层被丢掉了
 * （`runtime/index.ts` 的 dep 签名只收 `userDataDir`）—— 首跑用户对着一个不动的
 * 17% 等 1–20 分钟。这里把那条信号接住：**快照 + 节流 + 停滞提示**。
 *
 * 三道纪律（与 `bootstrap-status.ts` 同一个形状的同一个理由）：
 *
 * ① **快照**：部署在窗口建好**之前**就跑，那之前的推送没人收（窗口不在时
 *    `sendToWindow` 返回 false，事件直接丢掉）。渲染层挂上来之后靠 `getDeployProgress()`
 *    补读 —— 少了这份快照，界面就永远停在"本机服务启动"。
 *
 * ② **闭集、无文本**：快照里只有阶段与计数，**没有路径、没有文件名、没有原始错误**。
 *    它要过 IPC、进截图、进用户随手贴出来的对话（原文进日志，见 `deploy.ts`）。
 *
 * ③ **节流**：解压四万个小文件时回调非常密（`unzip.ts` 每 500 条一次）。每次都推
 *    IPC = 给主进程和渲染层平白加负载。规则 = **1% 或 ≥250ms**，且**阶段变化与
 *    末条必发**（否则进度条会停在 97% 或者干脆看不见换阶段）。
 */

import type { RuntimeDeployProgress } from '@clawwork/shared';
import type { DeployProgress } from './deploy.js';

/** 两次推送之间至少隔这么久（毫秒）。 */
export const DEPLOY_PROGRESS_MIN_INTERVAL_MS = 250;
/** 或者：百分比至少涨这么多。 */
export const DEPLOY_PROGRESS_MIN_PERCENT_STEP = 1;
/**
 * 「超过这么久没有新事件」= 这块盘很慢 / 卡在系统调用里。
 *
 * ⚠️ 它**只是一个提示**：不中止、不重试、不改判据 —— 慢盘上重来一次只会更坏。
 */
export const DEPLOY_STALL_TIMEOUT_MS = 90_000;

let current: RuntimeDeployProgress | null = null;
let lastPublishedAt = 0;

function percentOf(snapshot: { done: number; total: number }): number {
  if (!(snapshot.total > 0)) return 0;
  return Math.floor((snapshot.done / snapshot.total) * 100);
}

/**
 * 这一条要不要推？**纯函数**（便于钉住节流规则本身，而不是靠"推了几次"间接猜）。
 *
 * 必发：第一条、阶段变了、这一阶段走完了（`done >= total`）。
 * 节流：百分比涨 ≥1%，或距上次推送 ≥250ms。
 */
export function shouldPublishDeployProgress(opts: {
  previous: RuntimeDeployProgress | null;
  next: DeployProgress;
  sinceMs: number;
}): boolean {
  const { previous, next, sinceMs } = opts;
  if (!previous) return true;
  // 从"停滞"回到真实事件：**必发** —— 否则界面会继续挂着"这块盘很慢"，
  // 而它其实已经在走了（节流在这里会变成一句过时的假话）。
  if (previous.phase === 'stalled') return true;
  if (previous.phase !== next.phase) return true;
  if (next.total > 0 && next.done >= next.total) return true;
  if (percentOf(next) - percentOf(previous) >= DEPLOY_PROGRESS_MIN_PERCENT_STEP) return true;
  return sinceMs >= DEPLOY_PROGRESS_MIN_INTERVAL_MS;
}

/**
 * 记下一条真实部署事件。返回**要推出去的那份快照**；被节流则返回 `null`
 * （调用方什么都不做 —— 快照本身也保持原样）。
 *
 * `startedAt` 是**这一轮第一件事件**的时间，之后每一件都沿用：界面据此说
 * "从开始等到现在过了多久"，而不是"这块面板出现到现在"。
 */
export function publishDeployProgress(
  progress: DeployProgress,
  now: number = Date.now(),
): RuntimeDeployProgress | null {
  const next: RuntimeDeployProgress = {
    phase: progress.phase,
    done: progress.done,
    total: progress.total,
    startedAt: current?.startedAt ?? now,
  };
  if (!shouldPublishDeployProgress({ previous: current, next: progress, sinceMs: now - lastPublishedAt })) {
    return null;
  }
  current = next;
  lastPublishedAt = now;
  return next;
}

/**
 * 「很久没有新事件了」——保留已经走过的阶段与计数，只把相位换成 `stalled`。
 *
 * 没有任何部署在进行（快照为空）⇒ 返回 `null`：说不清就不说。
 * ⚠️ 不重复发：已经 `stalled` 就不再发（调用方每次事件都会重置计时器）。
 */
export function publishDeployStalled(now: number = Date.now()): RuntimeDeployProgress | null {
  if (!current || current.phase === 'stalled') return null;
  current = { ...current, phase: 'stalled' };
  lastPublishedAt = now;
  return current;
}

/** 当前快照（`null` = 没有部署在进行 / 已经清掉）。 */
export function getDeployProgress(): RuntimeDeployProgress | null {
  return current;
}

/** 部署结束（成功/失败都算）后清掉：界面不该继续挂着上一轮的进度。 */
export function clearDeployProgress(): void {
  current = null;
  lastPublishedAt = 0;
}

/**
 * 停滞看门狗：每次真实事件 `touch()` 重新计时，`finalize`（部署已走完）或部署结束时
 * `cancel()`。超时**只喊一声**（`onStall`），不中止任何东西。
 *
 * 定时器可注入（单测用假定时器，不真等 90 秒）。
 */
export function createDeployStallWatch(opts: {
  onStall: () => void;
  timeoutMs?: number;
  timers?: {
    set: (fn: () => void, ms: number) => unknown;
    clear: (handle: unknown) => void;
  };
}): { touch: () => void; cancel: () => void } {
  const timeoutMs = opts.timeoutMs ?? DEPLOY_STALL_TIMEOUT_MS;
  const timers = opts.timers ?? {
    set: (fn, ms) => {
      const handle = setTimeout(fn, ms);
      // 看门狗不该把进程留在事件循环里（退出时它只是提示，没有任何收尾职责）。
      handle.unref?.();
      return handle;
    },
    clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
  };
  let handle: unknown = null;

  const cancel = (): void => {
    if (handle === null) return;
    timers.clear(handle);
    handle = null;
  };

  return {
    touch: () => {
      cancel();
      handle = timers.set(() => {
        handle = null;
        opts.onStall();
      }, timeoutMs);
    },
    cancel,
  };
}
