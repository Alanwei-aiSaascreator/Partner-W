/**
 * 「本机运行时起不来」这件事，**能过 IPC 的那一部分**。
 *
 * `RuntimeBootstrapResult` 里有一条 `reason`：给人看的失败描述，会带路径、端口，
 * 有时还有别的东西（见 `runtime/index.ts` 的 `RuntimeBootstrapResult`）。
 * 它进日志没问题 —— **不能**过 IPC：渲染层会显示它，然后它进截图、
 * 进用户随手贴出来的报错、进客服对话。
 *
 * 所以这道关把入参收窄成 `{ ok, code }`：**拿不到那条文本，结构上就带不出去**。
 * 连 `code` 也不原样转发 —— 它先过 `gatewayFailureReasonFrom` 的闭集，
 * 界面上每一句话都对应闭集里的一个值，说不清的一律 `unknown`（不猜）。
 */

import { gatewayFailureReasonFrom, type RuntimeBootstrapStatus } from '@clawwork/shared';

export type { RuntimeBootstrapStatus };

/**
 * ⚠️ 入参**故意**不是整个 `RuntimeBootstrapResult`：多一个字段就多一条泄漏路径，
 *    而这里唯一需要的判据只有"成没成"和"哪一类失败"。
 */
export function toPublicBootstrapStatus(result: { ok: boolean; code?: string | undefined }): RuntimeBootstrapStatus {
  if (result.ok) return { ok: true };
  return { ok: false, reason: gatewayFailureReasonFrom({ bootstrapCode: result.code }) };
}

/**
 * 当前结论（`null` = 还没跑过，**不是**"没问题"）。
 *
 * ⭐ 为什么要有快照、而不只是发一条事件：bootstrap 在 `app.whenReady()` 里就跑，
 *    而窗口与渲染层是**之后**才挂上来的 —— 那之前发出的推送没人收
 *    （窗口不在时 `sendToWindow` 返回 false，事件直接丢掉）。少了这份快照，
 *    渲染层就永远不知道"18789 被别的程序占着"，界面只会一直显示"正在准备模型"。
 *    同一个形状的先例见 `commercial/relay-startup.ts` 的公开状态。
 */
let current: RuntimeBootstrapStatus | null = null;

/**
 * 记下结论。返回值就是记下的那份 —— 调用方拿它去推（推出去了算赚到，
 * 没推出去（窗口还没挂上来）渲染层靠 `getRuntimeBootstrapStatus` 补读）。
 */
export function publishRuntimeBootstrapStatus(result: {
  ok: boolean;
  code?: string | undefined;
}): RuntimeBootstrapStatus {
  current = toPublicBootstrapStatus(result);
  return current;
}

/**
 * 当前结论（`null` = 还没跑过 / 已经清掉）。
 *
 * ⚠️ 这份快照**刻意不跟着账号走**：它讲的是**这台机器此刻**的事（我们自己的网关
 *    进程起没起来、18789 是不是被别的程序占着），与登录的是谁无关 ——
 *    换个账号登录，端口照样被占着。所以退出/切号**不清它**。
 */
export function getRuntimeBootstrapStatus(): RuntimeBootstrapStatus | null {
  return current;
}

/**
 * 忘掉这条结论。**给测试用的**：生产路径上没有"忘掉"这个动作 ——
 * 进程活着的时候它就是这台机器的状况，重新拉起运行时是**下一次启动**的事。
 */
export function resetRuntimeBootstrapStatus(): void {
  current = null;
}
