import { describe, expect, it } from 'vitest';
import { humanizeErrorKey, humanizeErrorKind } from '../src/renderer/lib/humanize-error.js';

/**
 * 原始英文错误 → 用户可读的一句话（2026-10-17 用户反馈：
 * 发送中断时弹英文，用户以为卡死）。
 */
describe('humanizeErrorKind', () => {
  it('网关没连上 / socket 关闭 ⇒ not-connected', () => {
    expect(humanizeErrorKind('WebSocket is closed')).toBe('not-connected');
    expect(humanizeErrorKind(new Error('not-connected'))).toBe('not-connected');
    expect(humanizeErrorKind('socket hang up')).toBe('not-connected');
  });

  it('超时 / 限流 / 上下文超限 / 额度不足各自归类', () => {
    expect(humanizeErrorKind('request timed out')).toBe('timeout');
    expect(humanizeErrorKind('429 Too Many Requests')).toBe('rate-limit');
    expect(humanizeErrorKind('maximum context length exceeded')).toBe('context-length');
    expect(humanizeErrorKind('insufficient credits')).toBe('insufficient-credits');
  });

  it('认不出 ⇒ send-failed（不编细节）', () => {
    expect(humanizeErrorKind('some weird internal failure')).toBe('send-failed');
    expect(humanizeErrorKind(undefined)).toBe('send-failed');
  });

  it('key 是字面量（i18n 扫描器可见）', () => {
    expect(humanizeErrorKey('request timed out')).toBe('errors.human.timeout');
    expect(humanizeErrorKey('whatever')).toBe('errors.human.send-failed');
  });
});
