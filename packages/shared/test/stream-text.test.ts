import { test, expect } from 'vitest';
import {
  mergeGatewayStreamText,
  mergeThinkingSnapshot,
  renderThinkingSegments,
  sealThinkingSegment,
  type ThinkingSegments,
} from '../src/constants';

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
 * 推理（thinking）分段的**显式状态**合并（2026-10-13 第二次独立复审整改）。
 *
 * 契约：`state = { completed: 已完成段, current: 当前段最新累计快照 }`。
 * - 段内：新快照以 `current` 为前缀 ⇒ 替换；`current` 以 incoming 为前缀 ⇒ 旧快照，原样；
 * - 新段：其余一律视为新段 —— **不猜历史**（与历史完全同文也允许）；
 * - 段边界由**真实事件语义**给出（工具调用落地 ⇒ `sealThinkingSegment`），不由字符串猜。
 *
 * 血案（复审反例）：拿纯字符串猜段身份必错 ——
 * ① 最长后缀匹配吞段（`…开始检查` + 新段 `检查结果正常` 被拼成 `…开始检查结果正常`）；
 * ② 全历史 includes 吞段（与历史同文的新段整段消失）；
 * ③ 两者都是平方级扫描（重复前缀输入 80k 直接超时）。
 */

const state = (completed: string, current: string, lastSealed = ''): ThinkingSegments => ({
  completed,
  current,
  lastSealed,
});

test('首次快照建立当前段；段内增长只替换当前段', () => {
  const s1 = mergeThinkingSnapshot(state('', ''), 'Let me read');
  expect(s1).toEqual(state('', 'Let me read'));
  const s2 = mergeThinkingSnapshot(s1, 'Let me read the key files');
  expect(s2).toEqual(state('', 'Let me read the key files'));
  expect(renderThinkingSegments(s2)).toBe('Let me read the key files');
});

test('空快照 / 相同快照原样不动（同引用返回）', () => {
  const s = state('第一段', '当前');
  expect(mergeThinkingSnapshot(s, '')).toBe(s);
  expect(mergeThinkingSnapshot(s, '当前')).toBe(s);
});

test('当前段旧快照（前缀）重投 ⇒ 同引用不动', () => {
  const s = state('H', 'ABCA');
  expect(mergeThinkingSnapshot(s, 'AB')).toBe(s);
});

test('⭐ 反例1：新段开头与上一段结尾同字 —— 一字不动地分两段（不许猜后缀）', () => {
  // 真实形状：seal 边界由工具调用落地给出（见 message-store）。
  const s = mergeThinkingSnapshot(sealThinkingSegment(state('', '开始检查')), '检查结果正常');
  expect(s).toEqual(state('开始检查', '检查结果正常', '开始检查'));
  expect(renderThinkingSegments(s)).toBe('开始检查\n\n检查结果正常');
});

test('⭐ 反例2：新段与历史完全同文也要整段显示（去重只认"刚归档段"这一份回声基线）', () => {
  const s = mergeThinkingSnapshot(sealThinkingSegment(state('', '先读取配置，再检查依赖。')), '读取配置');
  expect(s).toEqual(state('先读取配置，再检查依赖。', '读取配置', '先读取配置，再检查依赖。'));
  expect(renderThinkingSegments(s)).toBe('先读取配置，再检查依赖。\n\n读取配置');
});

test('⭐ 反例3：重投旧快照不许被当增长（修前 H → AB → ABCA → 重投 AB 得 ABCAB）', () => {
  let s = sealThinkingSegment(state('', 'H')); // 工具边界之后
  s = mergeThinkingSnapshot(s, 'AB');
  s = mergeThinkingSnapshot(s, 'ABCA');
  const before = s;
  expect(mergeThinkingSnapshot(s, 'AB')).toBe(before);
  expect(renderThinkingSegments(s)).toBe('H\n\nABCA');
});

test('⭐ 回声守卫：刚归档段被原样重投（F1 形状）⇒ 同引用忽略，不弹 activity、不重复显示', () => {
  const sealed = sealThinkingSegment(state('', '先看目录'));
  expect(mergeThinkingSnapshot(sealed, '先看目录')).toBe(sealed); // 整段回声
  expect(mergeThinkingSnapshot(sealed, '先看')).toBe(sealed); // 旧快照形状的回声（前缀）
  // 新段若以"刚归档段"为前缀之外的内容开头 ⇒ 正常开段
  const next = mergeThinkingSnapshot(sealed, '先看目录，再查配置');
  expect(next).toEqual(state('先看目录', '先看目录，再查配置', '先看目录'));
  expect(renderThinkingSegments(next)).toBe('先看目录\n\n先看目录，再查配置');
});

test('seal：归档当前段；seal 前后显示文本不变；空 current 是 no-op', () => {
  const s = state('', '第一段推理');
  const sealed = sealThinkingSegment(s);
  expect(sealed).toEqual(state('第一段推理', '', '第一段推理'));
  expect(renderThinkingSegments(sealed)).toBe(renderThinkingSegments(s));
  expect(sealThinkingSegment(sealed)).toBe(sealed);
});

test('多段：工具边界逐个归档，段间恰好一个空行', () => {
  let s = mergeThinkingSnapshot(state('', ''), 'A');
  s = sealThinkingSegment(s);
  s = mergeThinkingSnapshot(s, 'B');
  s = sealThinkingSegment(s);
  s = mergeThinkingSnapshot(s, 'C');
  s = mergeThinkingSnapshot(s, 'CD');
  expect(renderThinkingSegments(s)).toBe('A\n\nB\n\nCD');
});

test('短段 / 与历史同文（文本相同 ≠ 同一段）', () => {
  let s = state('好', ''); // 历史里已经有一个"好"
  s = mergeThinkingSnapshot(s, '好');
  expect(renderThinkingSegments(s)).toBe('好\n\n好');
});

test('正文含空行只是字符，不是段界', () => {
  let s = mergeThinkingSnapshot(state('', ''), 'A\n\nB');
  s = mergeThinkingSnapshot(s, 'A\n\nB\n\nC');
  expect(renderThinkingSegments(s)).toBe('A\n\nB\n\nC');
  s = sealThinkingSegment(s);
  s = mergeThinkingSnapshot(s, 'C\n\nD');
  expect(renderThinkingSegments(s)).toBe('A\n\nB\n\nC\n\nC\n\nD');
});

test('⭐ 重复前缀性能边界：80k 重复前缀不许平方级扫描（复审 ③）', () => {
  const N = 80_000;
  const heavy = 'a'.repeat(N);
  // ① 同段增长（真正延伸）⇒ 替换当前段，线性
  const grow = mergeThinkingSnapshot(state('', `${heavy}b`), `${heavy}bc`);
  expect(grow.current).toBe(`${heavy}bc`);
  // ② 异尾 ⇒ 新段（不猜、不扫、深比较一次通过）；旧段归档并成为回声基线
  const forked = mergeThinkingSnapshot(state('', `${heavy}b`), `${heavy}c`);
  expect(forked).toEqual(state(`${heavy}b`, `${heavy}c`, `${heavy}b`));
  expect(renderThinkingSegments(forked)).toBe(`${heavy}b\n\n${heavy}c`);
});
