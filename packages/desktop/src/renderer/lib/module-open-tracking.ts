/**
 * `module_opened` 的同模块节流。
 *
 * 渲染层主动上报埋点只有这一条路（`window.clawwork.analyticsTrack` ⇒ 主进程
 * `analytics:track` ⇒ 上报器 ⇒ 服务端），而「打开模块」在侧栏、命令面板、
 * 快捷键、托盘通知等多个路径上都会触发 —— 不节流的话，用户来回切几次页面
 * 就能把看板刷成一堆重复事件。
 *
 * ⚠️ 节流表必须活在**模块作用域**：这里的 Map 在工厂闭包里，单例由调用方
 *    `useModuleOpenTracking` 在它的模块顶层创建。放进组件里的话，每次重挂载
 *    都会清零，「切走再切回来」就又能发一遍，节流等于没做
 *    （`test/module-open-tracking.test.tsx` 的「卸载后重挂载不再重复」钉这个）。
 */

/** 产品口径：同一个模块 60 秒最多记一次。改这个数要同步改那条测试（它写死 60_000）。 */
const MODULE_OPEN_THROTTLE_MS = 60_000;

/**
 * 建一个带节流的「打开模块」上报器。
 *
 * 时钟与发送函数都注入进来，是为了能在测试里精确地推时间、并断言到底发了什么
 * —— 直接读 `Date.now()` / 直接调 `window.clawwork` 的话，这条逻辑只能靠
 * 挂载组件间接验证（而它恰恰是**不能**挂在组件上的）。
 */
export function createModuleOpenTracker(deps: {
  now: () => number;
  send: (module: string) => void;
}): (module: string) => void {
  const lastSentAt = new Map<string, number>();

  return (module: string): void => {
    const at = deps.now();
    const last = lastSentAt.get(module);
    if (last !== undefined && at - last < MODULE_OPEN_THROTTLE_MS) return;
    lastSentAt.set(module, at);
    deps.send(module);
  };
}

/** 真正把事件交给主进程。埋点是尽力而为：失败只记一行日志，不打扰用户。 */
export function sendModuleOpened(module: string): void {
  // ⚠️ preload 与 renderer 可能版本漂移（dev 下 renderer 热更新、preload 是独立构建产物），
  //    `analyticsTrack` 缺席时**属性读取本身就是同步抛** —— `.catch` 只接得住 reject，接不住它。
  //    仓库既有件（usageStore / AboutSection）对同类漂移都做了 typeof 守卫。
  if (typeof window.clawwork?.analyticsTrack !== 'function') return;
  window.clawwork
    .analyticsTrack({ event: 'module_opened', props: { module } })
    .catch((error: unknown) => console.error('[analytics] module_opened failed:', error));
}
