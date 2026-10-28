import { test, expect } from 'vitest';
import { cronPayloadPreview } from '../src/renderer/layouts/CronPanel/payload.js';

/**
 * 背景（2026-09-11 实测）：点「定时任务」整个页面白屏，
 * 报 `Cannot read properties of undefined (reading 'length')`。
 *
 * 根因：网关会发**我们的类型里没有的** payload 种类。实测拿到的：
 *   "payload": { "kind": "heartbeat" }
 * 旧实现在非 systemEvent 时一律读 `.message` → undefined → `.length` 炸。
 *
 * 这类"上游加了枚举值、前端只认旧的"的 bug 会反复出现，
 * 所以这里把「不认识的种类也要安全」钉成断言。
 */

test('systemEvent 取 text', () => {
  expect(cronPayloadPreview({ kind: 'systemEvent', text: '每天的早报' })).toBe('每天的早报');
});

test('agentTurn 取 message', () => {
  expect(cronPayloadPreview({ kind: 'agentTurn', message: '总结昨天的会话' })).toBe('总结昨天的会话');
});

test('⛔ 不认识的 kind 不能抛 —— 这正是白屏的那一条', () => {
  // 真实的网关数据长这样；旧代码在这里 `undefined.length` 直接炸掉整个面板
  const heartbeat = { kind: 'heartbeat' } as never;
  expect(() => cronPayloadPreview(heartbeat)).not.toThrow();
  expect(cronPayloadPreview(heartbeat)).toBe('heartbeat');
});

test('payload 整个缺失也不能抛', () => {
  expect(() => cronPayloadPreview(undefined)).not.toThrow();
  expect(cronPayloadPreview(undefined)).toBe('');
});

test('字段缺失（有 kind 但没内容）返回空串而不是抛', () => {
  expect(cronPayloadPreview({ kind: 'systemEvent' } as never)).toBe('');
  expect(cronPayloadPreview({ kind: 'agentTurn' } as never)).toBe('');
});
