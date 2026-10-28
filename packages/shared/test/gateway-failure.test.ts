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

  it('⭐ 从盘上准备运行环境失败 ⇒ deploy-failed（出口在**盘**上，与"网关起不来"分开）', () => {
    expect(gatewayFailureReasonFrom({ bootstrapCode: 'runtime.deploy-failed' })).toBe('deploy-failed');
  });

  it.each([
    ['runtime.node-missing', 'node-missing'],
    ['runtime.node-permission-denied', 'node-permission-denied'],
    ['runtime.node-probe-timeout', 'node-probe-timeout'],
    ['runtime.node-exec-failed', 'node-exec-failed'],
    ['runtime.node-version-unsupported', 'node-version-unsupported'],
  ] as const)('⭐ BUG-064：随盘 Node 失败码 %s ⇒ %s（各有各自界面话术）', (code, reason) => {
    expect(gatewayFailureReasonFrom({ bootstrapCode: code })).toBe(reason);
  });

  it('⭐ BUG-064：通用 no-usable-node（无候选等边缘兜底）刻意不映射 ⇒ unknown（不猜）', () => {
    expect(gatewayFailureReasonFrom({ bootstrapCode: 'runtime.no-usable-node' })).toBe('unknown');
  });

  it('认证被拒（关闭码 1008）⇒ auth-rejected', () => {
    expect(gatewayFailureReasonFrom({ closeCode: 1008 })).toBe('auth-rejected');
  });

  it('⭐ 别的关闭码一律不猜（1006 是"连接掉了"，不是"被拒绝"）', () => {
    expect(gatewayFailureReasonFrom({ closeCode: 1006 })).toBe('unknown');
    expect(gatewayFailureReasonFrom({ closeCode: 1000 })).toBe('unknown');
  });

  it('什么都不知道 ⇒ unknown（**不猜**）', () => {
    expect(gatewayFailureReasonFrom({})).toBe('unknown');
  });

  it('不认识的中转码也 ⇒ unknown（白名单，不是黑名单）', () => {
    expect(gatewayFailureReasonFrom({ bootstrapCode: 'runtime.something-new' })).toBe('unknown');
  });

  it('⭐ 原始文本永远进不了这个类型：任何输入都只落在闭集的值里', () => {
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
        gatewayFailureReasonFrom({ bootstrapCode: input, closeCode: 1006 }),
      ]) {
        expect(GATEWAY_FAILURE_REASONS).toContain(reason as GatewayFailureReason);
      }
    }
  });

  it('闭集本身只有这 12 个值（多一个都要先想清楚界面上说什么）', () => {
    expect([...GATEWAY_FAILURE_REASONS].sort()).toEqual(
      [
        'auth-rejected',
        'deploy-failed',
        'port-occupied',
        'process-exited',
        'ready-timeout',
        'state-migration-blocked',
        // BUG-064：随盘 Node 的五个分档（界面上各有一句话与各自出口）
        'node-missing',
        'node-permission-denied',
        'node-probe-timeout',
        'node-exec-failed',
        'node-version-unsupported',
        'unknown',
      ].sort(),
    );
  });

  it('判定优先级：中转码 > 关闭码（更具体的那条赢）', () => {
    // 两个信号同时在场时，"我们自己的网关没起来"比"连接被拒"更接近根因
    expect(gatewayFailureReasonFrom({ bootstrapCode: 'runtime.gateway-port-occupied', closeCode: 1008 })).toBe(
      'port-occupied',
    );
    expect(gatewayFailureReasonFrom({ bootstrapCode: 'runtime.something-new', closeCode: 1008 })).toBe('auth-rejected');
  });
});
