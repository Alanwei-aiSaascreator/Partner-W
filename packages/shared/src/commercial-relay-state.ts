/**
 * 中转 bootstrap 的**对外状态** —— 渲染层唯一能看到的那份结论。
 *
 * ## 为什么要有这个模块（2026-09-21 实机：第二台机器一直"正在准备模型"）
 *
 * 主进程其实**早就知道**发生了什么：那次 `activate_license` 回的是
 * `P0001: license already bound to another organization`，取 key 那一步把它翻成了
 * `license_bound_elsewhere`。可这份知识只活在 `RelayBootstrapResult` 与调试日志里 ——
 * 渲染层既读不到、也没有事件可听，于是它只能一直转圈；用户永远等不到
 * "这张卡在当前账号下用不了"这句话，排查的人也只能靠重启客户端碰运气。
 *
 * ## 分层（本模块刻意很薄）
 *
 * 这里是**纯状态**：没有 electron、没有 supabase、没有网关、不认识单飞调度器。
 *   - **写**：`main/commercial/relay-startup.ts`（每轮 bootstrap 结束翻一次）与
 *     `main/ipc/commercial-handlers.ts`（登录 / 登出这两个**账户边界**清成 `idle`）；
 *   - **读**：`commercial:relay-bootstrap-state`（初始读）与
 *     `commercial:relay-bootstrap-state-changed`（事件）。
 *
 * ⚠️ **只许主进程按值 import**（`import { relayBootstrapPublicStateStore } from
 *    '@clawwork/shared'`）；**renderer / preload 只能 `import type`**。
 *    原因：下面那个"进程级单例"是在**模块初始化**时建出来的，而 `@clawwork/shared`
 *    的 `package.json` 没有 `sideEffects: false` ⇒ 打包器不能把那句初始化删掉 ——
 *    渲染层一旦按值 import，就会在自己包里得到一个**谁也没用、但真的存在**的
 *    "包内单例"，而"进程级"这句话在渲染层根本不成立（每个窗口/上下文各一份）。
 *    `desktop/test/commercial-preload-surface.test.ts` 会扫源码把这条钉死。
 *
 * Public fields are bounded: phase / errorCode / updatedAt and optional ready-only media enums.
 * Never include detail, raw messages, license keys, relay keys or tokens:
 *    `activate_license` 的入参就是卡密（服务端文案很可能回显它），异常文案里还常带
 *    URL 与 apikey。要排查去看主进程的调试日志 —— 那条路有它自己的脱敏纪律。
 *
 * ## 事件契约（渲染层按它做取舍）
 *
 *   - **幂等键 = `(phase, errorCode, updatedAt)`**。`updatedAt` **严格单调**
 *     （见 `set`），所以"两条快照谁更新"永远判得出来 —— 晚到的初始读不许覆盖更新的
 *     那条事件（Task 4 的 `useStartupReadiness` 就按这个键取舍）。
 *   - **内容完全相同的事件可能重复发**：被单飞吸收的那次触发（跑着的时候又来了一个
 *     触发）也会把状态推成 `running` 并发一条 —— 也就是"一条事件 ≠ 一次状态转变"。
 *     渲染层要按幂等键去重，别把重复当成"又跑了一轮"。
 *
 * 📏 闭集来源（两段，**分开**标注 —— 它们是两份不同的文档）：
 *   - `phase` 的五个成员 ← 设计文档 "Renderer visibility" 的载荷句
 *     `docs/superpowers/specs/2026-09-21-multi-org-license-bootstrap-design.md:134-135`
 *     （"a bounded phase (`idle`, `running`, `ready`, `blocked`, or `retryable-error`),
 *     a whitelisted error code, and a timestamp"）；
 *   - 两个 `errorCode` 联合 ← 实施计划的 Task 3 Step 1 里那份 DTO
 *     `docs/superpowers/plans/2026-09-21-multi-org-license-bootstrap-recovery.md:286-304`
 *     （`blocked` 七个成员在 :289-297，`retryable-error` 四个在 :300-304）。
 *   ⚠️ 设计文档里**没有** `RelayBootstrapPublicState` 这个名字（全仓只有计划 :286 有）——
 *      别把两份文档的出处写成一处。
 */

/**
 * 公开状态的相位。**闭集**（来源见文件头）。
 *
 *   - `idle`            —— 还没跑 / 已重置（登录、登出这类账户边界）
 *   - `running`         —— 这一轮在跑（等网关、取 key、写配置，最长 240 秒）
 *   - `ready`           —— 中转配置已经在网关上（模型可用）
 *   - `blocked`         —— **确定性**失败：用户得去做点什么（激活 / 换账号），等多久都一样
 *   - `retryable-error` —— 暂时失败：换个时间点再试**可能**会好
 */
export type RelayBootstrapPhase = 'idle' | 'running' | 'ready' | 'blocked' | 'retryable-error';

/**
 * `blocked` 的安全错误码。**闭集**。
 *
 * `license_required` 是**客户端状态**（这台机器本地没有可用的卡 / 没存卡密），
 * 其余六个是服务端**确定性拒绝**的安全码（`license.ts` 的 `ActivationErrorCode`
 * 原样搬过来 —— 那一份分类表在那边，这里**不**复制它的匹配逻辑）。
 */
export type RelayBootstrapBlockedCode =
  | 'license_required'
  | 'license_bound_elsewhere'
  | 'license_not_found'
  | 'license_inactive'
  | 'license_expired'
  | 'activation_limit_reached'
  | 'activation_failed';

/**
 * `retryable-error` 的安全错误码。**闭集**。
 *
 * ⚠️ 判断"可不可重试"**只看状态与码的配对**，绝不看"有没有出错"：
 * 会话暂时问不出来（`auth_unavailable`）、取 key 的网络/超时（`transport`）、
 * 网关还没连上（`runtime_not_ready`）、配置写失败（`relay_apply_failed`）——
 * 这四种都是"再试一次可能好"，而 `blocked` 那七种是"再试一万次也一样"。
 */
export type RelayBootstrapRetryableCode = 'auth_unavailable' | 'transport' | 'runtime_not_ready' | 'relay_apply_failed';

export type RelayMediaReadinessState = 'ready' | 'unavailable' | 'unknown' | 'probe-failed';

export interface RelayMediaReadiness {
  image: RelayMediaReadinessState;
  video: RelayMediaReadinessState;
}

/**
 * 渲染层能看到的**全部**内容。
 *
 * Phase members are exclusive: error phases require a code; only ready may carry media.
 *    （用了 `as` 硬塞进来的多余字段会一路走到事件载荷上 —— 见
 *    `desktop/test/relay-startup.test.ts` 的"载荷只有白名单字段"那条）。
 */
export type RelayBootstrapPublicState =
  | { phase: 'idle' | 'running'; updatedAt: number }
  | { phase: 'ready'; media?: RelayMediaReadiness; updatedAt: number }
  | {
      phase: 'blocked';
      errorCode: RelayBootstrapBlockedCode;
      updatedAt: number;
    }
  | {
      phase: 'retryable-error';
      errorCode: RelayBootstrapRetryableCode;
      updatedAt: number;
    };

/**
 * 同一个状态**去掉时间戳** —— 这是写入方（relay-startup / IPC 两个账户边界）
 * 提供的东西：时间戳由 store 统一盖章，写入方不许自己造。
 */
export type RelayBootstrapPublicPhase =
  | { phase: 'idle' | 'running' }
  | { phase: 'ready'; media?: RelayMediaReadiness }
  | { phase: 'blocked'; errorCode: RelayBootstrapBlockedCode }
  | { phase: 'retryable-error'; errorCode: RelayBootstrapRetryableCode };

function safeMediaReadiness(value: unknown): RelayMediaReadinessState {
  switch (value) {
    case 'ready':
    case 'unavailable':
    case 'probe-failed':
      return value;
    default:
      return 'unknown';
  }
}

export interface RelayBootstrapPublicStateStore {
  /** 当前快照。**渲染层挂载前发生的一切都在这里** —— 初始读就是来取它的。 */
  get: () => RelayBootstrapPublicState;
  /** 盖上一个严格递增的时间戳并通知订阅者，返回新快照。 */
  set: (next: RelayBootstrapPublicPhase) => RelayBootstrapPublicState;
  /** 订阅（返回退订函数）。主进程用它把状态转发成渲染层事件。 */
  subscribe: (listener: (state: RelayBootstrapPublicState) => void) => () => void;
}

/**
 * 建一个公开状态 store。`now` 只给测试注入（默认 `Date.now`）。
 */
export function createRelayBootstrapPublicStateStore(
  opts: { now?: () => number } = {},
): RelayBootstrapPublicStateStore {
  const now = opts.now ?? ((): number => Date.now());
  let current: RelayBootstrapPublicState = { phase: 'idle', updatedAt: now() };
  const listeners = new Set<(state: RelayBootstrapPublicState) => void>();

  return {
    get: () => current,
    set: (next) => {
      // ⭐ **严格单调**，不是"取当前时间"：同一毫秒里连着翻两次是**常态** ——
      //    登录成功先把上一个账号的 `blocked` 清成 `idle`、紧接着这一轮把它推成
      //    `running`，两行代码之间根本没有毫秒级的间隔。而渲染层是**按 `updatedAt`
      //    取舍**的（晚到的初始读不许覆盖更新的那条事件），时间戳相等就分不出先后 ——
      //    界面可能把已经跑起来的状态又退回那条陈旧的结论上。
      const updatedAt = Math.max(now(), current.updatedAt + 1);

      // 🔴 **逐分支显式挑选**，绝不写 `{ ...next, updatedAt }`：这一行是整个功能
      //    "永不泄漏"的**唯一卡口** —— 展开写法会把调用方对象上任何多余字段
      //    （哪怕是用 `as` 硬塞进来的 `detail` / 原始 message / 卡密）原样带进公开
      //    状态，再经事件发到渲染层。字段闭集在这里是**结构**保证，不只是类型保证。
      // ⚠️ 每个分支都把字段**写全**（别图省事把两个带码分支并成一个三元 —— 那样
      //    `phase` 会宽成 `'blocked' | 'retryable-error'`，配不出任何合法的成员，
      //    `tsc` 直接报 TS2322；这条我也实测过）。
      switch (next.phase) {
        case 'ready':
          current = {
            phase: 'ready',
            ...(next.media
              ? {
                  media: {
                    image: safeMediaReadiness(next.media.image),
                    video: safeMediaReadiness(next.media.video),
                  },
                }
              : {}),
            updatedAt,
          };
          break;
        case 'blocked':
          current = { phase: 'blocked', errorCode: next.errorCode, updatedAt };
          break;
        case 'retryable-error':
          current = { phase: 'retryable-error', errorCode: next.errorCode, updatedAt };
          break;
        default:
          current = { phase: next.phase, updatedAt };
          break;
      }

      for (const listener of [...listeners]) {
        // ⚠️ 一个订阅者抛错不该打断其余的（主进程那条"转发给渲染层"的桥就是订阅者之一）。
        //    状态**已经**赋值（上一行），所以吞掉异常不会让状态变坏；最坏情况是错过一条
        //    事件，而渲染层还有"初始读"这条兜底。本模块没有 logger，也不该为此引入一个。
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
 * **进程级单例**：主进程里写它的（relay-startup）与读它的（IPC handlers）必须是
 * 同一个实例。放在这里而不是某个 desktop 模块里，是因为它跨两个 desktop 模块，
 * 而且这样它可以被裸跑单测（不牵 electron）。
 */
export const relayBootstrapPublicStateStore = createRelayBootstrapPublicStateStore();

/**
 * 账户边界（**交互式登录成功** / **登出**）：立刻把公开状态退回 `idle`。
 *
 * ⚠️ 两头都必须调用它，而且**都不许等别的事情做完**：
 *   - 登录：上一个账号的 `license_bound_elsewhere` 对新账号**不成立**，
 *     留着它界面就会拿旧账号的结论吓新登录的用户（登录那两条 handler 在
 *     "账户清理"**之前**就清）；
 *   - 登出：状态属于**当前账号**，登出即作废；而登出这条路的清理会抛错，
 *     所以它写在 `finally` 里（`commercial:sign-out`）。
 */
export function resetRelayBootstrapPublicState(): void {
  relayBootstrapPublicStateStore.set({ phase: 'idle' });
}
