import { test, expect } from 'vitest';
import { mergeGatewayStreamText, mergeThinkingSegments } from '../src/constants';

test('mergeGatewayStreamText upgrades a partial snapshot to the longer snapshot', () => {
  expect(
    mergeGatewayStreamText('[[main] Yes, online.', '[[main] Yes, online. Are you testing whether I am alive?'),
  ).toBe('[[main] Yes, online. Are you testing whether I am alive?');
});

test('mergeGatewayStreamText ignores identical snapshots', () => {
  expect(mergeGatewayStreamText('same reply', 'same reply')).toBe('same reply');
});

test('mergeGatewayStreamText appends genuine incremental chunks', () => {
  expect(mergeGatewayStreamText('hello', ' world')).toBe('hello world');
});

test('mergeGatewayStreamText ignores an older snapshot replayed after a newer one', () => {
  expect(mergeGatewayStreamText('newer reply', 'newer')).toBe('newer reply');
});

/**
 * 推理流的**分段**合并（2026-09-20）。
 *
 * ⚠️ 为什么推理不能直接用 `mergeGatewayStreamText`：推理是**按段**重发的 ——
 * 每段工具调用之后模型重新开始推理，网关从空快照重新累积。
 * 实机实测（2026-09-20，一个 worker 的 121 条 thinking 事件）里有 **7 次重置**：
 * `chars` 从 227 → 3、1409 → 3、860 → 3 …，共 8 段。
 *
 * 跨段时两个方向**都不是前缀**，`mergeGatewayStreamText` 会落到
 * `previous + incoming` 直接拼接 ⇒ 8 段推理糊成一团，
 * 界面上就是"同一句反复出现、越接越长"（用户截图看到的就是这个）。
 */
test('mergeThinkingSegments upgrades a partial snapshot within one segment', () => {
  expect(
    mergeThinkingSegments('Let me read the key files', 'Let me read the key files to understand the identity'),
  ).toBe('Let me read the key files to understand the identity');
});

test('mergeThinkingSegments ignores an older snapshot replayed after a newer one', () => {
  expect(mergeThinkingSegments('新的一段推理', '新的一段')).toBe('新的一段推理');
});

test('⭐ mergeThinkingSegments separates a NEW segment with a blank line (not glued together)', () => {
  // 这两句在真实日志里就是前后两段（中间隔着一次工具调用）
  const seg1 = 'Let me read the key files to understand the identity, soul, and dreams';
  const seg2 = 'Let me understand the context: this is a 爆款内容教练 agent';

  expect(mergeThinkingSegments(seg1, seg2)).toBe(`${seg1}\n\n${seg2}`);
  // 反过来的顺序（迟到的另一段）也必须是隔开，而不是粘上
  expect(mergeThinkingSegments(seg2, seg1)).toBe(`${seg2}\n\n${seg1}`);
});

test('mergeThinkingSegments ignores empty snapshots (进度心跳不带文本)', () => {
  expect(mergeThinkingSegments('已有推理', '')).toBe('已有推理');
});

test('mergeThinkingSegments is idempotent when re-fed its own result', () => {
  const merged = mergeThinkingSegments('第一段', '第二段');
  expect(mergeThinkingSegments(merged, '第二段')).toBe(merged);
});
