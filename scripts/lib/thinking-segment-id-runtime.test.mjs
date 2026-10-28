import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  THINKING_SEGMENT_ID_CALL_ANCHOR,
  THINKING_SEGMENT_ID_CALL_ANCHOR_PATCHED,
  THINKING_SEGMENT_ID_EMIT_ANCHOR,
  THINKING_SEGMENT_ID_EMIT_ANCHOR_PATCHED,
  THINKING_SEGMENT_ID_PATCH_ID,
  THINKING_SEGMENT_ID_SIG_ANCHOR,
  THINKING_SEGMENT_ID_SIG_ANCHOR_PATCHED,
  THINKING_SEGMENT_ID_SOURCE_SHA256,
  patchThinkingSegmentIdRuntime,
} from './thinking-segment-id-runtime.mjs';

const sha256Hex = (value) => createHash('sha256').update(value).digest('hex');

/**
 * 源码 fixture = 冻结运行时 `builtin-openclaw-FlPOnMHc.mjs` 里 thinking 发射链那段的
 * **逐字副本**（含制表符缩进）：
 *   - `handleMessageUpdate` 的 thinking 分支调用点（锚点①）；
 *   - `emitReasoningStream` 形参表（锚点②）与其 `emitAgentEvent.data`（锚点③）。
 * 外面套最小 wrapper（真 `emitAgentEvent` 换成推数组）让它可被求值、可被驱动。
 * 真正的防漂移靠：①本模块 sha256 锚点（构建期 fail-closed）；②下方 real-module 用例按字节校验。
 */
const pipelineFixture = [
  'const events = [];',
  'function emitAgentEvent(event) { events.push(event); }',
  'function extractAssistantThinking(message) { return message.__thinkingFallback ?? ""; }',
  'function createStreamRendering(state) {',
  '\tlet reasoningRaw;',
  '\tconst emitReasoningStream = (input, fallback) => {',
  '\t\tconst text = typeof input === "string" ? input : input.thinking;',
  '\t\tconst trimmed = text;',
  '\t\tif (!trimmed || trimmed === state.lastStreamedReasoning) return;',
  '\t\tconst delta = typeof fallback === "string" ? fallback : "";',
  '\t\tstate.lastStreamedReasoning = trimmed;',
  '\t\temitAgentEvent({',
  '\t\t\trunId: "run-1",',
  '\t\t\tstream: "thinking",',
  '\t\t\tdata: {',
  '\t\t\t\ttext: trimmed,',
  '\t\t\t\tdelta',
  '\t\t\t}',
  '\t\t});',
  '\t};',
  '\treturn { emitReasoningStream };',
  '}',
  'function handleMessageUpdate(ctx, evt) {',
  '\tconst msg = evt.message;',
  '\tconst assistantRecord = evt.assistantMessageEvent;',
  '\tconst evtType = typeof assistantRecord?.type === "string" ? assistantRecord.type : "";',
  '\tif (evtType === "thinking_start" || evtType === "thinking_delta" || evtType === "thinking_end") {',
  '\t\tconst thinkingDelta = typeof assistantRecord?.delta === "string" ? assistantRecord.delta : "";',
  '\t\tconst thinkingContent = typeof assistantRecord?.content === "string" ? assistantRecord.content : "";',
  '\t\tconst block = Array.isArray(msg.content) && msg.content.length === 1 ? msg.content[0] : void 0;',
  '\t\tconst nativeThinking = block?.type === "thinking" ? block : void 0;',
  '\t\tctx.emitReasoningStream(nativeThinking ?? (extractAssistantThinking(msg) || thinkingContent || thinkingDelta), nativeThinking ? thinkingContent || thinkingDelta : void 0);',
  '\t\treturn;',
  '\t}',
  '\tconst text = typeof assistantRecord?.content === "string" ? assistantRecord.content : "";',
  '\tif (text) ctx.emitReasoningStream(text);',
  '}',
  'return { events, createStreamRendering, handleMessageUpdate };',
].join('\n');

const build = (source) => new Function(source)();
const fixtureHash = (source) => sha256Hex(source);

const thinkingEvent = (contentIndex, text) => ({
  message: { content: [{ type: 'thinking', thinking: text }] },
  assistantMessageEvent: {
    type: 'thinking_delta',
    delta: text,
    content: text,
    ...(contentIndex === undefined ? {} : { contentIndex }),
  },
});

function driveThinking(pipeline, contentIndex, text) {
  const state = {};
  const ctx = pipeline.createStreamRendering(state);
  pipeline.handleMessageUpdate(ctx, thinkingEvent(contentIndex, text));
  return pipeline.events.at(-1);
}

test('RED baseline: fixture 里 thinking 帧 data 不含 itemId（源端身份被丢弃）', () => {
  const pipeline = build(pipelineFixture);
  const event = driveThinking(pipeline, 0, 'seg-a');
  assert.equal(event.stream, 'thinking');
  assert.deepEqual(Object.keys(event.data).sort(), ['delta', 'text'], '补丁前 data 只有 text/delta（RED 前提）');
  assert.equal(event.data.itemId, undefined);
});

test('补丁后：thinking 帧带上源端段身份 itemId = c<contentIndex>', () => {
  const pipeline = build(patchThinkingSegmentIdRuntime(pipelineFixture, fixtureHash(pipelineFixture)));
  assert.equal(driveThinking(pipeline, 0, 'seg-a').data.itemId, 'c0');
  assert.equal(driveThinking(pipeline, 3, 'seg-b').data.itemId, 'c3');
});

test('补丁后：同段累计快照共用同一 itemId（contentIndex 不变）', () => {
  const pipeline = build(patchThinkingSegmentIdRuntime(pipelineFixture, fixtureHash(pipelineFixture)));
  const state = {};
  const ctx = pipeline.createStreamRendering(state);
  pipeline.handleMessageUpdate(ctx, thinkingEvent(0, 'seg'));
  pipeline.handleMessageUpdate(ctx, thinkingEvent(0, 'seg-more'));
  const ids = pipeline.events.map((event) => event.data.itemId);
  assert.deepEqual(ids, ['c0', 'c0']);
});

test('补丁后：无 contentIndex 的思考帧不产生 itemId（fail-open 回落旧启发式）', () => {
  const pipeline = build(patchThinkingSegmentIdRuntime(pipelineFixture, fixtureHash(pipelineFixture)));
  const event = driveThinking(pipeline, undefined, 'seg-no-idx');
  assert.equal(Object.hasOwn(event.data, 'itemId'), false);
});

test('补丁后：非思考（文本）调用点与 message_end 字符串调用点不产生 itemId（帧形状逐字不变）', () => {
  const pipeline = build(patchThinkingSegmentIdRuntime(pipelineFixture, fixtureHash(pipelineFixture)));
  const state = {};
  const ctx = pipeline.createStreamRendering(state);
  // 文本路径（handleMessageUpdate 的非 thinking 分支 → emitReasoningStream(text)）
  pipeline.handleMessageUpdate(ctx, {
    message: {},
    assistantMessageEvent: { type: 'text_delta', content: 'plain text' },
  });
  assert.equal(pipeline.events.at(-1).data.itemId, undefined);
  // message_end / 标签回退形状：直接以字符串调用（无 segmentId）
  ctx.emitReasoningStream('raw-at-end');
  assert.equal(Object.hasOwn(pipeline.events.at(-1).data, 'itemId'), false);
});

test('补丁只增加 itemId：其余键集合与值逐字不变', () => {
  const before = build(pipelineFixture);
  const after = build(patchThinkingSegmentIdRuntime(pipelineFixture, fixtureHash(pipelineFixture)));
  const e0 = driveThinking(before, 0, 'seg-a');
  const e1 = driveThinking(after, 0, 'seg-a');
  const restOfData = Object.fromEntries(Object.entries(e1.data).filter(([key]) => key !== 'itemId'));
  assert.equal(e1.data.itemId, 'c0');
  assert.deepEqual(restOfData, e0.data, '除 itemId 外 data 必须与补丁前一致');
  assert.deepEqual(Object.keys(e1).sort(), Object.keys(e0).sort());
});

test('patch mechanics: idempotent, hash-pinned, three anchors fail-closed', () => {
  const patched = patchThinkingSegmentIdRuntime(pipelineFixture, fixtureHash(pipelineFixture));
  // 幂等：再打一遍返回逐字同一份
  assert.equal(patchThinkingSegmentIdRuntime(patched, fixtureHash(pipelineFixture)), patched);
  // 源 hash 漂移 ⇒ 拒绝
  assert.throws(
    () => patchThinkingSegmentIdRuntime(`${pipelineFixture}\n// drift`, fixtureHash(pipelineFixture)),
    /hash drift/,
  );
  // 每个锚点缺失 ⇒ 拒绝（构建期失败，绝不静默跳过）
  const breakers = [THINKING_SEGMENT_ID_CALL_ANCHOR, THINKING_SEGMENT_ID_SIG_ANCHOR, THINKING_SEGMENT_ID_EMIT_ANCHOR];
  for (const anchor of breakers) {
    const broken = pipelineFixture.replace(anchor, '/* anchor removed */');
    assert.notEqual(broken, pipelineFixture);
    assert.throws(
      () => patchThinkingSegmentIdRuntime(broken, fixtureHash(broken)),
      /anchor drift/,
      `锚点缺失必须 fail-closed: ${JSON.stringify(anchor.slice(0, 24))}`,
    );
  }
  // 锚点重复（出现两次）⇒ 拒绝，绝不猜打哪一处
  const duplicated = pipelineFixture.replace(
    '\tlet reasoningRaw;',
    `\tlet reasoningRaw;\n${THINKING_SEGMENT_ID_EMIT_ANCHOR}`,
  );
  assert.equal(duplicated.split(THINKING_SEGMENT_ID_EMIT_ANCHOR).length, 3, '构造夹具：emit 锚点必须出现两次');
  assert.throws(() => patchThinkingSegmentIdRuntime(duplicated, fixtureHash(duplicated)), /anchor drift/);
});

test('patch id 与入口常量形状固定（pack-runtime 接线与 manifest 标记靠它们）', () => {
  assert.equal(THINKING_SEGMENT_ID_PATCH_ID, 'partner-w-thinking-segment-id-v1');
  assert.match(THINKING_SEGMENT_ID_SOURCE_SHA256, /^[0-9a-f]{64}$/);
  assert.equal(THINKING_SEGMENT_ID_SIG_ANCHOR_PATCHED.includes(THINKING_SEGMENT_ID_SIG_ANCHOR), false);
  assert.equal(THINKING_SEGMENT_ID_EMIT_ANCHOR_PATCHED.includes(THINKING_SEGMENT_ID_EMIT_ANCHOR), false);
  assert.equal(THINKING_SEGMENT_ID_CALL_ANCHOR_PATCHED.includes(THINKING_SEGMENT_ID_CALL_ANCHOR), false);
});

/**
 * 真实冻结模块校验（可选加固）：给出解开归档后的 dist 目录即可按字节核对 + 实打一遍补丁。
 * 未打 / 已打补丁的模块都接受（已打时按反向映射还原原始字节再比 pin；指到别的版本仍 fail-closed）。
 * 没有该环境时**显式跳过并说明**（不假装通过）。
 *   RY_THINKING_SEGMENT_ID_MODULE_DIR=<...>/node_modules/openclaw/dist
 */
test('real module: 冻结模块字节与锚点 hash 一致，补丁可实打且幂等（需 RY_THINKING_SEGMENT_ID_MODULE_DIR）', (t) => {
  const distDir = process.env.RY_THINKING_SEGMENT_ID_MODULE_DIR;
  if (!distDir) {
    t.skip('RY_THINKING_SEGMENT_ID_MODULE_DIR 未设置：跳过冻结模块字节校验');
    return;
  }
  const modulePath = path.join(distDir, 'builtin-openclaw-FlPOnMHc.mjs');
  const source = fs.readFileSync(modulePath, 'utf-8');
  const alreadyPatched = source.includes(THINKING_SEGMENT_ID_EMIT_ANCHOR_PATCHED);
  assert.equal(
    sha256Hex(stripPatched(source)),
    THINKING_SEGMENT_ID_SOURCE_SHA256,
    '冻结模块字节与锚点 hash 不一致（fail-closed）',
  );
  const patched = patchThinkingSegmentIdRuntime(source);
  assert.equal(patched.split(THINKING_SEGMENT_ID_CALL_ANCHOR_PATCHED).length, 2);
  assert.equal(patched.split(THINKING_SEGMENT_ID_SIG_ANCHOR_PATCHED).length, 2);
  assert.equal(patched.split(THINKING_SEGMENT_ID_EMIT_ANCHOR_PATCHED).length, 2);
  assert.equal(patchThinkingSegmentIdRuntime(patched), patched, '幂等');
  if (alreadyPatched) assert.equal(patched, source, '已打补丁的冻结模块必须原样返回');
});

function stripPatched(source) {
  const alreadyPatched = source.includes(THINKING_SEGMENT_ID_EMIT_ANCHOR_PATCHED);
  if (!alreadyPatched) return source;
  return source
    .replace(THINKING_SEGMENT_ID_CALL_ANCHOR_PATCHED, THINKING_SEGMENT_ID_CALL_ANCHOR)
    .replace(THINKING_SEGMENT_ID_SIG_ANCHOR_PATCHED, THINKING_SEGMENT_ID_SIG_ANCHOR)
    .replace(THINKING_SEGMENT_ID_EMIT_ANCHOR_PATCHED, THINKING_SEGMENT_ID_EMIT_ANCHOR);
}
