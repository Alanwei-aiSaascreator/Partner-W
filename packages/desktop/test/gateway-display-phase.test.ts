import { describe, expect, it } from 'vitest';
import {
  composerPlaceholderKey,
  deriveGatewayDisplayPhase,
  type GatewayDisplayPhase,
} from '../src/renderer/lib/gateway-display-phase';

/**
 * 网关这一格**该说哪句话**：分档是纯函数，界面只负责渲染。
 *
 * ## 为什么要有这一档（2026-09-20 实机现场 + 复核点名）
 *
 * 首次启动时本地网关要**分钟级**才起来，这期间客户端会先去连、连不上（或第一次
 * `connect` 15 秒超时）。老判据只看"有没有错误"，于是**预热期**被说成了终态：
 * 横幅「网关"X"已断开，正在尝试重连… (0/10)」+ 输入框「离线模式 — 只读」+
 * 准备面板「准备时间比平时更久」—— 三句话互相打架，用户以为坏了。
 *
 * ⭐ 真正能分开这两件事的不是"有没有错误"（预热期**确实**有真错误），
 * 而是「**这一次运行里，这个网关到底连上过没有**」：
 *   · 从没连上过 ⇒ 我们还在启动窗口里（话要说得像"正在启动"）；
 *   · 连上过又掉了 ⇒ 那才是"断开"（话要说得像"掉了、正在重连"）。
 * 所以判据的输入里**必须有** `everConnected`，它是主进程状态事件落下的账
 * （`setGatewayStatusByGateway` 见到 `connected` 就记一笔）。
 *
 * ⚠️ 唯一的例外是**网关明确拒绝**（`gaveUp`，例如 1008/pairing required）：
 * 那种"连不上"是结论而不是过程，哪怕从没连上过也要说失败并给出出口。
 */

/** 预热期那次连接错误：2026-09-20 截图上那句「(0/10)」就是它。 */
const WARMUP_FAILURE = { attempt: 0, max: 10, gaveUp: false };

function phase(
  status: 'connected' | 'connecting' | 'disconnected' | undefined,
  everConnected: boolean,
  reconnect?: { attempt: number; max: number; gaveUp: boolean },
): GatewayDisplayPhase {
  return deriveGatewayDisplayPhase({ status, everConnected, reconnect });
}

describe('网关显示分档（预热期 vs 真断开）', () => {
  it('连上了 ⇒ live', () => {
    expect(phase('connected', true)).toBe('live');
    expect(phase('connected', false)).toBe('live');
  });

  it('从没连上过、还在握手 ⇒ starting（不是"已断开"）', () => {
    expect(phase('connecting', false)).toBe('starting');
    expect(phase(undefined, false)).toBe('starting');
  });

  it('⭐ 从没连上过、但预热期已经失败过一次 ⇒ 仍是 starting（这是实机那句假话的来源）', () => {
    expect(phase('disconnected', false, WARMUP_FAILURE)).toBe('starting');
    expect(phase('disconnected', false)).toBe('starting');
  });

  it('⭐ 网关明确拒绝（gaveUp）⇒ unreachable：这是结论，不是预热', () => {
    expect(phase('disconnected', false, { attempt: 0, max: 10, gaveUp: true })).toBe('unreachable');
    expect(phase('connecting', false, { attempt: 3, max: 10, gaveUp: true })).toBe('unreachable');
  });

  it('连上过又掉了、还在重连 ⇒ retrying', () => {
    expect(phase('disconnected', true, { attempt: 2, max: 10, gaveUp: false })).toBe('retrying');
    expect(phase('connecting', true)).toBe('retrying');
    expect(phase(undefined, true)).toBe('retrying');
  });

  it('连上过又掉了、却没有任何重连信息 ⇒ disconnected（终态，界面要给"立即重试"）', () => {
    expect(phase('disconnected', true)).toBe('disconnected');
  });
});

describe('输入框那句提示（预热期不许说"离线模式 — 只读"）', () => {
  it('⭐ 还在启动：说"首次启动需要约 1 分钟"，不许说离线只读', () => {
    expect(composerPlaceholderKey({ phase: 'starting', isOffline: true, readinessBlocked: true })).toBe(
      'chatInput.aiServiceStartingDetail',
    );
  });

  it('已知断了 / 正在重连：这时"离线模式 — 只读"是真的', () => {
    expect(composerPlaceholderKey({ phase: 'disconnected', isOffline: true, readinessBlocked: false })).toBe(
      'chatInput.offlineReadOnly',
    );
    expect(composerPlaceholderKey({ phase: 'retrying', isOffline: true, readinessBlocked: true })).toBe(
      'chatInput.offlineReadOnly',
    );
    expect(composerPlaceholderKey({ phase: 'unreachable', isOffline: true, readinessBlocked: false })).toBe(
      'chatInput.offlineReadOnly',
    );
  });

  it('一切正常 ⇒ 普通的"描述任务"提示', () => {
    expect(composerPlaceholderKey({ phase: 'live', isOffline: false, readinessBlocked: false })).toBe(
      'chatInput.describeTask',
    );
  });
});
