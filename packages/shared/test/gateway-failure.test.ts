import { describe, expect, it } from 'vitest';
import {
  GATEWAY_FAILURE_REASONS,
  gatewayFailureReasonFrom,
  type GatewayFailureReason,
} from '../src/gateway-failure.js';

/**
 * 「网关为什么没起来」的**公开**原因。
 *
 * 判据是**闭集**：界面上要说的每一句话都对应这里的一个值，
 * 而**原始错误、Token、地址、堆栈一律不进这个类型** —— 它要过 IPC、进日志、上界面。
 */
describe('gatewayFailureReasonFrom', () => {
  it('端口被别的网关占用 ⇒ port-occupied', () => {
    expect(gatewayFailureReasonFrom({ bootstrapCode: 'runtime.gateway-port-occupied' })).toBe('port-occupied');
  });

  it('子进程早退 ⇒ process-exited', () => {
    expect(gatewayFailureReasonFrom({ bootstrapCode: 'runtime.gateway-process-exited' })).toBe('process-exited');
  });

  it('等满就绪超时 ⇒ ready-timeout', () => {
    expect(gatewayFailureReasonFrom({ bootstrapCode: 'runtime.gateway-ready-timeout' })).toBe('ready-timeout');
  });

  it('认证被拒（WS 错误码）⇒ auth-rejected', () => {
    expect(gatewayFailureReasonFrom({ wsErrorCode: 'AUTH_TOKEN_MISMATCH' })).toBe('auth-rejected');
  });

  it('认证被拒（关闭码 1008）⇒ auth-rejected', () => {
    expect(gatewayFailureReasonFrom({ closeCode: 1008 })).toBe('auth-rejected');
  });

  it('什么都不知道 ⇒ unknown（**不猜**）', () => {
    expect(gatewayFailureReasonFrom({})).toBe('unknown');
  });

  it('不认识的中转码也 ⇒ unknown（白名单，不是黑名单）', () => {
    expect(gatewayFailureReasonFrom({ bootstrapCode: 'runtime.something-new' })).toBe('unknown');
  });

  it('⭐ 原始文本永远进不了这个类型：任何输入都只落在那 5 个值里', () => {
    const hostile = [
      'token=sk-live-abcdefg',
      'ws://127.0.0.1:18789?token=secret',
      'Error: connect ECONNREFUSED 127.0.0.1:18789\n  at Object.<anonymous> (/app/x.js:1:1)',
      '手机号 13800138000 的验证码 123456',
      '',
    ];

    for (const input of hostile) {
      for (const reason of [
        gatewayFailureReasonFrom({ bootstrapCode: input }),
        gatewayFailureReasonFrom({ wsErrorCode: input }),
        gatewayFailureReasonFrom({ bootstrapCode: input, wsErrorCode: input, closeCode: 1006 }),
      ]) {
        expect(GATEWAY_FAILURE_REASONS).toContain(reason as GatewayFailureReason);
      }
    }
  });

  it('闭集本身只有 5 个值（多一个都要先想清楚界面上说什么）', () => {
    expect([...GATEWAY_FAILURE_REASONS].sort()).toEqual(
      ['auth-rejected', 'port-occupied', 'process-exited', 'ready-timeout', 'unknown'].sort(),
    );
  });

  it('判定优先级：中转码 > WS 码 > 关闭码（更具体的那条赢）', () => {
    expect(
      gatewayFailureReasonFrom({ bootstrapCode: 'runtime.gateway-port-occupied', wsErrorCode: 'AUTH_TOKEN_MISMATCH' }),
    ).toBe('port-occupied');
    expect(gatewayFailureReasonFrom({ wsErrorCode: 'AUTH_TOKEN_MISMATCH', closeCode: 1008 })).toBe('auth-rejected');
  });
});
