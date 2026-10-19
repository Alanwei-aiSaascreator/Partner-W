import { createHash } from 'node:crypto';

/**
 * rongying-thinking-segment-id-v1 —— BUG-075 / T26：源端在 thinking 发射点补上**段身份**
 * （runtime owner，2026-10-17）。
 *
 * ## 缺口（补丁前，冻结 runtime 2026.9.3 实读）
 *
 * 客户端侧（`packages/shared/src/constants.ts` 的 `ThinkingSegments.currentId/lastSealedId`、
 * `packages/core/.../gateway-dispatcher.ts` 的 `case 'thinking'`、`message-store.appendThinkingDelta`）
 * 已就位：只要源端在思考帧里给出稳定段标识，`mergeThinkingSnapshot(state, incoming, id)` 就
 * **逐 id 判段**，不再靠文本前缀/回声启发式猜。缺的是**发射侧**——运行时把身份丢了。
 *
 * 内核 `builtin-openclaw-*.mjs` 的 `emitReasoningStream`（本模块锚点所在函数）在把思考快照
 * 送到 agent 事件总线时，`data` 只有 `{ text, delta }`：
 *   `emitAgentEvent({ runId, stream: "thinking", data: { text: trimmed, delta } })`
 * —— 段身份**不随帧发出** ⇒ 客户端 `reasoning.itemId` 恒为 undefined ⇒ 回落到文本启发式。
 *
 * ## 身份是什么（为什么是 contentIndex，而不是 thinkingSignature）
 *
 * 内核内部**每个流事件都带 `contentIndex`**（`WorkerInferenceStreamEventSchema`：
 * `thinking_start/delta/end` 与 `text_start/delta/end` 同形带 `contentIndex`；见
 * `worker-inference-*.mjs` 的 union 与 `inference-stream.runtime-*.mjs` / `agent-core-*.mjs`
 * 的 `processProxyEvent`——`partial.content[event.contentIndex] = { type:"thinking", thinking:"" }`）。
 * 它是这一块的**位置身份**：同一段的累计快照共用同一个 `contentIndex`，工具边界之后模型重新
 * 起段会落到新的块（新 index）。发射点的调用方 `handleMessageUpdate` 手里正好有
 * `assistantRecord.contentIndex`（text 分支已用它做 `resolveAssistantStreamContentIndex`）。
 *
 * **刻意不用 `thinkingSignature`/`signature` 当身份**：在 openai-completions 路径上它退化成
 * **常量字段名**（`reasoning_content`，见 worker 内的 `provider===opencode-go` 归一与
 * `content.thinkingSignature = proxyEvent.contentSignature`），当身份用会把**所有段并成一段**
 * —— 比不打补丁更糟。文本流的 `itemId` 先例是 Responses API 的 item id（`textSignature`），
 * 思考侧**没有**对应产物，所以取 `contentIndex`。
 *
 * ## 补丁面（三个锚点，同一模块）
 *
 * ① `handleMessageUpdate` 的 thinking 分支调用点：把 `assistantRecord.contentIndex`（number）
 *    序列化为 `` `c${contentIndex}` `` 作为**第三个实参**传给 `emitReasoningStream`；不是 number
 *    ⇒ 传 `void 0`（该帧无身份，客户端逐字回落旧启发式）。
 * ② `emitReasoningStream` 形参表：`(input, fallback)` → `(input, fallback, segmentId)`。
 * ③ `emitReasoningStream` 的 `emitAgentEvent.data`：`segmentId` 是非空字符串时**追加**
 *    `itemId`（`...segmentId ? { itemId: segmentId } : {}`），其余键（`text`/`delta`）逐字不动。
 *
 * 另外两个调用点——message_end（`emitReasoningStream(rawThinking)`，字符串）与文本流的
 * `<thinking>` 标签回退（`emitReasoningStream(extractThinkingFromTaggedStream(...))`）——**不传**
 * segmentId ⇒ 逐字保持补丁前的帧形状（不产生 `itemId`，客户端回落旧路径）。这与"身份未知
 * 就不出声、fail-open 到既有行为"的纪律一致（对齐 inbox 系列补丁）。
 *
 * ## 语义与边界（客户端配套，逐字对应）
 *
 * - 同一段：每帧 `contentIndex` 相同 ⇒ `itemId` 相同 ⇒ 客户端判"同段累计快照"。
 * - 工具边界：客户端 `upsertToolCall`（新 tool id）会 `sealThinkingSegment` ⇒ `currentId` 清空；
 *   随后新段的 `itemId`（即便数值与刚封段相同）都 ≠ 空 ⇒ **新段**——这正是
 *   `new-prefix-after-tool` / `new-identical-after-tool` 两条未决反例的可判据。
 * - `contentIndex` 是**单次推理请求内**的位置（`streamProxy` 每次请求新建 `content = []`），
 *   跨请求会重置；本补丁因此**只保证"同一段内稳定、与相邻段可分"**（由客户端 seal 语义配合），
 *   **不保证跨请求全局唯一**。是否需要在真机帧上进一步收紧（叠加轮次/消息序号）取决于实跑证据
 *   ——见 T26 报告"未验证/阻塞"。
 *
 * ## 锚点与 hash（fail-closed）
 *
 * 锚点 = 冻结 runtime 2026.9.3 原始模块 sha256（构建产物 `runtime-out/win32-x64/
 * openclaw-runtime-2026.9.3.7z` 与该模块单独解出的字节一致；亦与各部署副本一致）：
 *   - builtin-openclaw-FlPOnMHc.mjs
 *     c50d1c73e337e647eeef966386f8c1da6007396823edbfc21510c30ec3d63559
 * 上游换版 ⇒ 构建期 hash 漂移直接失败（fail-closed），不静默改错文件。
 *
 * ## ⛔ 启用条件 / 回滚 —— 接线已撤除（2026-10-17 · 独立审核 ⚠️ 后）
 *
 * **当前状态：打包器（`scripts/pack-runtime.mjs`）对该补丁的接线已撤除，随包 runtime 未被改。**
 * 口径统一为「**打包器已撤除接线，未重打包**」——不要再写"未启用"，它会被误读成"代码是死的"。
 * 撤除理由：原接线**无条件、无开关**（无 flag / env 门）⇒ 任何人跑一次 `node scripts/pack-runtime.mjs`
 * 都会把本补丁**静默打进随包内核**，且**无独立决策点**。**补丁本身没问题，通路才是风险**：
 * 在拿到真机帧证据之前，不该存在"一跑就打进随包内核"的通路。
 *
 * **独立取证（2026-10-17 本机复核）**：从
 *   `runtime-out/win32-x64/openclaw-runtime-2026.9.3.7z` 解出
 *   `node_modules/openclaw/dist/builtin-openclaw-FlPOnMHc.mjs`
 *   - sha256 = `c50d1c73e337e647eeef966386f8c1da6007396823edbfc21510c30ec3d63559`
 *     —— 与本模块 `THINKING_SEGMENT_ID_SOURCE_SHA256` **逐字一致**（即补丁前原始字节）；
 *   - 三个**补丁后锚点**（call/sig/emit）在该模块中出现次数均为 **0**，`segmentId` 字面 **0** 次；
 *   - 随包 manifest 的 `patches[]` 不含 `rongying-thinking-segment-id-v1`。
 *   ⇒ **当前随包 runtime 确未被改**（未打入本补丁）。
 *
 * **使能门（缺一不可，全部满足前不得重新接线）**：
 *   ① 备好 `--native-tools` 校验包（当前**不存在** ⇒ `verifyNativeToolRuntime` 会先失败；见 BUG-129）；
 *   ② 确认**无第二路**在写 `runtime-out/`（否则重打包会破坏已核哈希的候选、或静默改型）；
 *   ③ **真网关跑一次带工具边界的推理，抓帧确认 `data.itemId` 出现且段边界处取值变化**
 *      （本补丁存在的唯一凭据；未拿到真机帧证据前不得接线）；
 *   ④ 复跑 T26 独立审核探针（`new-prefix-after-tool` / `new-identical-after-tool` 两条未决反例）。
 *
 * **回滚**：撤掉 `pack-runtime.mjs` 的三处接线（import / `writeFileSync` / manifest patch id）即可，
 * 重打包产出的是**不带该补丁**的归档。本模块与它的 `*.test.mjs` **原样保留**（提案与证据，非死代码）。
 */

export const THINKING_SEGMENT_ID_ENTRY = 'node_modules/openclaw/dist/builtin-openclaw-FlPOnMHc.mjs';
export const THINKING_SEGMENT_ID_SOURCE_SHA256 = 'c50d1c73e337e647eeef966386f8c1da6007396823edbfc21510c30ec3d63559';
export const THINKING_SEGMENT_ID_PATCH_ID = 'rongying-thinking-segment-id-v1';

/** 锚点①（原始 · thinking 分支调用点）：三制表符缩进，逐字节取自冻结模块 :10669。 */
export const THINKING_SEGMENT_ID_CALL_ANCHOR = `\t\tctx.emitReasoningStream(nativeThinking ?? (extractAssistantThinking(msg) || thinkingContent || thinkingDelta), nativeThinking ? thinkingContent || thinkingDelta : void 0);`;

/** 锚点①（补丁后）：把 `assistantRecord.contentIndex` 序列化为段身份并作为第三实参传入。 */
export const THINKING_SEGMENT_ID_CALL_ANCHOR_PATCHED = `\t\tctx.emitReasoningStream(nativeThinking ?? (extractAssistantThinking(msg) || thinkingContent || thinkingDelta), nativeThinking ? thinkingContent || thinkingDelta : void 0, typeof assistantRecord?.contentIndex === "number" ? \`c\${assistantRecord.contentIndex}\` : void 0);`;

/** 锚点②（原始 · 形参表）：冻结模块 :11846。 */
export const THINKING_SEGMENT_ID_SIG_ANCHOR = '\tconst emitReasoningStream = (input, fallback) => {';

/** 锚点②（补丁后）：增加 `segmentId` 形参。 */
export const THINKING_SEGMENT_ID_SIG_ANCHOR_PATCHED = '\tconst emitReasoningStream = (input, fallback, segmentId) => {';

/** 锚点③（原始 · 发射 data）：冻结模块 :11866-11869，五制表符内层缩进逐字节。 */
export const THINKING_SEGMENT_ID_EMIT_ANCHOR = '\t\t\tdata: {\n\t\t\t\ttext: trimmed,\n\t\t\t\tdelta\n\t\t\t}';

/** 锚点③（补丁后）：`segmentId` 非空时追加 `itemId`；`text`/`delta` 逐字不动。 */
export const THINKING_SEGMENT_ID_EMIT_ANCHOR_PATCHED =
  '\t\t\tdata: {\n\t\t\t\ttext: trimmed,\n\t\t\t\tdelta,\n\t\t\t\t...typeof segmentId === "string" && segmentId.length > 0 ? { itemId: segmentId } : {}\n\t\t\t}';

const ANCHORS = [
  [THINKING_SEGMENT_ID_CALL_ANCHOR, THINKING_SEGMENT_ID_CALL_ANCHOR_PATCHED],
  [THINKING_SEGMENT_ID_SIG_ANCHOR, THINKING_SEGMENT_ID_SIG_ANCHOR_PATCHED],
  [THINKING_SEGMENT_ID_EMIT_ANCHOR, THINKING_SEGMENT_ID_EMIT_ANCHOR_PATCHED],
];

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function assertAnchor(source, anchor, label) {
  if (source.split(anchor).length !== 2) throw new Error(`thinking segment id anchor drift: ${label}`);
}

/**
 * 给 `builtin-openclaw-*.mjs` 打 rongying-thinking-segment-id-v1。
 *
 * - 传入未打补丁的原文：先按 `expectedHash` 校验原文（fail-closed），再断言三个锚点各自唯一，最后替换；
 * - 传入已打补丁的文本（幂等）：逐字返回原样；
 * - hash 漂移（上游换版）或锚点缺失/重复：抛错，构建期失败，不产出静默错包。
 */
export function patchThinkingSegmentIdRuntime(source, expectedHash = THINKING_SEGMENT_ID_SOURCE_SHA256) {
  const alreadyPatched = source.includes(THINKING_SEGMENT_ID_EMIT_ANCHOR_PATCHED);
  const original = alreadyPatched
    ? ANCHORS.reduce((acc, [base, patched]) => acc.replace(patched, base), source)
    : source;
  if (sha256(original) !== expectedHash) throw new Error('thinking segment id source hash drift');
  assertAnchor(original, THINKING_SEGMENT_ID_CALL_ANCHOR, 'call');
  assertAnchor(original, THINKING_SEGMENT_ID_SIG_ANCHOR, 'signature');
  assertAnchor(original, THINKING_SEGMENT_ID_EMIT_ANCHOR, 'emit');
  if (alreadyPatched) return source;
  return ANCHORS.reduce((acc, [base, patched]) => acc.replace(base, patched), original);
}
