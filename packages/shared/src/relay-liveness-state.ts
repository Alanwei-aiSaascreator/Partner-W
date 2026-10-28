/**
 * relay 的**运行期存活状态** —— ready 之后那条"还在不在"的公开结论。
 *
 * ## 为什么单独一份、不并进 `commercial-relay-state`
 *
 * bootstrap 那份的相位是**启动语义**的闭集（idle/running/ready/blocked/retryable-error，
 * 来源与教义见那个文件头），它是"这一轮跑到哪了"；本模块回答的是另一个问题：
 * "已经 ready 的服务，现在还能不能访问"。两者写者不同（bootstrap 调度器 vs 探活
 * monitor）、时间尺度不同（一次启动 vs 每 30 秒），并进一份会把两套教义搅在一起。
 *
 * 纪律与那份完全一致：updatedAt 严格单调（渲染层按它取舍）、字段闭集（显式挑选，
 * 挡 `as` 硬塞）、订阅者抛错不伤别人。**从不携带** URL / 错误原文 / 任何凭据。
 */

/**
 * 存活相位。**闭集**（来源 = 设计文档 `docs/superpowers/specs/2026-10-03-relay-liveness-and-workspace-notice-design.md` §2.2）：
 *   - `unknown` —— 还没探过 / 不在探活窗口（bootstrap 未 ready，启动期有自己的表达）
 *   - `up`      —— 最近一次探活有应答
 *   - `down`    —— 连续失败达到阈值（渲染层据此出横幅）
 */
export type RelayLivenessPhase = 'unknown' | 'up' | 'down';

export interface RelayLivenessPublicState {
  phase: RelayLivenessPhase;
  updatedAt: number;
}

export interface RelayLivenessPublicStateStore {
  /** 当前快照（渲染层挂载前发生的一切都在这里——初始读就是来取它的）。 */
  get: () => RelayLivenessPublicState;
  /** 盖上一个严格递增的时间戳并通知订阅者，返回新快照。 */
  set: (next: { phase: RelayLivenessPhase }) => RelayLivenessPublicState;
  /** 订阅（返回退订函数）。主进程用它把状态转发成渲染层事件。 */
  subscribe: (listener: (state: RelayLivenessPublicState) => void) => () => void;
}

/** 建一个存活状态 store。`now` 只给测试注入（默认 `Date.now`）。 */
export function createRelayLivenessPublicStateStore(opts: { now?: () => number } = {}): RelayLivenessPublicStateStore {
  const now = opts.now ?? ((): number => Date.now());
  let current: RelayLivenessPublicState = { phase: 'unknown', updatedAt: now() };
  const listeners = new Set<(state: RelayLivenessPublicState) => void>();

  return {
    get: () => current,
    set: (next) => {
      // ⭐ **严格单调**（与 `commercial-relay-state` 同一条理由）：同一毫秒里连着翻两次
      //    是常态，而渲染层是**按 `updatedAt` 取舍**的——时间戳相等就分不出先后。
      const updatedAt = Math.max(now(), current.updatedAt + 1);
      // 🔴 **显式挑选**，绝不写 `{ ...next, updatedAt }`：这一行是"永不泄漏"的卡口，
      //    展开写法会把调用方对象上任何多余字段（哪怕 `as` 硬塞的）原样带进公开状态。
      current = { phase: next.phase, updatedAt };
      for (const listener of [...listeners]) {
        // ⚠️ 一个订阅者抛错不该打断其余的（主进程那条"转发给渲染层"的桥就是订阅者之一）。
        try {
          listener(current);
        } catch {
          // 订阅者自己的问题：吞掉，继续通知下一个。
        }
      }
      return current;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * **进程级单例**：主进程里写它的（探活 monitor）与读它的（IPC handlers）必须是同一个实例。
 * ⚠️ 只许主进程按值 import；renderer / preload 只许 `import type`
 *    （理由与护栏见 `commercial-relay-state.ts` 文件头与
 *    `desktop/test/commercial-preload-surface.test.ts` 的 `GUARDED_VALUE_EXPORTS`）。
 */
export const relayLivenessPublicStateStore = createRelayLivenessPublicStateStore();
