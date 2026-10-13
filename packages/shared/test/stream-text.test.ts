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

/**
 * ⭐ 跨工具边界后**当前段继续增长**（2026-10-13 独立复审反例 / BUG-075 P1）。
 *
 * 网关的思考通道送的是**累计快照**（按段从空重新累积）。修前实现对"跨段后的增长"
 * 完全不认：每个新快照与前文两个方向都不是前缀 ⇒ 每个快照都被当成**新一段**追加，
 * 于是 B → BC → BCD 变成 `A\n\nB\n\nBC\n\nBCD`，N 个快照的合并体积是**平方级**
 *（复审实测：2,000 快照 20,040 字符应得、实得 20,044,023；4,000 个合并超过 5 秒，
 * 同段对照仅 ~30ms）—— 现场输入 249 → 2 → 17 → … → 23,791 的长度直方图与它吻合。
 *
 * 契约（复审原话）：历史已完成段 + 当前段累计快照；**当前段增长只替换当前段**，
 * 不重复追加旧快照，也不覆盖历史段。
 */
test('⭐ 跨工具边界：当前段快照 B → BC → BCD 只替换当前段，得 A\\n\\nBCD', () => {
  let merged = mergeThinkingSegments('A', 'B');
  expect(merged).toBe('A\n\nB');
  merged = mergeThinkingSegments(merged, 'BC');
  expect(merged).toBe('A\n\nBC');
  merged = mergeThinkingSegments(merged, 'BCD');
  expect(merged).toBe('A\n\nBCD');
});

test('多段之后继续增长：历史段一个字符都不动', () => {
  let merged = mergeThinkingSegments('第一段', '第二段');
  merged = mergeThinkingSegments(merged, '第二段变长');
  merged = mergeThinkingSegments(merged, '第三段');
  expect(merged).toBe('第一段\n\n第二段变长\n\n第三段');
  merged = mergeThinkingSegments(merged, '第三段继续');
  expect(merged).toBe('第一段\n\n第二段变长\n\n第三段继续');
});

test('当前段的旧快照（重连/重订阅重投）不再重复追加', () => {
  let merged = mergeThinkingSegments('A', 'B');
  merged = mergeThinkingSegments(merged, 'BC');
  merged = mergeThinkingSegments(merged, 'BCD');
  merged = mergeThinkingSegments(merged, 'BCDE');
  expect(merged).toBe('A\n\nBCDE');

  // 重投最新快照 / 重投更早的快照：都已被结果盖住 ⇒ 保持不动
  expect(mergeThinkingSegments(merged, 'BCDE')).toBe('A\n\nBCDE');
  expect(mergeThinkingSegments(merged, 'BC')).toBe('A\n\nBCDE');
});

test('同段（工具调用之前）的增长语义不受影响', () => {
  let merged = mergeThinkingSegments('', '让我读一下');
  expect(merged).toBe('让我读一下');
  merged = mergeThinkingSegments(merged, '让我读一下这几个文件');
  expect(merged).toBe('让我读一下这几个文件');
});

test('⭐ 快照风暴线性收敛：N 次增长后的体积 = 历史 + 最新快照（不是平方级）', () => {
  const N = 500;
  let merged = mergeThinkingSegments('第一段完成', '第二段 ');
  for (let i = 1; i <= N; i++) {
    merged = mergeThinkingSegments(merged, '第二段 ' + 'x'.repeat(i * 10));
  }
  expect(merged).toBe('第一段完成\n\n第二段 ' + 'x'.repeat(N * 10));
});
