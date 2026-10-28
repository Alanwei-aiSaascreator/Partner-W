/**
 * relay 的**运行期探活** —— 补的是"ready 之后被杀，界面无感"那条缺口（2026-10-03 真机）。
 *
 * ## 形状（与 relay-startup 的桥同一条纪律）
 *
 *   - 只跟随 `relayBootstrapPublicStateStore`：到 `ready` 才开探，离开 `ready`
 *     立刻回 `unknown` 并停探（启动期的失败有 bootstrap 那套完整表达，不在这里重复说）；
 *   - 探针 = 无鉴权 `GET {base}/v1/catalog`：**2xx/4xx＝有应答＝活**（401 是正常应答），
 *     **5xx / 超时 / 拒连＝断**（502/504 是"服务死着"，不是"活着"）；
 *   - 节律 30s、**连续 2 次失败才判 down**（防单次抖动）、**1 次成功即回 up**；
 *   - 失败只吞错 + 记 debug 日志，绝不抛给调用方。
 */
import {
  relayBootstrapPublicStateStore,
  relayLivenessPublicStateStore,
  type RelayBootstrapPhase,
  type RelayBootstrapPublicStateStore,
  type RelayLivenessPublicStateStore,
} from '@clawwork/shared';
import { activeRelayBaseUrl } from './relay-config.js';
import { getDebugLogger } from '../debug/index.js';
import { sendToWindow } from '../ws/window-utils.js';
import { getMainWindow } from '../window-manager.js';

export const RELAY_LIVENESS_INTERVAL_MS = 30_000;
export const RELAY_LIVENESS_TIMEOUT_MS = 5_000;
export const RELAY_LIVENESS_FAIL_THRESHOLD = 2;
export const RELAY_LIVENESS_STATE_CHANGED_CHANNEL = 'commercial:relay-liveness-state-changed';

/** 真探针：判据见文件头。可注入 `fetchImpl`（单测）。 */
export async function probeRelayReachability(
  baseUrl: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<boolean> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/v1/catalog`, {
      signal: AbortSignal.timeout(opts.timeoutMs ?? RELAY_LIVENESS_TIMEOUT_MS),
    });
    return res.status < 500;
  } catch {
    return false;
  }
}

export interface RelayLivenessMonitor {
  start(): void;
  stop(): void;
  /** 手动立刻探一次（[立即重试] 的出口）。仍受"bootstrap 必须 ready"约束。 */
  probeNow(): Promise<void>;
}

export interface RelayLivenessMonitorDeps {
  probe?: (baseUrl: string) => Promise<boolean>;
  baseUrl?: () => string;
  state?: RelayLivenessPublicStateStore;
  bootstrap?: Pick<RelayBootstrapPublicStateStore, 'get' | 'subscribe'>;
  intervalMs?: number;
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
  log?: (event: string, data?: Record<string, unknown>) => void;
}

export function createRelayLivenessMonitor(deps: RelayLivenessMonitorDeps = {}): RelayLivenessMonitor {
  const probe = deps.probe ?? ((baseUrl: string) => probeRelayReachability(baseUrl));
  const getBaseUrl = deps.baseUrl ?? activeRelayBaseUrl;
  const state = deps.state ?? relayLivenessPublicStateStore;
  const bootstrap = deps.bootstrap ?? relayBootstrapPublicStateStore;
  const intervalMs = deps.intervalMs ?? RELAY_LIVENESS_INTERVAL_MS;
  const setIntervalImpl = deps.setIntervalImpl ?? setInterval;
  const clearIntervalImpl = deps.clearIntervalImpl ?? clearInterval;
  const log =
    deps.log ??
    ((event: string, data?: Record<string, unknown>) =>
      getDebugLogger().info({ domain: 'commercial', event, data: data ?? {} }));

  let timer: ReturnType<typeof setInterval> | null = null;
  let failures = 0;
  let running = false;
  let unsubscribe: (() => void) | null = null;

  const publish = (phase: 'unknown' | 'up' | 'down'): void => {
    if (state.get().phase !== phase) state.set({ phase });
  };
  const stopTimer = (): void => {
    if (timer !== null) {
      clearIntervalImpl(timer);
      timer = null;
    }
  };

  const probeOnce = async (): Promise<void> => {
    // 探之前、探之后都要看：中途离开 ready（账户切换/新一轮 bootstrap）时，在途结果作废。
    if (bootstrap.get().phase !== 'ready') return;
    let ok = false;
    try {
      ok = await probe(getBaseUrl());
    } catch {
      ok = false;
    }
    if (!running || bootstrap.get().phase !== 'ready') return;
    if (ok) {
      failures = 0;
      publish('up');
    } else {
      failures += 1;
      log('relay.liveness.probe-failed', { failures });
      if (failures >= RELAY_LIVENESS_FAIL_THRESHOLD) publish('down');
    }
  };

  const syncToBootstrap = (phase: RelayBootstrapPhase): void => {
    if (!running) return;
    if (phase === 'ready') {
      if (timer === null) {
        timer = setIntervalImpl(() => void probeOnce(), intervalMs);
        void probeOnce(); // 立刻探第一次，不等到下一个节拍
      }
    } else {
      stopTimer();
      failures = 0;
      publish('unknown');
    }
  };

  return {
    start() {
      if (running) return;
      running = true;
      unsubscribe = bootstrap.subscribe((s) => syncToBootstrap(s.phase));
      syncToBootstrap(bootstrap.get().phase);
    },
    stop() {
      running = false;
      stopTimer();
      unsubscribe?.();
      unsubscribe = null;
      failures = 0;
    },
    probeNow: probeOnce,
  };
}

/** 进程级 monitor（`initRelayLiveness` 建、`destroyRelayLiveness` 拆）。 */
let monitor: RelayLivenessMonitor | null = null;
let rendererBridgeReady = false;

/** 主进程启动时调一次（挂在 `main/index.ts` 的 `initUsageReporter()` 旁）。 */
export function initRelayLiveness(): void {
  if (!monitor) {
    monitor = createRelayLivenessMonitor();
    monitor.start();
  }
  if (!rendererBridgeReady) {
    // 与 relay-startup 的桥同一形状：窗口没建时 `sendToWindow` 返回 false、事件丢掉，
    // 渲染层靠 `commercial:relay-liveness-state` 的初读兜底。
    rendererBridgeReady = true;
    relayLivenessPublicStateStore.subscribe((s) => {
      sendToWindow(getMainWindow(), RELAY_LIVENESS_STATE_CHANGED_CHANNEL, s);
    });
  }
}

/** 应用退出时调（挂在 `destroyUsageReporter()` 旁）。 */
export function destroyRelayLiveness(): void {
  monitor?.stop();
  monitor = null;
}

/** [立即重试] 的 IPC 出口：只**请求**，不等它跑完（进度跟状态事件走）。 */
export function probeRelayLivenessNow(): void {
  void monitor?.probeNow();
}
