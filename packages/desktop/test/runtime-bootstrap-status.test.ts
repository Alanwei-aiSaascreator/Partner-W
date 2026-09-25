/**
 * 本地运行时起不来时，送往界面的那个值。
 *
 * 为什么单独一道关：`RuntimeBootstrapResult` 里有一条 `reason` —— 那是**给人看的**
 * 失败描述，会带路径、端口、有时还有 token 或别的东西。它进日志没问题，
 * **不能**进 IPC：渲染层会把它显示出来，进了截图、进了用户随手贴出来的报错。
 *
 * 所以这里把签名收窄成 `{ ok, code }`：拿不到那条文本，**结构上就带不出去**。
 * 而 `code` 也不原样转发 —— 它先过 `gatewayFailureReasonFrom` 的闭集。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { GATEWAY_FAILURE_REASONS } from '@clawwork/shared';
import {
  getRuntimeBootstrapStatus,
  publishRuntimeBootstrapStatus,
  resetRuntimeBootstrapStatus,
  toPublicBootstrapStatus,
} from '../src/main/runtime/bootstrap-status.js';

/** 真机上会出现在 `reason` 里的东西（路径 / 端口 / 凭据形状）。 */
const HOSTILE_REASON =
  '网关启动失败 token=sk-live-9f3a 手机号 13800138000 的验证码 123456 路径 C:\\Users\\张三\\AppData';

describe('toPublicBootstrapStatus', () => {
  it('18789 被别的程序占用 ⇒ port-occupied', () => {
    expect(toPublicBootstrapStatus({ ok: false, code: 'runtime.gateway-port-occupied' })).toEqual({
      ok: false,
      reason: 'port-occupied',
    });
  });

  it('我们自己的子进程早退 ⇒ process-exited', () => {
    expect(toPublicBootstrapStatus({ ok: false, code: 'runtime.gateway-process-exited' })).toEqual({
      ok: false,
      reason: 'process-exited',
    });
  });

  it('等就绪等满了超时 ⇒ ready-timeout', () => {
    expect(toPublicBootstrapStatus({ ok: false, code: 'runtime.gateway-ready-timeout' })).toEqual({
      ok: false,
      reason: 'ready-timeout',
    });
  });

  it('不认识的失败码 ⇒ unknown（宁可说不知道，也不猜成某一类）', () => {
    expect(toPublicBootstrapStatus({ ok: false, code: 'runtime.something-nobody-classified' })).toEqual({
      ok: false,
      reason: 'unknown',
    });
    expect(toPublicBootstrapStatus({ ok: false })).toEqual({ ok: false, reason: 'unknown' });
  });

  it('成功时不编一个失败原因出来', () => {
    expect(toPublicBootstrapStatus({ ok: true, code: 'runtime.gateway-port-occupied' })).toEqual({ ok: true });
  });

  it('⭐ 人看的那条 reason 文本带不出去：多给的字段一个都不进 payload', () => {
    // 用变量传（不是字面量）：这样"多给的字段"能真的进去，测的是运行时行为
    const result = { ok: false, code: 'runtime.gateway-port-occupied', reason: HOSTILE_REASON, elapsedMs: 1834 };
    const payload = toPublicBootstrapStatus(result);
    const serialized = JSON.stringify(payload);

    expect(serialized).not.toContain('sk-live');
    expect(serialized).not.toContain('13800138000');
    expect(serialized).not.toContain('123456');
    expect(serialized).not.toContain('张三');
    // 钉死形状：将来多一个字段，这条会先红 —— 让人当面想清楚它该不该过 IPC
    expect(Object.keys(payload).sort()).toEqual(['ok', 'reason']);
  });

  it('任何 code 都只落在那 5 个值里', () => {
    const codes = [
      'runtime.gateway-port-occupied',
      'runtime.gateway-process-exited',
      'runtime.gateway-ready-timeout',
      'runtime.gateway-auth-rejected',
      HOSTILE_REASON,
      '',
      'unknown',
    ];
    for (const code of codes) {
      const payload = toPublicBootstrapStatus({ ok: false, code });
      expect(payload.ok).toBe(false);
      if (!payload.ok) expect(GATEWAY_FAILURE_REASONS).toContain(payload.reason);
    }
  });
});

/**
 * 快照：这条结论往往在**窗口建好之前**就产生了，那一次推送没人收
 * （窗口不在时 `sendToWindow` 返回 false，事件直接丢掉）。所以渲染层挂上来之后
 * 必须**补读一次** —— 快照留在主进程里，拉得到（与 relay 公开状态同一个形状）。
 */
describe('runtime bootstrap 快照：推得到就推，推丢了还能拉', () => {
  beforeEach(() => {
    resetRuntimeBootstrapStatus();
  });

  it('还没跑过 ⇒ 拉不到（没结论 ≠ 没问题）', () => {
    expect(getRuntimeBootstrapStatus()).toBeNull();
  });

  it('记下结论之后拉得到，而且就是闭集里的那个值', () => {
    publishRuntimeBootstrapStatus({ ok: false, code: 'runtime.gateway-port-occupied' });

    expect(getRuntimeBootstrapStatus()).toEqual({ ok: false, reason: 'port-occupied' });
  });

  it('⭐ 拉出来的和推出去的**是同一份**：多给的字段哪条路都带不出去', () => {
    publishRuntimeBootstrapStatus({ ok: false, code: 'runtime.whatever', reason: HOSTILE_REASON } as never);

    expect(JSON.stringify(getRuntimeBootstrapStatus())).not.toContain('张三');
  });

  it('重置后回到"没有结论"（切号/退出时清）', () => {
    publishRuntimeBootstrapStatus({ ok: false, code: 'runtime.gateway-port-occupied' });
    resetRuntimeBootstrapStatus();

    expect(getRuntimeBootstrapStatus()).toBeNull();
  });
});
